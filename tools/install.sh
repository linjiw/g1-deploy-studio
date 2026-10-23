#!/usr/bin/env bash
# Install Studio on this machine, optionally with the pinned navigation deploy stack (docs/INSTALL.md).
#
#   tools/install.sh                  # Studio: .venv, Python packages, browser files       -> replay
#   tools/install.sh --deploy         # + the deploy stack at config/deploy.json's tag, its venv,
#                                     #   and the frozen policy bundle (private: needs `gh auth login`) -> simulation
#   tools/install.sh --runner         # + clone the SONIC runner at its pinned commit (you build it: see below)
#   tools/install.sh --robot-link     # + config/robot_link.json from the example (deploy PC only)
#   tools/install.sh --service        # + the loopback systemd --user service on 127.0.0.1:8790
#   tools/install.sh --deploy-root DIR --lucid-root DIR --data-root DIR   # record paths in config/local.json
#   tools/install.sh --dry-run ...    # print what would run, change nothing
#
# Safe to rerun: every step skips what is already in place. It never modifies an existing deploy or runner
# checkout, never overwrites config files, never uses sudo and never starts robot code. It ends with tools/doctor.py.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DRY=0 DEPLOY=0 RUNNER=0 LINK=0 SERVICE=0
declare -A SET_PATH=()
while (($#)); do
  case "$1" in
    --dry-run) DRY=1 ;;
    --deploy) DEPLOY=1 ;;
    --runner) RUNNER=1 ;;
    --robot-link) LINK=1 ;;
    --service) SERVICE=1 ;;
    --deploy-root|--lucid-root|--data-root)
      [[ $# -ge 2 ]] || { echo "$1 needs a directory" >&2; exit 2; }
      key="${1#--}"; SET_PATH["${key//-/_}"]="$2"; shift ;;
    -h|--help) sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option $1 (see --help)" >&2; exit 2 ;;
  esac
  shift
done

say() { printf '\n== %s\n' "$*"; }
run() { printf '  $ %s\n' "$*"; if ((DRY == 0)); then "$@"; fi; }
have() { command -v "$1" >/dev/null 2>&1; }
cd "$REPO"

say "Studio ($REPO)"
have python3 || { echo "python3 is required (3.10 or newer)" >&2; exit 1; }
python3 -c 'import sys; sys.exit(sys.version_info < (3, 10))' || { echo "Python 3.10 or newer is required" >&2; exit 1; }
if [[ -x .venv/bin/python ]]; then echo "  .venv present"
else
  python3 -c 'import ensurepip, venv' 2>/dev/null || { echo "  ! Python's venv module is missing: sudo apt install python3-venv (Ubuntu), then rerun" >&2; exit 1; }
  run python3 -m venv .venv
fi
run .venv/bin/python -m pip install --quiet --disable-pip-version-check -r requirements.txt
if [[ -e node_modules ]]; then
  echo "  node_modules present (npm ci skipped)"
elif have npm; then
  node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 18 ? 0 : 1)' 2>/dev/null \
    || { echo "  ! Node.js 18 or newer is required ($(node --version 2>/dev/null || echo none)); Ubuntu 22.04's apt is older: use nvm or NodeSource" >&2; exit 1; }
  run npm ci --no-audit --no-fund
else
  echo "  ! npm not found: install Node.js 18+ and run npm ci (three.js and Inter for the browser app)"
fi

if ((${#SET_PATH[@]})); then
  say "config/local.json paths"
  args=(); for k in "${!SET_PATH[@]}"; do args+=("$k=${SET_PATH[$k]}"); done
  printf '  set %s\n' "${args[@]}"
  if ((DRY == 0)); then
    python3 - "${args[@]}" <<'PY'
import json, sys
from pathlib import Path
path = Path('config/local.json')
data = json.loads(path.read_text()) if path.is_file() else {}
data.setdefault('paths', {}).update(dict(a.split('=', 1) for a in sys.argv[1:]))
path.write_text(json.dumps(data, indent=1) + '\n')
PY
  fi
fi
root() { PYTHONPATH="$REPO" .venv/bin/python -m studio.paths "$1" 2>/dev/null || PYTHONPATH="$REPO" python3 -m studio.paths "$1"; }
pin() { python3 -c 'import json,sys; d=json.load(open("config/deploy.json")); [d:=d[k] for k in sys.argv[1:]]; print(d)' "$@"; }

if ((DEPLOY)); then
  DEPLOY_ROOT="$(root deploy_root)"; REPO_ID="$(pin deploy_stack repo)"; TAG="$(pin deploy_stack tag)"
  say "Deploy stack $REPO_ID @ $TAG -> $DEPLOY_ROOT"
  if [[ -d "$DEPLOY_ROOT" ]]; then
    head="$(git -C "$DEPLOY_ROOT" rev-parse HEAD 2>/dev/null || echo none)"
    echo "  checkout present at ${head:0:12} (left as it is; the pin is $(pin deploy_stack commit | cut -c1-12))"
  else
    have gh || { echo "  ! the GitHub CLI is required for the private deploy repo: https://cli.github.com, then gh auth login" >&2; exit 1; }
    run gh repo clone "$REPO_ID" "$DEPLOY_ROOT" -- --quiet
    run git -C "$DEPLOY_ROOT" -c advice.detachedHead=false checkout --quiet --detach "$TAG"
  fi
  if [[ -x "$DEPLOY_ROOT/.venv/bin/python" ]]; then
    echo "  deploy venv present"
  else
    have uv || { echo "  ! uv is required for the deploy venv (Python 3.11): https://docs.astral.sh/uv/ (it is not installed for you)" >&2; exit 1; }
    run uv venv "$DEPLOY_ROOT/.venv" --python 3.11 --quiet
    # The versions g1-student-deploy's OPERATOR_GUIDE pins; torch with CUDA 12.8 for the planner on the robot.
    run uv pip install --python "$DEPLOY_ROOT/.venv/bin/python" --quiet torch==2.7.0 --index-url https://download.pytorch.org/whl/cu128
    DDS="${CYCLONEDDS_HOME:-$HOME/opt/sonic-deploy-toolchain/cyclonedds}"
    if [[ -d "$DDS/lib" ]]; then
      run env CYCLONEDDS_HOME="$DDS" uv pip install --python "$DEPLOY_ROOT/.venv/bin/python" --quiet -r "$DEPLOY_ROOT/requirements.txt"
    else
      # cyclonedds builds against the C library that lucid-g1-deploy's setup.sh installs; only the robot needs it.
      echo "  cyclonedds skipped: no CycloneDDS at $DDS yet (after the runner's setup.sh, rerun with --deploy)"
      if ((DRY == 0)); then grep -v '^cyclonedds' "$DEPLOY_ROOT/requirements.txt" >"$DEPLOY_ROOT/.venv/requirements-no-dds.txt"; fi
      run uv pip install --python "$DEPLOY_ROOT/.venv/bin/python" --quiet -r "$DEPLOY_ROOT/.venv/requirements-no-dds.txt"
    fi
  fi
  DDS="${CYCLONEDDS_HOME:-$HOME/opt/sonic-deploy-toolchain/cyclonedds}"
  if [[ -x "$DEPLOY_ROOT/.venv/bin/python" && -d "$DDS/lib" ]] && ! "$DEPLOY_ROOT/.venv/bin/python" -c 'import cyclonedds' 2>/dev/null; then
    have uv && run env CYCLONEDDS_HOME="$DDS" uv pip install --python "$DEPLOY_ROOT/.venv/bin/python" --quiet "$(grep '^cyclonedds' "$DEPLOY_ROOT/requirements.txt" | cut -d' ' -f1)"
  fi
  if [[ -x .venv/bin/python ]] && .venv/bin/python tools/deploy_bundle.py verify >/dev/null 2>&1; then  # read-only, full SHA-256
    echo "  bundle present and verified (every file against MANIFEST.json)"
  else
    run .venv/bin/python tools/deploy_bundle.py fetch
  fi
fi

if ((RUNNER)); then
  LUCID="$(root lucid_root)"; RREPO="$(pin sonic_runner repo)"; RCOMMIT="$(pin sonic_runner commit)"
  say "SONIC runner $RREPO @ ${RCOMMIT:0:12} -> $LUCID"
  if [[ -d "$LUCID" ]]; then
    echo "  checkout present at $(git -C "$LUCID" rev-parse --short=12 HEAD 2>/dev/null || echo '?') (left as it is)"
  else
    run git clone --quiet "https://github.com/$RREPO" "$LUCID"
    run git -C "$LUCID" -c advice.detachedHead=false checkout --quiet --detach "$RCOMMIT"
  fi
  if [[ -x "$LUCID/runner/target/release/g1_deploy_onnx_ref" ]]; then
    echo "  runner built"
  else
    echo "  Build it yourself in a real terminal (setup.sh asks for sudo for apt and CUDA; this script never uses sudo):"
    echo "    cd $LUCID && bash setup.sh && source env.sh && bash build.sh"
    echo "  then rerun: tools/install.sh --deploy   (adds cyclonedds to the deploy venv)"
  fi
fi

if ((LINK)); then
  say "Robot link config"
  if [[ -e config/robot_link.json ]]; then echo "  config/robot_link.json present (not overwritten)"
  else run cp config/robot_link.example.json config/robot_link.json; fi
  echo "  Loopback endpoints only: Studio runs on the deploy PC beside node.py (docs/NAVIGATE.md, Robot link)."
fi

if ((SERVICE)); then
  say "Service"
  run tools/studio_service.sh install
fi

LEVEL=replay; ((DEPLOY)) && LEVEL=sim; ((RUNNER || LINK)) && LEVEL=robot
# The exit status covers what this script installs itself: replay, or simulation with --deploy. The robot level also
# needs the runner built by hand (step 4), so its verdict is shown but does not fail the install.
GATE=replay; ((DEPLOY)) && GATE=sim
say "Check (tools/doctor.py --for $LEVEL)"
if ((DRY)); then echo "  $ .venv/bin/python tools/doctor.py --for $LEVEL"; exit 0; fi
.venv/bin/python tools/doctor.py --for "$LEVEL" || true
.venv/bin/python tools/doctor.py --quick --for "$GATE" >/dev/null || { echo "Not ready for $GATE: see the ✗ lines above." >&2; exit 1; }
