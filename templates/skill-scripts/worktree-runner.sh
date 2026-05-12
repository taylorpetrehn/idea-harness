#!/usr/bin/env bash
# worktree-runner.sh — the missing build primitive (Phase 3 of bridge-plan.md).
#
# Given a project key + idea slug, do everything build-accepted.py used to
# describe in prose:
#
#   1. Read the project's .harness/config.json from local_path.
#   2. Create a git worktree off origin/<base_branch>, named per the
#      project's worktree_pattern. Branch name follows the
#      idea/<slug-stub>-<id4> convention.
#   3. Run env_install commands per stack declared in config.json. Fail
#      fast on any non-zero exit.
#   4. Run commands.smoke. Fail fast.
#   5. Hand off to the builder — by default the caller's $BUILDER_CMD, or
#      a default `claude --print` invocation that reads a seed from
#      $BUILDER_SEED_FILE. The builder is expected to print
#      `PR_URL=<url>` on success or `PR_FAILED=<reason>` on failure.
#   6. Compute changed files via `git diff --name-only origin/<base>...HEAD`.
#      For each entry in evidence.evaluators[*], if any of its
#      when_touched globs matches a changed file, run its command. Merge
#      results via evidence.merge_command if present.
#   7. On builder success: leave the worktree intact for the caller to
#      remove (build-accepted.py does that after PR_URL is captured).
#      On failure: leave the worktree and append a note to idea.md so
#      the operator can inspect.
#
# Usage:
#   worktree-runner.sh <project-name> <slug> [--dry-run]
#
# Required env vars:
#   - BUILDER_SEED_FILE  path to a file containing the builder's seed
#                        prompt (used by the default builder; ignored if
#                        $BUILDER_CMD is set).
#
# Optional env vars:
#   - BUILDER_CMD        replaces the default `claude --print` invocation
#                        with a custom command. Receives the seed on
#                        stdin. For testing.
#   - HARNESS_SKILL_DIR  default: ~/.claude/skills/idea-harness
#   - HARNESS_PROJECTS_YML  default: $HARNESS_SKILL_DIR/references/projects.yml
#   - HARNESS_PLANS_DIR  default: ~/.claude/plans
#
# Exit codes:
#   0  success (PR_URL captured)
#   1  generic failure (env install, smoke, or builder failed)
#   2  bad CLI arguments / missing config files

set -euo pipefail

SCRIPT_NAME="$(basename "$0")"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

HARNESS_SKILL_DIR="${HARNESS_SKILL_DIR:-$HOME/.claude/skills/idea-harness}"
HARNESS_PROJECTS_YML="${HARNESS_PROJECTS_YML:-$HARNESS_SKILL_DIR/references/projects.yml}"
HARNESS_PLANS_DIR="${HARNESS_PLANS_DIR:-$HOME/.claude/plans}"
HARNESS_LOG_DIR="${HARNESS_LOG_DIR:-$HARNESS_SKILL_DIR/logs}"
LOG_FILE="$HARNESS_LOG_DIR/worktree-runner.log"

# ----- argument parsing --------------------------------------------------
# Skip arg validation when sourced as a library (for tests).

if [[ "${WORKTREE_RUNNER_LIB:-0}" != "1" ]]; then
  if [[ $# -lt 2 ]]; then
    echo "usage: $SCRIPT_NAME <project-name> <slug> [--dry-run]" >&2
    exit 2
  fi

  PROJECT="$1"; shift
  SLUG="$1"; shift
  DRY_RUN=0
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --dry-run) DRY_RUN=1 ;;
      *) echo "$SCRIPT_NAME: unknown arg: $1" >&2; exit 2 ;;
    esac
    shift
  done
fi

mkdir -p "$HARNESS_LOG_DIR"

log() {
  local stamp
  stamp="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
  printf '[%s] %s\n' "$stamp" "$*" | tee -a "$LOG_FILE" >&2
}

die() {
  log "ERROR: $*"
  exit 1
}

run() {
  # Run a command (passed as a single shell string) inside the build path.
  # Logs the command and its exit code. Streams stdout/stderr to log + console.
  local cmd="$1"
  log "+ ($BUILD_PATH) $cmd"
  if [[ $DRY_RUN -eq 1 ]]; then
    log "  [dry-run] skipped"
    return 0
  fi
  ( cd "$BUILD_PATH" && bash -lc "$cmd" ) 2>&1 | tee -a "$LOG_FILE"
  local rc=${PIPESTATUS[0]}
  if [[ $rc -ne 0 ]]; then
    log "  exit $rc"
    return $rc
  fi
}

# ----- helpers (also exported for tests) --------------------------------

# resolve_project — read projects.yml and emit shell `eval`-able assignments
# for the matched project. Used as: eval "$(resolve_project <name>)"
resolve_project() {
  local name="$1"
  python3 - "$HARNESS_PROJECTS_YML" "$name" <<'PY'
import re, sys, shlex
path, name = sys.argv[1], sys.argv[2]
# Tiny YAML reader: we only need top-level project key + a few scalars.
# Avoid pyyaml — keep the dependency surface zero.
text = open(path).read()
# Find the projects: block, then the name: subblock.
m = re.search(r"^projects:\s*$", text, re.M)
if not m:
    print(f"echo 'projects.yml missing top-level projects: key' >&2; exit 2", end="")
    sys.exit(0)
# Slice each project subblock by two-space indent.
parts = re.split(r"^  ([A-Za-z0-9_-]+):\s*$", text[m.end():], flags=re.M)
found = None
for i in range(1, len(parts), 2):
    if parts[i] == name:
        found = parts[i + 1]
        break
if found is None:
    print(f"echo 'project not in projects.yml: {name}' >&2; exit 2", end="")
    sys.exit(0)
def grab(key, default=""):
    m = re.search(rf"^\s{{4}}{re.escape(key)}:\s*(.*)$", found, re.M)
    if not m:
        return default
    v = m.group(1).strip()
    if (v.startswith('"') and v.endswith('"')) or (v.startswith("'") and v.endswith("'")):
        v = v[1:-1]
    if v in ("~", "null", ""):
        return default
    return v
fields = {
    "github_repo": grab("github_repo"),
    "local_path": grab("local_path"),
    "base_branch": grab("base_branch", "main"),
    "worktree_pattern": grab("worktree_pattern", "../{name}-wt-{slug}"),
    "uses_worktrees": grab("uses_worktrees", "true"),
}
# Expand ~ in local_path.
import os
fields["local_path"] = os.path.expanduser(fields["local_path"])
for k, v in fields.items():
    print(f"PROJECT_{k.upper()}={shlex.quote(v)}")
PY
}

# stacks_for — print declared stacks from the project's .harness/config.json.
# Args: <local_path>
stacks_for() {
  local local_path="$1"
  python3 -c "
import json, sys
try:
    cfg = json.load(open('$local_path/.harness/config.json'))
except FileNotFoundError:
    sys.exit(0)
stacks = cfg.get('stacks') or []
print('\n'.join(stacks))
"
}

# env_install_for_stack — print the env-install commands (one per line) for
# a given stack from .harness/config.json. Empty output = no-op.
# Args: <local_path> <stack>
env_install_for_stack() {
  local local_path="$1" stack="$2"
  python3 -c "
import json, sys
try:
    cfg = json.load(open('$local_path/.harness/config.json'))
except FileNotFoundError:
    sys.exit(0)
block = cfg.get('env_install') or {}
cmds = block.get('$stack') or []
for c in cmds:
    if isinstance(c, str) and c.strip():
        print(c)
"
}

# commands_smoke — print commands.smoke from config.json. Empty if absent.
commands_smoke() {
  local local_path="$1"
  python3 -c "
import json
cfg = json.load(open('$local_path/.harness/config.json'))
print((cfg.get('commands') or {}).get('smoke') or '')
"
}

# matched_evaluators — given changed files and the project's config, print
# (one per line) the `command` for each evaluator whose when_touched globs
# match any changed file.
# Args: <local_path> <changed-files-newline-separated>
matched_evaluators() {
  local local_path="$1" changed_files="$2"
  python3 -c "
import fnmatch, json, sys
cfg = json.load(open('$local_path/.harness/config.json'))
files = [f for f in '''$changed_files'''.splitlines() if f.strip()]
evals = (cfg.get('evidence') or {}).get('evaluators') or []
for e in evals:
    globs = e.get('when_touched') or []
    if not globs:
        continue
    hit = any(fnmatch.fnmatch(f, g) for f in files for g in globs)
    if hit and e.get('command'):
        print(e['command'])
"
}

# evidence_merge_command — print evidence.merge_command, or empty.
evidence_merge_command() {
  local local_path="$1"
  python3 -c "
import json
cfg = json.load(open('$local_path/.harness/config.json'))
print((cfg.get('evidence') or {}).get('merge_command') or '')
"
}

# ----- main flow ---------------------------------------------------------

# If sourced for testing, do NOT execute main. The caller checks for the
# WORKTREE_RUNNER_LIB sentinel.
if [[ "${WORKTREE_RUNNER_LIB:-0}" == "1" ]]; then
  return 0 2>/dev/null || exit 0
fi

log "start project=$PROJECT slug=$SLUG dry-run=$DRY_RUN"

if [[ ! -f "$HARNESS_PROJECTS_YML" ]]; then
  die "projects.yml not found at $HARNESS_PROJECTS_YML"
fi

# Resolve the project.
eval "$(resolve_project "$PROJECT")"
[[ -n "${PROJECT_LOCAL_PATH:-}" ]] || die "project $PROJECT not found in projects.yml"
[[ -d "$PROJECT_LOCAL_PATH" ]] || die "local_path missing on disk: $PROJECT_LOCAL_PATH"
[[ -f "$PROJECT_LOCAL_PATH/.harness/config.json" ]] || die "missing .harness/config.json in $PROJECT_LOCAL_PATH"

# Derive branch + worktree path.
# slug-stub = first 30 chars of slug with trailing -id4 dropped.
ID4="${SLUG##*-}"
SLUG_STUB="${SLUG%-$ID4}"
SLUG_STUB="${SLUG_STUB:0:30}"
SLUG_STUB="${SLUG_STUB%-}"  # strip trailing dash from truncation
BRANCH="idea/${SLUG_STUB}-${ID4}"

WORKTREE_PATH="${PROJECT_WORKTREE_PATTERN//\{slug\}/$SLUG}"
case "$WORKTREE_PATH" in
  /*) ;;
  *)  WORKTREE_PATH="$(cd "$PROJECT_LOCAL_PATH" && cd "$(dirname "$WORKTREE_PATH")" && pwd)/$(basename "$WORKTREE_PATH")" ;;
esac

BUILD_PATH="$WORKTREE_PATH"
SPEC_DIR="$HARNESS_PLANS_DIR/specs/$SLUG"
SPEC_FILE="$SPEC_DIR/idea.md"

log "project local_path:  $PROJECT_LOCAL_PATH"
log "branch:              $BRANCH"
log "worktree:            $WORKTREE_PATH"
log "spec:                $SPEC_FILE"

# Step 2 — create worktree from origin/<base>.
if [[ $DRY_RUN -eq 0 ]]; then
  if ( cd "$PROJECT_LOCAL_PATH" && git worktree list --porcelain | grep -q "^worktree $WORKTREE_PATH$" ); then
    log "worktree already exists at $WORKTREE_PATH — reusing"
  else
    log "creating worktree"
    ( cd "$PROJECT_LOCAL_PATH" && git fetch origin --quiet )
    ( cd "$PROJECT_LOCAL_PATH" && git worktree add -B "$BRANCH" "$WORKTREE_PATH" "origin/$PROJECT_BASE_BRANCH" )
  fi
else
  log "[dry-run] would create worktree from origin/$PROJECT_BASE_BRANCH"
  mkdir -p "$WORKTREE_PATH"
fi

# Step 3 — env install per declared stack.
STACKS=$(stacks_for "$PROJECT_LOCAL_PATH")
log "stacks: $(echo "$STACKS" | tr '\n' ' ')"
for stack in $STACKS; do
  cmds=$(env_install_for_stack "$PROJECT_LOCAL_PATH" "$stack")
  if [[ -z "$cmds" ]]; then
    log "stack=$stack: no env_install commands declared; skipping"
    continue
  fi
  log "stack=$stack: env install"
  while IFS= read -r cmd; do
    [[ -z "$cmd" ]] && continue
    run "$cmd" || die "env install failed for stack=$stack ($cmd)"
  done <<< "$cmds"
done

# Step 4 — smoke.
SMOKE=$(commands_smoke "$PROJECT_LOCAL_PATH")
if [[ -n "$SMOKE" ]]; then
  log "smoke: $SMOKE"
  run "$SMOKE" || die "smoke failed: $SMOKE"
else
  log "no smoke command declared; skipping"
fi

# Step 5 — hand off to builder.
if [[ -n "${BUILDER_CMD:-}" ]]; then
  log "builder: \$BUILDER_CMD set; using that"
  if [[ $DRY_RUN -eq 0 ]]; then
    ( cd "$BUILD_PATH" && bash -lc "$BUILDER_CMD" ) 2>&1 | tee -a "$LOG_FILE" >"${SPEC_DIR}/build.log" || true
  fi
elif [[ -n "${BUILDER_SEED_FILE:-}" ]]; then
  [[ -f "$BUILDER_SEED_FILE" ]] || die "BUILDER_SEED_FILE missing: $BUILDER_SEED_FILE"
  # Claude Code 2.1.139+: prepend `/goal "PR open and CI green"` so Claude
  # Code drives its own convergence loop. The runner is no longer
  # responsible for retry counting. If /goal isn't supported (older
  # claude binary), the seed still runs as a single directive — the
  # slash command line is just ignored.
  GOAL_DIRECTIVE="/goal \"PR open on branch $BRANCH against $PROJECT_BASE_BRANCH, with all required CI checks passing\""
  log "builder: claude --print < ($GOAL_DIRECTIVE + seed)"
  if [[ $DRY_RUN -eq 0 ]]; then
    mkdir -p "$SPEC_DIR"
    SEED_WITH_GOAL=$(printf '%s\n\n%s' "$GOAL_DIRECTIVE" "$(cat "$BUILDER_SEED_FILE")")
    ( cd "$BUILD_PATH" && claude --print "$SEED_WITH_GOAL" ) 2>&1 | tee -a "$LOG_FILE" >"${SPEC_DIR}/build.log" || true
  fi
else
  log "no BUILDER_CMD or BUILDER_SEED_FILE set; skipping builder spawn (use --dry-run for plan only)"
fi

# Step 6 — compute changed files and run matched evaluators.
if [[ $DRY_RUN -eq 0 && -d "$BUILD_PATH/.git" || -f "$BUILD_PATH/.git" ]]; then
  CHANGED=$( ( cd "$BUILD_PATH" && git diff --name-only "origin/$PROJECT_BASE_BRANCH...HEAD" ) 2>/dev/null || true )
else
  CHANGED=""
fi
log "changed files: $(echo "$CHANGED" | wc -l | tr -d ' ')"
EVAL_CMDS=$(matched_evaluators "$PROJECT_LOCAL_PATH" "$CHANGED")
if [[ -n "$EVAL_CMDS" ]]; then
  log "running evaluators matched by changed-file globs"
  while IFS= read -r ec; do
    [[ -z "$ec" ]] && continue
    run "$ec" || log "evaluator returned non-zero (continuing): $ec"
  done <<< "$EVAL_CMDS"
else
  log "no evaluators matched (or no changed files yet)"
fi

MERGE_CMD=$(evidence_merge_command "$PROJECT_LOCAL_PATH")
if [[ -n "$MERGE_CMD" ]]; then
  run "$MERGE_CMD" || log "merge_command non-zero (continuing): $MERGE_CMD"
fi

log "done"
exit 0
