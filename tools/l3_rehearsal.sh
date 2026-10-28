#!/usr/bin/env bash
# L3 rehearsal launcher (owner-approved option a, 2026-10-20): the UNCHANGED g1-student-deploy
# rehearse.py chain (robot_sim.py + C++ SONIC runner/TensorRT + node.py) inside an unprivileged
# user+net+pid+mount namespace whose only interface is a private loopback. DDS uses domain 0 there
# (hard-coded in the runner), which cannot reach any robot: no route, no NIC, fail-closed on --iface.
# See docs/REALTIME_REHEARSAL.md. Only Studio-authored tasks are accepted (never a Flow panel task).
#
# usage: tools/l3_rehearsal.sh <studio task.json> <run-id>
#   env: BOOT_TIMEOUT (default 180 s; the fused engine is cached, so no build)
#        L3_BASE      (default ~/research-data/g1-deploy-studio/l3)
#        DRY_RUN=1    run everything except rehearse.py
set -euo pipefail
TASK=$(readlink -f "${1:?task.json}"); RUN_ID=${2:?run-id}
DRY_RUN=${DRY_RUN:-0}
STUDIO=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
# Roots follow studio/paths.py ($G1_STUDENT_DEPLOY / $LUCID_DEPLOY_ROOT / $STUDIO_DATA, config/local.json, defaults).
root() { (cd "$STUDIO" && PYTHONPATH="$STUDIO" python3 -B -m studio.paths "$1"); }
DEPLOY=$(root deploy_root); LUCID=$(root lucid_root)
BASE=${L3_BASE:-$(root data_root)/l3}
RUN=$BASE/$RUN_ID
BOOT=${BOOT_TIMEOUT:-180}
GPU_LOG=${GPU_LOG:-$HOME/IsaacLab/teachgym/runs/_v1_archive/e1b/gpu_util_log.csv}  # another experiment's nvidia-smi logger (not ours; may be absent: "unknown")
GIT=(git --no-optional-locks)  # status must never refresh .git/index in the reference repositories

# ---- refuse before anything is created
case "$RUN_ID" in */*|.*|"") echo "REFUSE: bad run id"; exit 64;; esac
case "$TASK" in */flow/*|*panels*|*sealed*) echo "REFUSE: not a Studio-authored task (possible sealed test set)"; exit 64;; esac
# Allow-list: Studio's workers write family "studio-user-configured" into every run/task.json.
DEADLINE=$(python3 -B - "$TASK" <<'PY'
import json, math, sys
task = json.load(open(sys.argv[1]))
if task.get('family') != 'studio-user-configured':
    sys.exit('REFUSE: task.json is not Studio-authored (family != studio-user-configured)')
print(math.ceil(float(task['deadline_s'])))
PY
) || exit 64
# rehearse.py's own waits: sim 60 + runner Init Done BOOT + CONTROL 30 + node_up 120 + first plan 60
# + deadline + 3 x 5 s stop + scoring. 60 s margin on top. The inner timeout stops rehearse.py with
# SIGINT first (orderly shutdown); the outer one is only a backstop.
WALL=$(( 60 + BOOT + 30 + 120 + 60 + DEADLINE + 60 ))
INNER_WALL=$(( WALL - 30 ))
REC_S=$(( WALL - 15 ))
if (( REC_S > 3600 )); then   # studio.recorder caps a capture at 3600 s
  echo "WARNING: wall limit ${WALL} s exceeds the recorder cap; the wire capture stops after 3600 s" >&2; REC_S=3600
fi

mkdir -p "$BASE"
exec 9>"$BASE/.gpu-rehearsal.lock"             # one bounded rehearsal on the shared GPU at a time
flock -n 9 || { echo "REFUSE: another L3 rehearsal holds $BASE/.gpu-rehearsal.lock"; exit 75; }
mkdir "$RUN"                                   # exclusive: an existing run id is refused

SAMPLER=
cleanup() {
  [ -n "$SAMPLER" ] && kill "$SAMPLER" 2>/dev/null || true
  if [ -f "$RUN/cdds.LOG.before" ] && [ ! -f "$RUN/.cdds-restored" ]; then
    [ -f /tmp/cdds.LOG ] && cp /tmp/cdds.LOG "$RUN/cdds.LOG.run" || true
    cp -p "$RUN/cdds.LOG.before" /tmp/cdds.LOG && touch "$RUN/.cdds-restored" || true
  fi
}
trap cleanup EXIT

cp "$TASK" "$RUN/task.json"
# The SDK participants overwrite the shared CycloneDDS trace /tmp/cdds.LOG; keep and restore it.
if [ -f /tmp/cdds.LOG ]; then cp -p /tmp/cdds.LOG "$RUN/cdds.LOG.before"; fi
{ for r in "$DEPLOY" "$LUCID"; do echo "== $r $("${GIT[@]}" -C "$r" rev-parse HEAD)"; "${GIT[@]}" -C "$r" status --porcelain; done; } > "$RUN/pre_git.txt"
sha256sum "$DEPLOY/bundle/sonic/policy_sonic_release_g1.trt" "$DEPLOY/bundle/sonic/sonic_release_g1.onnx" \
  "$LUCID/runner/target/release/g1_deploy_onnx_ref" > "$RUN/pre_sha.txt"
tail -n 8 "$GPU_LOG" > "$RUN/gpu_util_pre.csv" 2>/dev/null || echo "unknown" > "$RUN/gpu_util_pre.csv"
python3 -B - "$RUN/l3_provenance.json" "$WALL" "$BOOT" "$DRY_RUN" "$("${GIT[@]}" -C "$STUDIO" rev-parse HEAD)" <<'PY'
import json, sys
out, wall, boot, dry, commit = sys.argv[1:]
json.dump({'dds_domain': 0, 'isolation': 'user+net+pid+mount namespace, lo only',
           'agents_md_deviation': 'DDS domain 0 inside an isolated loopback-only namespace instead of a simulator-specific '
                                  'domain (owner-approved 2026-10-20; the runner hard-codes domain 0).',
           'studio_commit': commit, 'wall_s': int(wall), 'boot_timeout_s': int(boot), 'dry_run': dry == '1',
           'actuator_limits': {'hip_pitch_nm': 88, 'hip_roll_nm': 88, 'hip_yaw_nm': 88,
                               'source': 'lucid sim/wbc_configs/g1_29dof_sonic_model12.yaml:241 motor_effort_limit_list, '
                                         'applied by gear_sonic_sim base_sim.py np.clip; compare with the L1/L2 `source` profile'}},
          open(out, 'w'), indent=1)
PY
touch "$RUN/t0"

# Host-side sampler: the chain's tcp://* binds must never appear in the host namespace. It closes the
# lock descriptor so an orphaned sampler can never hold the GPU lock.
( exec 9>&-; while true; do ss -Hlntu 2>/dev/null | grep -E ':(5556|5557|5560|5561|5562)\b' | sed "s/^/$(date +%s) /"; sleep 2; done ) \
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
  timeout -s INT -k 10 "$INNER_WALL" .venv/bin/python -B sim/realtime/rehearse.py --task "$RUN/task.json" \
    --out "$RUN/rehearse" --boot-timeout "$BOOT" > "$RUN/rehearse.out" 2>&1
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
  env --default-signal=INT,TERM,QUIT,PIPE -u CYCLONEDDS_URI PYTHONDONTWRITEBYTECODE=1 TORCHINDUCTOR_CACHE_DIR=/tmp/torchinductor_$(id -un) \
      RUN="$RUN" DEPLOY="$DEPLOY" STUDIO="$STUDIO" BOOT="$BOOT" REC_S="$REC_S" INNER_WALL="$INNER_WALL" DRY_RUN="$DRY_RUN" \
  bash -c "$INNER" > "$RUN/launcher.log" 2>&1
RC=$?
set -e
cleanup
sleep 1

# Post-run checks (outside the namespace). None of them may abort the summary.
set +o pipefail
ps -eo pid,etimes,args | awk '/g1_deploy_onnx_ref|sim\/realtime\/robot_sim\.py|g1deploy\/node\.py|sim\/realtime\/rehearse\.py|studio\.recorder/ && !/awk/' \
  > "$RUN/survivors.txt" || true
{ for r in "$DEPLOY" "$LUCID"; do echo "== $r $("${GIT[@]}" -C "$r" rev-parse HEAD)"; "${GIT[@]}" -C "$r" status --porcelain; done; } > "$RUN/post_git.txt" || true
sha256sum "$DEPLOY/bundle/sonic/policy_sonic_release_g1.trt" "$DEPLOY/bundle/sonic/sonic_release_g1.onnx" \
  "$LUCID/runner/target/release/g1_deploy_onnx_ref" > "$RUN/post_sha.txt" || true
{ find "$DEPLOY" "$LUCID" -newer "$RUN/t0" -type f -not -path '*/.git/*' 2>/dev/null || true; } | head -500 > "$RUN/written_in_reference_repos.txt"
tail -n 40 "$GPU_LOG" > "$RUN/gpu_util_post.csv" 2>/dev/null || echo "unknown" > "$RUN/gpu_util_post.csv"
echo "rc=$RC run=$RUN"
echo "survivors: $(wc -l < "$RUN/survivors.txt")  host_port_binds_seen: $(wc -l < "$RUN/host_ports_seen.txt")"
echo "git changed: $(diff -q "$RUN/pre_git.txt" "$RUN/post_git.txt" >/dev/null && echo no || echo YES)  sha changed: $(diff -q "$RUN/pre_sha.txt" "$RUN/post_sha.txt" >/dev/null && echo no || echo YES)"
echo "files written in reference repos: $(wc -l < "$RUN/written_in_reference_repos.txt")"
ENDS=$(grep -c capture_end "$RUN/capture.jsonl" 2>/dev/null) || true
echo "collector closed cleanly: ${ENDS:-0}"
echo "Studio lists this run under 'Real-time rehearsals (L3)' within 10 s."
exit $RC
