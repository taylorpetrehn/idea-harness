#!/usr/bin/env bash
# Tests for worktree-runner.sh helpers. Source the runner with the
# WORKTREE_RUNNER_LIB sentinel to skip main(), then exercise the helpers
# against a synthetic .harness/config.json + projects.yml.
#
# Run with:
#   bash templates/skill-scripts/worktree-runner.test.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RUNNER="$SCRIPT_DIR/worktree-runner.sh"

FIXTURE_DIR="$(mktemp -d)"
trap 'rm -rf "$FIXTURE_DIR"' EXIT

FAIL=0
pass() { printf "  ✅ %s\n" "$1"; }
fail() { printf "  ❌ %s\n" "$1"; FAIL=$((FAIL+1)); }

# Synthesise a project repo with .harness/config.json
REPO="$FIXTURE_DIR/myproj"
mkdir -p "$REPO/.harness"
cat > "$REPO/.harness/config.json" <<'JSON'
{
  "name": "myproj",
  "stacks": ["rails", "expo"],
  "commands": {
    "smoke": "echo SMOKE OK"
  },
  "env_install": {
    "rails": ["bundle install", "bin/rails db:test:prepare"],
    "expo":  ["cd mobile && npm ci"]
  },
  "evidence": {
    "evaluators": [
      {"key": "rails", "command": "echo run_rspec", "when_touched": ["app/**", "spec/**"]},
      {"key": "mobile", "command": "echo run_jest", "when_touched": ["mobile/**"]},
      {"key": "ui",     "command": "echo run_playwright", "when_touched": ["app/views/**"]}
    ],
    "merge_command": "echo merge"
  }
}
JSON

# Synthesise a projects.yml
cat > "$FIXTURE_DIR/projects.yml" <<YAML
projects:
  myproj:
    github_repo: "owner/myproj"
    local_path: "$REPO"
    base_branch: "main"
    worktree_pattern: "../myproj-wt-{slug}"
    uses_worktrees: true
YAML

# Source the runner as a library.
export WORKTREE_RUNNER_LIB=1
export HARNESS_PROJECTS_YML="$FIXTURE_DIR/projects.yml"
# shellcheck source=/dev/null
. "$RUNNER"

echo "== resolve_project =="
out=$(resolve_project "myproj")
if echo "$out" | grep -q "PROJECT_BASE_BRANCH=main"; then pass "extracts base_branch=main"; else fail "missing PROJECT_BASE_BRANCH"; fi
if echo "$out" | grep -q "PROJECT_LOCAL_PATH="; then pass "emits PROJECT_LOCAL_PATH"; else fail "missing PROJECT_LOCAL_PATH"; fi
out2=$(resolve_project "no-such-project" 2>&1 || true)
if echo "$out2" | grep -q "not in projects.yml"; then pass "errors for unknown project"; else fail "unknown project should error: $out2"; fi

echo "== stacks_for =="
out=$(stacks_for "$REPO")
if [[ "$out" == *"rails"* && "$out" == *"expo"* ]]; then pass "lists both rails and expo"; else fail "stacks_for returned: $out"; fi

echo "== env_install_for_stack =="
rails_cmds=$(env_install_for_stack "$REPO" "rails")
if echo "$rails_cmds" | grep -q "bundle install"; then pass "rails: bundle install"; else fail "missing bundle install"; fi
if echo "$rails_cmds" | grep -q "bin/rails db:test:prepare"; then pass "rails: db:test:prepare"; else fail "missing db:test:prepare"; fi
expo_cmds=$(env_install_for_stack "$REPO" "expo")
if echo "$expo_cmds" | grep -q "npm ci"; then pass "expo: npm ci"; else fail "missing npm ci"; fi
none=$(env_install_for_stack "$REPO" "nonexistent")
if [[ -z "$none" ]]; then pass "unknown stack returns empty"; else fail "unknown stack returned: $none"; fi

echo "== commands_smoke =="
out=$(commands_smoke "$REPO")
if [[ "$out" == "echo SMOKE OK" ]]; then pass "extracts smoke command"; else fail "smoke: $out"; fi

echo "== matched_evaluators =="
changed="app/models/foo.rb
app/views/foo.erb"
out=$(matched_evaluators "$REPO" "$changed")
# Should match rails (app/**) AND ui (app/views/**) but NOT mobile (no mobile/ touched).
if echo "$out" | grep -q "run_rspec"; then pass "matched rails evaluator"; else fail "missing rails evaluator"; fi
if echo "$out" | grep -q "run_playwright"; then pass "matched ui evaluator"; else fail "missing ui evaluator"; fi
if echo "$out" | grep -q "run_jest"; then fail "should NOT have matched mobile (no mobile/ files)"; else pass "did not match mobile"; fi

# Empty changed list → nothing matched.
none=$(matched_evaluators "$REPO" "")
if [[ -z "$none" ]]; then pass "empty changed list → no matches"; else fail "empty changed list returned: $none"; fi

# Mobile-only change → only mobile evaluator.
mobile_changed="mobile/src/App.tsx"
out=$(matched_evaluators "$REPO" "$mobile_changed")
if echo "$out" | grep -q "run_jest"; then pass "mobile-only matched mobile evaluator"; else fail "missing mobile evaluator: $out"; fi
if echo "$out" | grep -q "run_rspec"; then fail "should NOT have matched rails on mobile-only change"; else pass "did not match rails on mobile-only change"; fi

echo "== evidence_merge_command =="
out=$(evidence_merge_command "$REPO")
if [[ "$out" == "echo merge" ]]; then pass "extracts merge_command"; else fail "merge_command: $out"; fi

echo
if [[ $FAIL -eq 0 ]]; then
  echo "ALL TESTS PASSED"
  exit 0
else
  echo "$FAIL TEST(S) FAILED"
  exit 1
fi
