#!/usr/bin/env bash
# L3 rehearsal launcher (owner-approved option a, 2026-10-20): the UNCHANGED g1-student-deploy
# rehearse.py chain (robot_sim.py + C++ SONIC runner/TensorRT + node.py) inside an unprivileged
# user+net+pid+mount namespace whose only interface is a private loopback. DDS uses domain 0 there
# (hard-coded in the runner), which cannot reach any robot: no route, no NIC, fail-closed on --iface.
# See docs/REALTIME_REHEARSAL.md. Never pass a Flow panel task (possible sealed set).
#
# usage: l3_launch.sh <task.json> <run-id>
#   env: BOOT_TIMEOUT (default 180 s; the fused engine is cached, so no build)
#        L3_BASE      (default ~/research-data/g1-deploy-studio/l3)
#        DRY_RUN=1    run everything except rehearse.py
set -euo pipefail
TASK=$(readlink -f "${1:?task.json}"); RUN_ID=${2:?run-id}
DRY_RUN=${DRY_RUN:-0}
DEPLOY=/home/linjiw/code/g1-student-deploy
LUCID=/home/linjiw/lucid-sonic/lucid-g1-deploy
STUDIO=/home/linjiw/code/g1-deploy-studio
BASE=${L3_BASE:-$HOME/research-data/g1-deploy-studio/l3}
RUN=$BASE/$RUN_ID
BOOT=${BOOT_TIMEOUT:-180}
GPU_LOG=/home/linjiw/IsaacLab/teachgym/runs/_v1_archive/e1b/gpu_util_log.csv  # pre-upgrade nvidia-smi logger (not ours; may stop)

case "$TASK" in */flow/artifacts/panels/*) echo "REFUSE: Flow panel task (possible sealed test set)"; exit 64;; esac
case "$RUN_ID" in */*|.*|"") echo "REFUSE: bad run id"; exit 64;; esac
mkdir -p "$BASE"
mkdir "$RUN"                                   # exclusive: an existing run id is refused
DEADLINE=$(python3 -B -c 'import json,math,sys;print(math.ceil(float(json.load(open(sys.argv[1]))["deadline_s"])))' "$TASK")
# rehearse.py's own waits: sim 60 + runner Init Done BOOT + CONTROL 30 + node_up 120 + first plan 60
# + deadline + 3 x 5 s stop + scoring. 60 s margin on top.
WALL=$(( 60 + BOOT + 30 + 120 + 60 + DEADLINE + 60 ))
REC_S=$(( WALL - 15 ))

exec 9>"$BASE/.gpu-rehearsal.lock"             # one bounded rehearsal on the shared GPU at a time
flock -n 9 || { echo "REFUSE: another L3 rehearsal holds $BASE/.gpu-rehearsal.lock"; exit 75; }

cp "$TASK" "$RUN/task.json"
touch "$RUN/t0"
# The SDK participants overwrite the shared CycloneDDS trace /tmp/cdds.LOG; keep and restore it.
[ -f /tmp/cdds.LOG ] && cp -p /tmp/cdds.LOG "$RUN/cdds.LOG.before"
{ for r in "$DEPLOY" "$LUCID"; do echo "== $r $(git -C "$r" rev-parse HEAD)"; git -C "$r" status --porcelain; done; } > "$RUN/pre_git.txt"
sha256sum "$DEPLOY/bundle/sonic/policy_sonic_release_g1.trt" "$DEPLOY/bundle/sonic/sonic_release_g1.onnx" \
  "$LUCID/runner/target/release/g1_deploy_onnx_ref" > "$RUN/pre_sha.txt"
tail -n 8 "$GPU_LOG" > "$RUN/gpu_util_pre.csv" 2>/dev/null || echo "unknown" > "$RUN/gpu_util_pre.csv"
printf '{"dds_domain":0,"isolation":"user+net+pid+mount namespace, lo only","wall_s":%s,"boot_timeout_s":%s,"dry_run":%s}\n' \
  "$WALL" "$BOOT" "$DRY_RUN" > "$RUN/l3_provenance.json"

# Host-side sampler: the chain's tcp://* binds must never appear in the host namespace.
( while true; do ss -Hlntu 2>/dev/null | grep -E ':(5556|5557|5560|5561|5562)\b' | sed "s/^/$(date +%s) /"; sleep 2; done ) \
  > "$RUN/host_ports_seen.txt" 2>/dev/null &
SAMPLER=$!

INNER='
set -uo pipefail
set -m   # job control: the background collector keeps a default SIGINT (non-interactive bash would ignore it)
ip link set lo up
links=$(ip -brief link | awk "{print \$1}" | paste -sd, -)
[ "$links" = "lo" ] || { echo "REFUSE: interfaces inside namespace: $links"; exit 97; }
for a in 192.168.123.161 192.168.123.164 192.168.1.1 8.8.8.8; do
  ip -4 route get "$a" >/dev/null 2>&1 && { echo "REFUSE: route to $a"; exit 97; }
done
{ echo "netns $(readlink /proc/self/ns/net) pidns $(readlink /proc/self/ns/pid) userns $(readlink /proc/self/ns/user)"
  ip -o addr; echo "routes:"; ip route; } > "$RUN/netns.txt"
python3 -B -c "
import ctypes; l=ctypes.CDLL(\"libcuda.so.1\"); n=ctypes.c_int(-1)
print(\"cuInit\", l.cuInit(0)); print(\"cuDeviceGetCount\", l.cuDeviceGetCount(ctypes.byref(n)), n.value)" > "$RUN/cuda_init.txt" 2>&1
cd "$STUDIO"
.venv/bin/python -m studio.recorder --endpoint tcp://127.0.0.1:5557 --endpoint tcp://127.0.0.1:5556 \
  --topic g1_debug --topic robot_config --topic pose --duration "$REC_S" \
  --output "$RUN/capture.jsonl" > "$RUN/recorder.json" 2> "$RUN/recorder.err" &
REC=$!
cd "$DEPLOY"
if [ "$DRY_RUN" = 1 ]; then
  echo "DRY_RUN: .venv/bin/python -B sim/realtime/rehearse.py --task $RUN/task.json --out $RUN/rehearse --boot-timeout $BOOT"
  sleep 3; rc=0
else
  .venv/bin/python -B sim/realtime/rehearse.py --task "$RUN/task.json" --out "$RUN/rehearse" \
    --boot-timeout "$BOOT" > "$RUN/rehearse.out" 2>&1
  rc=$?
fi
kill -INT "$REC" 2>/dev/null
for i in $(seq 100); do kill -0 "$REC" 2>/dev/null || break; sleep 0.1; done
echo "rehearse_rc=$rc"
exit $rc
'
# util-linux 2.37 `unshare --fork` leaves SIGINT/SIGTERM ignored in the forked child; every process in the
# namespace would inherit that (the runner has no handler and would then survive rehearse.py's SIGINT until its
# 5 s SIGKILL fallback). `env --default-signal` restores the host defaults before bash starts.
set +e
timeout -s TERM -k 30 "$WALL" \
  unshare --user --map-root-user --net --pid --fork --kill-child --mount-proc \
  env --default-signal=INT,TERM,QUIT,PIPE -u CYCLONEDDS_URI PYTHONDONTWRITEBYTECODE=1 TORCHINDUCTOR_CACHE_DIR=/tmp/torchinductor_linjiw \
      RUN="$RUN" DEPLOY="$DEPLOY" STUDIO="$STUDIO" BOOT="$BOOT" REC_S="$REC_S" DRY_RUN="$DRY_RUN" \
  bash -c "$INNER" > "$RUN/launcher.log" 2>&1
RC=$?
set -e
kill "$SAMPLER" 2>/dev/null || true
sleep 1
if [ -f /tmp/cdds.LOG ]; then cp /tmp/cdds.LOG "$RUN/cdds.LOG.run"; fi
if [ -f "$RUN/cdds.LOG.before" ]; then cp -p "$RUN/cdds.LOG.before" /tmp/cdds.LOG; fi

# Post-run checks (outside the namespace)
ps -eo pid,etimes,args | awk '/g1_deploy_onnx_ref|sim\/realtime\/robot_sim\.py|g1deploy\/node\.py|sim\/realtime\/rehearse\.py|studio\.recorder/ && !/awk/' \
  > "$RUN/survivors.txt"
{ for r in "$DEPLOY" "$LUCID"; do echo "== $r $(git -C "$r" rev-parse HEAD)"; git -C "$r" status --porcelain; done; } > "$RUN/post_git.txt"
sha256sum "$DEPLOY/bundle/sonic/policy_sonic_release_g1.trt" "$DEPLOY/bundle/sonic/sonic_release_g1.onnx" \
  "$LUCID/runner/target/release/g1_deploy_onnx_ref" > "$RUN/post_sha.txt"
find "$DEPLOY" "$LUCID" -newer "$RUN/t0" -type f 2>/dev/null | head -500 > "$RUN/written_in_reference_repos.txt"
tail -n 40 "$GPU_LOG" > "$RUN/gpu_util_post.csv" 2>/dev/null || echo "unknown" > "$RUN/gpu_util_post.csv"
echo "rc=$RC run=$RUN"
echo "survivors: $(wc -l < "$RUN/survivors.txt")  host_port_binds_seen: $(wc -l < "$RUN/host_ports_seen.txt")"
echo "git changed: $(diff -q "$RUN/pre_git.txt" "$RUN/post_git.txt" >/dev/null && echo no || echo YES)  sha changed: $(diff -q "$RUN/pre_sha.txt" "$RUN/post_sha.txt" >/dev/null && echo no || echo YES)"
echo "files written in reference repos: $(wc -l < "$RUN/written_in_reference_repos.txt")"
echo "collector closed cleanly: $(grep -c capture_end "$RUN/capture.jsonl" 2>/dev/null)"
exit $RC
