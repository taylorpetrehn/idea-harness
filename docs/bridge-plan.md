# Idea Harness — Bridge Plan

## Context

The operator asked to "review and bridge the gap" on the idea-harness concept. Three truths from the exploration shape this plan:

1. **There are two parallel orchestrators today.** `idea-harness` (this repo + `~/.claude/skills/idea-harness/` + 4 LaunchAgents, state in `~/.claude/plans/specs/<slug>/idea.md`) and `OpenClaw` (`~/.openclaw/workspace-bonnie/`, state in `ideas.jsonl`, cron+webhook, multi-agent gauntlet, described as canonical in `/home/user/LetsBarker/docs/orchestration-architecture.md`). Both claim authority. This is the single largest source of the operator's sense of disorganization.

2. **There is no real "interface" beyond the filesystem.** Mobile = Claude Code Remote Control. Terminal = `/inflight` flat markdown listing. The Ink dashboard from v2 is archived. No programmatic surface exists for a mobile app or richer terminal flow to attach to — `idea.md` frontmatter IS the API.

3. **"Cloud" and "worktree+env+e2e" are aspirational.** `build-accepted.py` assumes the repo is already cloned; it tells Claude to make a worktree but no script enforces `bundle install → npm ci → db:setup → rspec → maestro → results.json`. That judgment is left to in-session Claude, which is why long-running jobs aren't reliable.

The operator's stated goal ("better sustained organization") is therefore mostly **a consolidation problem first**, then a surfaces problem. Phase 1 removes duplication; Phases 2–4 add the missing surfaces on the consolidated base.

## Decisions made (operator-confirmed)

| # | Decision | Choice |
|---|---|---|
| D1 | idea-harness vs OpenClaw | **Merge — idea-harness absorbs OpenClaw.** Retire `~/.openclaw/`. |
| D2 | Mobile interface | **Native React Native app (Expo).** Lives at `/home/user/idea-harness/apps/mobile/`. Complements Claude Remote Control; does not replace it. |
| D3 | Terminal interface | **Slash commands inside Claude Code** (not a separate TUI). Backed by a `harness` CLI under the hood. |
| D4 | Cloud execution | **Hybrid.** Build a pluggable worker abstraction; local worktree as default, GH Actions / Codespaces as opt-in per project/idea. |

Deferred (resist scope creep): multi-repo ideas, semantic search, analytics, Slack/email capture, auto-addressing PR review comments, web UI.

## Target Architecture

```
CAPTURE  → Reminders (harvest.py, existing) | GH Issues `agent:ready` (Phase 4) | `harness capture "..."` CLI

STATE    → ~/.claude/plans/specs/<slug>/idea.md         (canonical — filesystem is truth)
           ~/.claude/plans/index.sqlite                 (derived cache, rebuildable)

PIPELINE → brainstorm-captured.py → escalate-needs-detail.py → build-accepted.py
           + review-gauntlet.py (Phase 1, ported from OpenClaw)
           + worktree-runner.sh (Phase 3, the missing primitive)

API      → `harness` CLI (Python/Typer): list, show, accept, reject, reroute, build, brainstorm, capture, init-harness, reindex, reconcile, mcp serve
           Same verbs exposed as MCP tools via `harness mcp serve` and as Claude Code slash commands

SURFACES → Claude Code slash commands (/inflight, /idea-accept, /idea-build, /idea-search, /harness-init)
           Expo mobile app over Tailscale HTTP to `harness mcp serve`
           Claude Code Remote Control (kept for "type a decision" escalation)

WORKERS  → local-claude-cli (default) | gh-action-claude (Phase 4) | codespace-claude (Phase 4)
```

**Design rules:**
- **Filesystem = truth, SQLite = index.** Every write goes through the CLI which updates `idea.md` first, then the index. `harness reindex` rebuilds the SQLite at will.
- **The CLI is the API.** Mobile, slash commands, MCP, and LaunchAgents all call `harness ...`. No second service to maintain.
- **Claude Code is invoked AND exposed.** `harness mcp serve` lets Claude Code sessions drive the harness as MCP tool calls. Slash commands are thin shells over the CLI.

## Phase 1 — Consolidate (highest-leverage, ~1 week)

**Goal:** Kill OpenClaw as a runtime. One orchestrator, one state, one README. Nothing visibly new; everything quieter and clearer.

1. Write `/home/user/idea-harness/docs/openclaw-merge.md` describing what migrates and what dies. Add a redirect banner at the top of `/home/user/LetsBarker/docs/orchestration-architecture.md`.
2. One-shot migration script: port any live `~/.openclaw/workspace-bonnie/data/idea-pipeline/ideas.jsonl` records into `~/.claude/plans/specs/<slug>/idea.md` files. Verify via `/inflight`.
3. Port OpenClaw's **4-reviewer gauntlet** (Spec Fidelity, Codebase Patterns, Risk, UX) into `~/.claude/skills/idea-harness/scripts/review-gauntlet.py`. Invoked after `build-accepted.py` parses `PR_URL=`. Each reviewer is a `claude --print` subagent; results posted via `gh pr comment`.
4. Merge OpenClaw's `references/projects.yml` (LetsBarker preview+worktrees, Clawd main+direct, Rewilding main+worktrees) into the canonical `~/.claude/skills/idea-harness/references/projects.yml`.
5. Disable OpenClaw cron + agents. Leave the directory on disk for one rollback cycle, then delete.
6. Rewrite `/home/user/idea-harness/README.md` §Archive into a §Migration section; update `/home/user/LetsBarker/WORKFLOW.md` and `/home/user/LetsBarker/AGENTS.md` to point at idea-harness.

**Critical files:**
- `/home/user/idea-harness/README.md` (rewrite)
- `/home/user/idea-harness/docs/openclaw-merge.md` (new)
- `~/.claude/skills/idea-harness/scripts/review-gauntlet.py` (new, ported)
- `~/.claude/skills/idea-harness/references/projects.yml` (consolidate)
- `/home/user/LetsBarker/docs/orchestration-architecture.md` (banner + redirect)
- `/home/user/LetsBarker/WORKFLOW.md`, `/home/user/LetsBarker/AGENTS.md`

## Phase 2 — CLI + MCP surface (~1 week)

**Goal:** Stop treating `idea.md` frontmatter as a private contract. Wrap it in a CLI any UI can drive, and expose it to Claude Code via MCP + slash commands.

1. New Python package at `/home/user/idea-harness/cli/` (Typer + click), `pip install -e .` to expose the `harness` binary. Verbs:
   - `harness ideas list [--status X] [--project Y] [--score-gte N]`
   - `harness ideas show <slug>`
   - `harness ideas accept <slug>` / `reject <slug>` / `reroute <slug> <project>`
   - `harness ideas build <slug> [--worker local|gh-action|codespace]`
   - `harness ideas brainstorm <slug>` (manual trigger)
   - `harness capture "<title>" [--project X]` (CLI capture path)
   - `harness init-harness [<repo-path>]` — introspect a repo's stacks (Gemfile / package.json / pyproject.toml), propose a `.harness/config.json` + `CLAUDE.md`, write on confirm. **This closes the operator's "I don't understand directory structure" gap directly.**
   - `harness reindex` — rebuild `~/.claude/plans/index.sqlite` from disk
   - `harness reconcile` — poll `pr-open` ideas, update status from GitHub
   - `harness mcp serve` — HTTP+MCP transport on Tailscale
2. Every verb reads/writes `idea.md` frontmatter directly (filesystem stays authoritative), then updates the SQLite index.
3. Replace `~/.claude/skills/idea-harness/scripts/inflight.sh` and `~/.claude/commands/inflight.md` with thin shims that call `harness ideas list`.
4. Add Claude Code slash commands at `~/.claude/commands/`:
   - `/inflight` (existing, repointed)
   - `/idea-accept <slug>`, `/idea-reject <slug>`, `/idea-build <slug>`, `/idea-search <query>`
   - `/harness-init` — runs `harness init-harness` in the CWD repo
5. Existing cron scripts (`harvest.py`, `brainstorm-captured.py`, `build-accepted.py`) start calling `harness` verbs for status updates. Core pipeline logic stays.

**Critical files:**
- `/home/user/idea-harness/cli/pyproject.toml`, `cli/harness/__main__.py`, `cli/harness/commands/*.py`, `cli/harness/state.py`, `cli/harness/mcp_server.py` (new package)
- `~/.claude/plans/index.sqlite` (derived, gitignored)
- `~/.claude/commands/{inflight,idea-accept,idea-reject,idea-build,idea-search,harness-init}.md` (new + repointed)
- `~/.claude/skills/idea-harness/scripts/inflight.sh` (rewrite to shim `harness`)

## Phase 3 — Mobile app + worktree-runner primitive (~2 weeks)

**Goal:** Real mobile surface for the operator, plus the missing build primitive that makes long-running reliable.

1. **Expo mobile app** at `/home/user/idea-harness/apps/mobile/`. Stack mirrors LetsBarker mobile (Expo Router v55, NativeWind, TanStack Query). Screens:
   - **Inbox** — list of ideas grouped by status, filterable by project, score, source.
   - **Idea Detail** — render `idea.md` body + frontmatter; action bar for accept/reject/reroute/build.
   - **Decision** — for `needs-detail` ideas, render brainstorm variants and the open question; submit writes `## Decision` back to `idea.md`.
   - **PR Status** — for `pr-open`/`shipped`, link to GitHub + show review gauntlet results.
   - Transport: Tailscale HTTPS to `harness mcp serve`, auth via token in `~/.secrets/harness-mobile-token`.
   - **Pattern reuse from LetsBarker:** Expo Router `formSheet` presentation (per `mobile/CLAUDE.md`), TanStack Query keys structure, NativeWind component patterns, i18n setup.
   - Claude Remote Control stays for the deep "think with me" escalation flow; the new app is for browse/triage at rest.

2. **The worktree+env+e2e primitive** — new `~/.claude/skills/idea-harness/scripts/worktree-runner.sh`. Given `<project> <idea-slug>`:
   - Read `<local_path>/.harness/config.json`.
   - `git worktree add ../<repo>-wt-<slug> -B idea/<slug-stub>-<id4> origin/<base_branch>`.
   - Run per-stack env install (extend `.harness/config.json` schema with optional `env_install` block per stack; defaults: Rails → `bundle install && bin/rails db:test:prepare`; Expo → `cd mobile && npm ci`; Vite → `npm ci`).
   - Run `commands.smoke` to fail-fast.
   - Hand off to the builder (`claude --print` for now).
   - On builder exit: compute changed files (`git diff --name-only origin/<base>...HEAD`), run each `evidence.evaluators[*].command` whose `when_touched` glob matched, merge results via `evidence.merge_command` into `evidence.results_file`.
   - Tear down worktree on success; leave it on failure with a note in `idea.md`.

3. Refactor `build-accepted.py` to delegate worktree+env+e2e to `worktree-runner.sh` instead of describing it in-prompt.

**Critical files:**
- `/home/user/idea-harness/apps/mobile/` (new Expo project)
- `~/.claude/skills/idea-harness/scripts/worktree-runner.sh` (new)
- `~/.claude/skills/idea-harness/scripts/build-accepted.py` (refactor)
- `/home/user/idea-harness/templates/repo/.harness/config.json` (extend with `env_install`)
- `/home/user/idea-harness/cli/harness/mcp_server.py` (add HTTPS Tailscale listener + token auth)

## Phase 4 — Cloud workers + GitHub-issue capture (~1 week)

**Goal:** Long-running cloud builds, opt-in per project. Close the GitHub-Issue capture loop.

1. Worker abstraction in CLI: `harness ideas build <slug> --worker {local|gh-action|codespace}`. Default stays `local`.
   - `gh-action` invokes `/home/user/LetsBarker/.github/workflows/claude.yml` via `workflow_dispatch` with the idea slug as input; the action posts back `PR_URL=` via `gh pr comment`, which `harness reconcile` ingests.
   - `codespace` does `gh codespace create` on the project repo, ssh's in, runs the same `worktree-runner.sh`, captures PR URL on exit.
   - Per-project default worker lives in `.harness/config.json:vcs.default_worker`.
2. Resurrect `/home/user/LetsBarker/.github/workflows/agent-ready-trigger.yml.disabled` retargeted at `harness mcp serve`'s Tailscale Funnel URL (stored in repo secrets). A `agent:ready` label on any onboarded repo's issue triggers immediate idea ingestion.
3. Cron `harness reconcile` every 5 min: polls `pr-open` ideas, updates status, handles change-requests by re-dispatching to the same worker.
4. Copy the long-running operator-control hooks (`.claude/hooks/{kill-switch,steer,verify-gate,track-read,commit-on-stop}.sh`) into the Codespace image so cloud builds inherit the same steering surface as local ones.

**Critical files:**
- `/home/user/idea-harness/cli/harness/workers/{local,gh_action,codespace}.py` (new)
- `~/.claude/skills/idea-harness/scripts/reconcile.py` (new cron entry; new LaunchAgent plist)
- `/home/user/LetsBarker/.github/workflows/agent-ready-trigger.yml` (re-enable + retarget)
- `/home/user/LetsBarker/.github/workflows/claude.yml` (extend with `workflow_dispatch` inputs)
- `/home/user/idea-harness/templates/repo/.harness/config.json` (add `vcs.default_worker`)

## Reusable components (leverage, do not rewrite)

- `harvest.py`, `brainstorm-captured.py`, `escalate-needs-detail.py`, `build-accepted.py` at `/home/user/idea-harness/templates/skill-scripts/` — keep pipeline logic; refactor I/O through the CLI.
- `.harness/config.json` schema at `/home/user/idea-harness/templates/repo/.harness/config.json` — already covers stacks/commands/evidence/safety/vcs. Extend only with `env_install` (Phase 3) and `vcs.default_worker` (Phase 4).
- `safety-check.sh` at `/home/user/idea-harness/templates/hooks/safety-check.sh` — works as-is; CWD-relative so it auto-applies in worktree builds.
- Operator-control hooks at `/home/user/idea-harness/.claude/hooks/` — copy into Codespace image (Phase 4).
- OpenClaw's 4-reviewer gauntlet pattern (documented in `/home/user/LetsBarker/docs/orchestration-architecture.md` §4) — port to `review-gauntlet.py` in Phase 1.
- LetsBarker mobile patterns (`/home/user/LetsBarker/mobile/`) — Expo Router groups, TanStack Query keys, NativeWind, i18n setup, `formSheet` modal presentation. Borrow for `/home/user/idea-harness/apps/mobile/`.
- LetsBarker `.github/workflows/claude.yml` — already on-ramps `claude-code-action`; Phase 4 just adds `workflow_dispatch` inputs.
- Archived v2-alpha Ink CLI (`git tag archive/v2-alpha` in `/home/user/idea-harness`) — **reference only.** Verbs were right; Node runtime was retired deliberately. Phase 2 re-implements the verbs in Python.

## Verification

**Phase 1:**
- `launchctl list | grep openclaw` returns empty.
- `find ~/.claude/plans/specs -name idea.md | wc -l` matches pre-migration `ideas.jsonl` record count + new captures.
- A captured idea reaches `pr-open` end-to-end with `review-gauntlet.py` posting a PR comment.
- `/home/user/idea-harness/README.md` and `/home/user/LetsBarker/docs/orchestration-architecture.md` agree on what's canonical.

**Phase 2:**
- `harness ideas list --status brainstormed` from any terminal returns the expected set.
- From a Claude Code session in any repo, `/inflight` and `/idea-accept <slug>` work.
- `harness mcp serve` exposes verbs as MCP tools (verify with a Claude Code session listing MCP tools).
- `harness init-harness` in a fresh repo (e.g., a Rewilding clone) produces a working `.harness/config.json` after one prompt cycle.
- `harness reindex` rebuilds `~/.claude/plans/index.sqlite` from disk with no diff in `harness ideas list` output.

**Phase 3:**
- Expo mobile app on a phone shows the same queue as `harness ideas list`. Accept on phone → status flips in CLI within 2s.
- `worktree-runner.sh letsbarker some-slug` creates worktree, runs `bundle install` + `npm ci`, runs smoke, hands off to builder, runs evaluators on changed files only, merges results. Repeatable.
- A build that previously hung mid-session (no env installed) now completes because env install is scripted.

**Phase 4:**
- `harness ideas build <slug> --worker codespace` produces a PR with no Mac involvement after dispatch.
- File a GH Issue labeled `agent:ready` in LetsBarker → a PR appears 5–15 min later via the resurrected webhook.
- `harness reconcile` updates a `pr-open` idea to `shipped` after manual merge within one tick.

## Critical files index

| Path | Phase | Action |
|---|---|---|
| `/home/user/idea-harness/README.md` | 1 | Rewrite §Archive → §Migration |
| `/home/user/idea-harness/docs/openclaw-merge.md` | 1 | New |
| `/home/user/LetsBarker/docs/orchestration-architecture.md` | 1 | Redirect banner |
| `/home/user/LetsBarker/WORKFLOW.md`, `AGENTS.md` | 1 | Repoint to idea-harness |
| `~/.claude/skills/idea-harness/scripts/review-gauntlet.py` | 1 | New (ported from OpenClaw) |
| `~/.claude/skills/idea-harness/references/projects.yml` | 1 | Consolidate |
| `/home/user/idea-harness/cli/` | 2 | New Python package (Typer) |
| `~/.claude/commands/{idea-accept,idea-reject,idea-build,idea-search,harness-init}.md` | 2 | New slash commands |
| `~/.claude/skills/idea-harness/scripts/inflight.sh` | 2 | Shim to `harness ideas list` |
| `/home/user/idea-harness/apps/mobile/` | 3 | New Expo app |
| `~/.claude/skills/idea-harness/scripts/worktree-runner.sh` | 3 | New (the missing primitive) |
| `~/.claude/skills/idea-harness/scripts/build-accepted.py` | 3 | Refactor to delegate to worktree-runner |
| `/home/user/idea-harness/templates/repo/.harness/config.json` | 3, 4 | Schema extensions: `env_install`, `vcs.default_worker` |
| `/home/user/idea-harness/cli/harness/workers/` | 4 | New worker backends |
| `/home/user/LetsBarker/.github/workflows/agent-ready-trigger.yml` | 4 | Re-enable + retarget |
| `~/.claude/skills/idea-harness/scripts/reconcile.py` | 4 | New cron |

## Out of scope (explicit)

Multi-repo single ideas, semantic search / embeddings, analytics or impact tracking, Slack/email/iMessage capture, automated PR-review-comment-addressing loops, web UI, multi-tenant, third-party schedulers, alternative cloud vendors (Modal/Daytona/Railway-as-build-env). Each is a reasonable later increment but expanding scope now would resurrect the consolidation problem this plan is designed to end.

## Sequencing summary

| Phase | Duration | Key outcome | Cost of skipping |
|---|---|---|---|
| 1 — Consolidate | ~1 wk | One orchestrator, one state, one doc | Every later phase doubles |
| 2 — CLI + MCP + slash commands | ~1 wk | Real API surface; Claude Code drives the harness | UIs have nothing to talk to but markdown |
| 3 — Mobile app + worktree-runner | ~2 wks | Operator's UI ask + long-running becomes reliable | Stays on Remote Control only; long jobs stay flaky |
| 4 — Cloud workers + GH webhook | ~1 wk | Issues-as-capture; cloud builds opt-in | Mac must always be online |

Phase 1 alone delivers most of the "better sustained organization" ask, because **the confusion is the disorganization**.
