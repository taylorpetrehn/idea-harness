#!/usr/bin/env bash
# safety-check.sh — PreToolUse Write|Edit guard.
#
# Reads .harness/config.json from the project root (CWD) and blocks edits
# based on its `safety` section. NO-OP if .harness/config.json is missing
# or has no safety block — safe to install globally.
#
# Behavior:
#   safety.must_not_touch                       → hard block (always)
#   safety.require_human_review_when_touching   → soft block, requires
#                                                 .harness/.allow-once
#                                                 to bypass (one-shot)
#
# Glob matching uses Python fnmatch on repo-relative paths. Patterns
# like "db/migrate/**" match recursively.
#
# Install globally:
#   chmod +x ~/.claude/hooks/safety-check.sh
#   add to ~/.claude/settings.json hooks.PreToolUse with matcher "Write|Edit"
#
# Override via env:
#   HARNESS_CONFIG     path to config.json (default: ./.harness/config.json)
#   HARNESS_ALLOW_ONCE path to one-shot bypass file (default: ./.harness/.allow-once)

set -euo pipefail

CONFIG="${HARNESS_CONFIG:-./.harness/config.json}"
ALLOW_ONCE="${HARNESS_ALLOW_ONCE:-./.harness/.allow-once}"

# No config → no enforcement. Project-agnostic by design.
[ -f "$CONFIG" ] || exit 0

input=$(cat)
target=$(printf '%s' "$input" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("tool_input",{}).get("file_path",""))' 2>/dev/null)
[ -n "$target" ] || exit 0

python3 - "$CONFIG" "$target" "$ALLOW_ONCE" <<'PY'
import json
import os
import sys
import fnmatch

cfg_path, target, allow_path = sys.argv[1], sys.argv[2], sys.argv[3]

# Normalize to repo-relative if absolute and inside cwd.
cwd = os.getcwd()
if target.startswith(cwd + os.sep):
    target = target[len(cwd) + 1:]

try:
    with open(cfg_path) as f:
        cfg = json.load(f)
except Exception:
    sys.exit(0)

safety = cfg.get("safety") or {}
if not safety:
    sys.exit(0)


def matches_any(path, patterns):
    if not patterns:
        return False
    for p in patterns:
        # fnmatch handles ** as * — for "db/migrate/**" we want recursive match.
        # Translate ** to a recursive equivalent by checking both forms.
        if fnmatch.fnmatch(path, p):
            return True
        if "**" in p and fnmatch.fnmatch(path, p.replace("**", "*")):
            return True
        # Directory-prefix shorthand: pattern "db/migrate/**" matches anything
        # at or under db/migrate/.
        if p.endswith("/**") and (path == p[:-3] or path.startswith(p[:-2])):
            return True
    return False


# Hard block.
must_not = safety.get("must_not_touch") or []
if matches_any(target, must_not):
    print(json.dumps({
        "decision": "block",
        "reason": (
            f"safety.must_not_touch: '{target}' is off-limits per .harness/config.json. "
            f"If you genuinely need to change it, ask the human to remove the entry from config.json first."
        ),
    }))
    sys.exit(0)

# Soft block with one-shot bypass.
review = safety.get("require_human_review_when_touching") or []
if matches_any(target, review):
    if os.path.exists(allow_path):
        try:
            os.remove(allow_path)
        except OSError:
            pass
        sys.exit(0)
    print(json.dumps({
        "decision": "block",
        "reason": (
            f"safety.require_human_review_when_touching: '{target}' requires explicit human approval per .harness/config.json. "
            f"Pause and ask the user. Once approved, run: "
            f"`mkdir -p .harness && touch .harness/.allow-once` and retry. The bypass is consumed after one write."
        ),
    }))
PY

exit 0
