#!/usr/bin/env bash
# openclaw-disable.sh — turn off any OpenClaw idea-pipeline cron entries
# without touching the rest of the OpenClaw runtime.
#
# This script is conservative: it lists what it finds, asks before
# modifying jobs.json, and only `launchctl unload`s plists whose basename
# matches one of the idea-pipeline patterns. The OpenClaw gateway plist
# (`ai.openclaw.gateway`) is NEVER touched — it hosts other automations
# (R365/Square/etc.) that are out of scope for the idea-harness merge.
#
# Re-runnable: idempotent. After Phase 1's openclaw merge PR lands, run
# this once. After a rollback window passes, run a follow-up cleanup PR
# that deletes `~/.openclaw/.claude/skills/idea-pipeline/` and the
# associated agent definitions.
#
# Usage:
#   ./openclaw-disable.sh            # report-only (default)
#   ./openclaw-disable.sh --apply    # actually unload plists and disable jobs.json entries

set -euo pipefail

APPLY=0
if [[ "${1:-}" == "--apply" ]]; then
  APPLY=1
fi

HOME_DIR="${HOME:?HOME not set}"
LA_DIR="$HOME_DIR/Library/LaunchAgents"
OPENCLAW_DIR="$HOME_DIR/.openclaw"
JOBS_JSON="$OPENCLAW_DIR/cron/jobs.json"

# Patterns that identify an idea-pipeline cron entry. Deliberately narrow:
# we do NOT want to match the broader gateway plist or unrelated
# bonnie/coder automations.
PLIST_PATTERNS=(
  "*idea-pipeline*"
  "*idea_pipeline*"
  "com.openclaw.idea*"
)

# Names of jobs in `~/.openclaw/cron/jobs.json` that are idea-pipeline-y.
# Match against the `name` field. Case-insensitive substring match.
JOBS_NAME_PATTERNS=(
  "idea-to-pr"
  "idea pipeline"
  "idea_pipeline"
)

if [[ $APPLY -eq 1 ]]; then
  echo "=== openclaw-disable.sh — APPLY mode ==="
else
  echo "=== openclaw-disable.sh — report only (pass --apply to make changes) ==="
fi

echo
echo "--- LaunchAgents (~/Library/LaunchAgents) ---"
matched_plists=()
if [[ -d "$LA_DIR" ]]; then
  while IFS= read -r -d '' plist; do
    matched_plists+=("$plist")
  done < <(
    for pat in "${PLIST_PATTERNS[@]}"; do
      find "$LA_DIR" -maxdepth 1 -type f -name "$pat" -print0 2>/dev/null
    done
  )
fi

if [[ ${#matched_plists[@]} -eq 0 ]]; then
  echo "(no idea-pipeline plists found — likely already removed or never installed standalone)"
else
  for plist in "${matched_plists[@]}"; do
    echo "found: $plist"
    if [[ $APPLY -eq 1 ]]; then
      if launchctl list "$(basename "$plist" .plist)" >/dev/null 2>&1; then
        echo "  unloading via launchctl"
        launchctl unload -w "$plist" || echo "  (unload returned non-zero; continuing)"
      else
        echo "  (not currently loaded; skipping unload)"
      fi
      mv -v "$plist" "${plist}.disabled-$(date -u +%Y%m%dT%H%M%SZ)"
    fi
  done
fi

echo
echo "--- OpenClaw gateway jobs.json ($JOBS_JSON) ---"
if [[ ! -f "$JOBS_JSON" ]]; then
  echo "(jobs.json not present — gateway uninstalled or never ran)"
else
  # Read names + enabled flags. Use python rather than jq so we don't add a dep.
  python3 - "$JOBS_JSON" "${JOBS_NAME_PATTERNS[@]}" <<'PY'
import json, sys
path, *patterns = sys.argv[1:]
with open(path) as fh:
    data = json.load(fh)
hits = []
for job in data.get("jobs", []):
    name = (job.get("name") or "").lower()
    if any(p.lower() in name for p in patterns):
        hits.append(job)
if not hits:
    print("(no idea-pipeline jobs found in jobs.json)")
else:
    for job in hits:
        flag = "enabled" if job.get("enabled") else "DISABLED"
        print(f"  - {job.get('name')!r} [{flag}] agentId={job.get('agentId')} id={job.get('id')[:8]}…")
PY

  if [[ $APPLY -eq 1 ]]; then
    backup="${JOBS_JSON}.preharness-$(date -u +%Y%m%dT%H%M%SZ)"
    cp -v "$JOBS_JSON" "$backup"
    python3 - "$JOBS_JSON" "${JOBS_NAME_PATTERNS[@]}" <<'PY'
import json, sys
path, *patterns = sys.argv[1:]
with open(path) as fh:
    data = json.load(fh)
changed = 0
for job in data.get("jobs", []):
    name = (job.get("name") or "").lower()
    if any(p.lower() in name for p in patterns) and job.get("enabled"):
        job["enabled"] = False
        changed += 1
if changed:
    with open(path, "w") as fh:
        json.dump(data, fh, indent=2)
        fh.write("\n")
    print(f"  disabled {changed} idea-pipeline job(s) in jobs.json")
else:
    print("  no jobs.json edits needed (already disabled or not present)")
PY
  fi
fi

echo
echo "--- Sanity: launchctl entries still mentioning idea-pipeline ---"
if launchctl list 2>/dev/null | grep -Ei '(idea-pipeline|idea_pipeline)' ; then
  if [[ $APPLY -eq 1 ]]; then
    echo "WARN: launchctl still shows idea-pipeline entries above. They may live"
    echo "      outside ~/Library/LaunchAgents (e.g. /Library/LaunchAgents). Inspect manually."
  fi
else
  echo "(none)"
fi

echo
echo "Done."
if [[ $APPLY -eq 0 ]]; then
  echo "Re-run with --apply to make the above changes permanent."
fi
