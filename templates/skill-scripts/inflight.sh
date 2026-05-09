#!/usr/bin/env bash
# inflight.sh — list ideas across ~/.claude/plans/, grouped by status.
#
# Reads frontmatter from:
#   - ~/.claude/plans/specs/{slug}/idea.md  (new idea-harness layout)
#   - ~/.claude/plans/specs/{name}.md       (flat layout, optional)
#   - ~/.claude/plans/*.md                  (legacy: shape-spec / write-spec output)
#
# Files without frontmatter are bucketed under "legacy".
# Output is grouped by status, sorted by last_touched desc within each group,
# awaiting-review first, then in-flight, then archived.

set -euo pipefail

PLANS_DIR="${HOME}/.claude/plans"
SPECS_DIR="${PLANS_DIR}/specs"

if [[ ! -d "$PLANS_DIR" ]]; then
  echo "no plans dir at $PLANS_DIR — nothing in flight"
  exit 0
fi

# Group ordering — anything not in this list is appended at the end alphabetically.
GROUP_ORDER=(
  "needs-critic-review"
  "awaiting-review"
  "brainstormed"
  "needs-detail"
  "accepted"
  "building"
  "pr-open"
  "captured"
  "shipped"
  "rejected"
  "legacy"
)

# Parse frontmatter from a file: extract a single key's value or empty.
fm() {
  local file="$1" key="$2"
  awk -v key="$key" '
    BEGIN { in_fm = 0; n = 0 }
    /^---[[:space:]]*$/ {
      if (in_fm == 0) { in_fm = 1; next }
      else { exit }
    }
    in_fm == 1 {
      if (match($0, "^" key ":[[:space:]]*")) {
        v = substr($0, RLENGTH + 1)
        gsub(/^["'"'"']|["'"'"']$/, "", v)
        gsub(/^[[:space:]]+|[[:space:]]+$/, "", v)
        print v
        exit
      }
    }
  ' "$file"
}

has_frontmatter() {
  head -1 "$1" 2>/dev/null | grep -q '^---[[:space:]]*$'
}

# Collect rows: status<TAB>last_touched<TAB>title<TAB>project<TAB>relpath
rows=()

# Helper to ingest a file with a known relative-path prefix label.
ingest() {
  local f="$1" rel_prefix="$2" default_title="$3"
  local rel="${f#$PLANS_DIR/}"
  local status title project touched
  if has_frontmatter "$f"; then
    status=$(fm "$f" "status"); status="${status:-captured}"
    title=$(fm "$f" "title");   title="${title:-$default_title}"
    project=$(fm "$f" "project"); project="${project:-?}"
    touched=$(fm "$f" "last_touched"); touched="${touched:-1970-01-01T00:00:00Z}"
  else
    status="legacy"
    title="$default_title"
    project="?"
    touched=$(date -r "$f" -u +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || echo "1970-01-01T00:00:00Z")
  fi
  rows+=("$status"$'\t'"$touched"$'\t'"$title"$'\t'"$project"$'\t'"$rel")
}

# 1. New layout: ~/.claude/plans/specs/{slug}/idea.md
if [[ -d "$SPECS_DIR" ]]; then
  while IFS= read -r f; do
    [[ -z "$f" ]] && continue
    slug=$(basename "$(dirname "$f")")
    ingest "$f" "specs/" "$slug"
  done < <(find "$SPECS_DIR" -mindepth 2 -maxdepth 2 -name "idea.md" -type f 2>/dev/null)

  # 2. Optional flat layout inside specs/: ~/.claude/plans/specs/{name}.md
  while IFS= read -r f; do
    [[ -z "$f" ]] && continue
    name=$(basename "$f" .md)
    ingest "$f" "specs/" "$name"
  done < <(find "$SPECS_DIR" -mindepth 1 -maxdepth 1 -name "*.md" -type f 2>/dev/null)
fi

# 3. Legacy: ~/.claude/plans/*.md (shape-spec / write-spec output)
while IFS= read -r f; do
  [[ -z "$f" ]] && continue
  name=$(basename "$f" .md)
  ingest "$f" "" "$name"
done < <(find "$PLANS_DIR" -mindepth 1 -maxdepth 1 -name "*.md" -type f 2>/dev/null)

if [[ ${#rows[@]} -eq 0 ]]; then
  echo "no ideas in flight"
  exit 0
fi

# Discover unique statuses present in rows (no associative arrays — bash 3 compat).
present_statuses=$(printf '%s\n' "${rows[@]}" | cut -f1 | sort -u)

# Build ordered group list: GROUP_ORDER entries that are present, then any extras.
ordered=()
for g in "${GROUP_ORDER[@]}"; do
  if printf '%s\n' "$present_statuses" | grep -qx -- "$g"; then
    ordered+=("$g")
  fi
done
# Statuses present but not in GROUP_ORDER — append alphabetically.
known=$(printf '%s\n' "${GROUP_ORDER[@]}")
extras=$(printf '%s\n' "$present_statuses" | grep -vxF -f <(printf '%s\n' "$known") || true)
if [[ -n "$extras" ]]; then
  while IFS= read -r g; do
    [[ -z "$g" ]] && continue
    ordered+=("$g")
  done < <(printf '%s\n' "$extras" | sort)
fi

total=${#rows[@]}
printf "ideas in flight: %d total · across %d statuses\n\n" "$total" "${#ordered[@]}"

for g in "${ordered[@]}"; do
  group_rows=()
  for r in "${rows[@]}"; do
    [[ "${r%%	*}" == "$g" ]] && group_rows+=("$r")
  done
  count=${#group_rows[@]}
  printf "── %s · %d ──\n" "$g" "$count"
  # Sort by last_touched desc (column 2)
  printf '%s\n' "${group_rows[@]}" | sort -t$'\t' -k2,2r | while IFS=$'\t' read -r status touched title project rel; do
    # Truncate title to keep lines readable
    if [[ ${#title} -gt 60 ]]; then title="${title:0:57}…"; fi
    printf "  %-12s  %-60s  %s\n" "[$project]" "$title" "$rel"
  done
  echo
done
