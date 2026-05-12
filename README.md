# Idea Harness

An autonomous pipeline that turns half-formed thoughts captured on the go (Apple Reminders / Siri) into shipped pull requests across multiple projects, with a human in the loop only when judgment is actually needed.

```
Hey Siri, add to App Ideas
        │
        ▼
┌────────────────┐  60s  ┌─────────────────────┐  1 hr   ┌──────────────────┐
│ Apple Reminders│──────▶│ ~/.claude/plans/    │────────▶│ brainstorm +     │
│ (any device)   │       │ specs/<slug>/       │         │ critic gauntlet  │
└────────────────┘       │ idea.md             │         └────────┬─────────┘
                         └─────────────────────┘                  │
                                  ▲                               │
                                  │                               ▼
                                  │                       ┌───────────────┐
                                  │                       │ status:       │
                                  │                       │ brainstormed  │  awaits accept
                                  │                       │ needs-detail  │  10 min
                                  │                       └───────┬───────┘
                                  │                               │
                                  │                               ▼
                                  │                  ┌──────────────────────┐
                                  │                  │ Claude Remote        │
                                  └─ Edit lands ─────│ Control session on   │
                                     in idea.md      │ your phone           │
                                                     │ (push notification)  │
                                                     └──────────────────────┘
```

> **This repo's role changed in 2026-05.** It used to be a standalone Node CLI (`harness ...`) with an Ink dashboard; that was archived at tag `archive/v2-alpha`. The system now lives as a vanilla Claude Code skill at `~/.claude/skills/idea-harness/` plus three local LaunchAgents. **This repo is now the Mac launch workspace** for spawned Claude sessions and the canonical documentation home. It is not a runtime — nothing inside it executes except the `.claude/` hooks.

---

## Table of contents

- [What this gives you](#what-this-gives-you)
- [Architecture](#architecture)
- [The flow, in detail](#the-flow-in-detail)
- [Setting it up on a fresh Mac](#setting-it-up-on-a-fresh-mac)
- [Onboarding a new project](#onboarding-a-new-project)
- [Onboarding an existing project](#onboarding-an-existing-project)
- [Operations](#operations)
- [Reference](#reference)
- [Known gotchas](#known-gotchas)
- [Migration](#migration)

---

## What this gives you

A **single capture surface** (Siri/Reminders, ubiquitous across iPhone/Watch/CarPlay/HomePod/share-sheet) that flows into a **GAN-style evaluator loop** (a brainstormer that drafts variants, a fresh-context critic that grades the draft) and routes the result to **the right project** (LetsBarker, OpenClaw, Rewilding, …) using a keyword-matched registry.

When the loop produces a clean brainstorm, it goes into your queue (`/inflight`). When the loop produces an open question (`needs-detail`), it **opens a Claude Code Remote Control session on your phone** with the brainstorm pre-loaded — you tap the push notification, read the variants one-handed, type your decision, and the session writes the answer into `idea.md` and exits. From the desk, "accept this and build it" graduates accepted ideas into a PR in the target repo.

The whole thing runs autonomously between captures and decisions. You are needed only for capture, accept/reject judgment, and PR review.

---

## Architecture

Three tiers, each with a clean responsibility:

### Tier 0 — `~/.claude/` (you-the-person)

Cross-project intelligence, lives once on your Mac, applies everywhere.

| Path | Role |
|---|---|
| `~/.claude/skills/idea-harness/SKILL.md` | The operational skill. Defines the eight-step flow (reconcile → harvest → score → brainstorm → critic → sharpen → notify → build → watch). |
| `~/.claude/skills/idea-harness/references/` | Prompts, rubric, schema, projects.yml, per-project context. Loaded on demand by the skill. |
| `~/.claude/skills/idea-harness/scripts/` | `harvest.py`, `brainstorm-captured.py`, `escalate-needs-detail.py`, `inflight.sh`. |
| `~/.claude/skills/idea-harness/templates/repo/` | Drop-in templates for new projects (`.harness/config.json`, `CLAUDE.md`). |
| `~/.claude/commands/inflight.md` | The `/inflight` slash command. Backed by `scripts/inflight.sh`. |
| `~/.claude/plans/specs/<slug>/idea.md` | Per-idea state. Frontmatter is the only state. |
| `~/.claude/hooks/safety-check.sh` | Global Write/Edit guard. Reads each repo's `.harness/config.json:safety` if present, no-op otherwise. |

### Tier 1 — `<repo>/.harness/` and `<repo>/.claude/` (you-in-this-repo)

Per-repo machine-readable config and human-readable conventions. Stamped once when you onboard a project, edited as the project evolves.

| Path | Role |
|---|---|
| `<repo>/.harness/config.json` | Repo identity, vcs, stacks, commands, evidence patterns, safety guardrails. The single machine-readable source for tools and hooks operating on this repo. |
| `<repo>/CLAUDE.md` (or `<repo>/.claude/CLAUDE.md`) | Human-readable conventions — read at the start of every Claude session in this repo. Drop-in template provided. |
| `<repo>/.claude/hooks/` | Optional. Long-running-agent primitives (kill-switch, steer, verify-gate, track-read, commit-on-stop) for repos where Claude sessions iterate for hours. |
| `<repo>/.claude/agents/evaluator.md` | Optional. Fresh-context PR reviewer subagent. |
| `<repo>/.harness/.allow-once` | Created on demand by the operator to bypass `safety.require_human_review_when_touching` for one Edit. Auto-consumed. |

### Tier 2 — Local execution (LaunchAgents)

The cron, all on your Mac, all native macOS. No third-party schedulers, no cloud cron, no openclaw runtime.

| LaunchAgent | Cadence | What it does |
|---|---|---|
| `com.taylorpetrehn.idea-harness-harvest` | every **60 s** | Reads incomplete reminders from "App Ideas" via `osascript`, writes new `idea.md` files at `status: captured`, marks the source reminder complete. |
| `com.taylorpetrehn.idea-harness-brainstorm` | every **1 hr** | If any `idea.md` has `status: captured`, spawns one autonomous `claude --print` session that runs steps 2–5 of the skill (route, score, brainstorm, critic via fresh subagent, sharpen). |
| `com.taylorpetrehn.idea-harness-escalate` | every **10 min** | For each `idea.md` at `status: needs-detail` without an `escalated_at` timestamp, daemonizes a `claude --remote-control` session inside a pseudo-tty so it shows up on your phone, seeded with the brainstorm + open question. |
| `com.taylorpetrehn.idea-harness-build` | every **15 min** | For each `idea.md` at `status: brainstormed` (= accepted in this consolidated flow) without `do_not_build: true`, spawns one autonomous `claude --print` orchestrator that builds the oldest pending idea: validates handoff, pre-flight hygiene check, spawns a builder in the target repo, parses `PR_URL=<url>` from output, flips `status: pr-open`. One idea per tick to bound cost. |

---

## The flow, in detail

### 1. Capture (anywhere, anytime)

Add to the Reminders list named **App Ideas** by any path that syncs to iCloud:

- "Hey Siri, add 'X' to my App Ideas list" (iPhone, Watch, CarPlay, AirPods long-press, HomePod)
- iOS / iPadOS / macOS Reminders app
- Share sheet from Safari / Mail / anywhere

The body of the reminder is captured too — dictate any context, constraints, or links. You'll never lose it.

### 2. Harvest (≤ 60 s)

`harvest.py` runs every minute via launchd. For each incomplete reminder in "App Ideas":

1. Generate an 8-char hex id, slug from the title.
2. Skip if a matching slug is already on disk (dedup by stem).
3. Write `~/.claude/plans/specs/<slug>/idea.md` with frontmatter `status: captured`.
4. Mark the source reminder complete (so it disappears from your list — you have proof it was tracked).

Robust against Reminders.app hangs (15 s AppleScript timeout + 20 s subprocess timeout). Timeouts are soft — they just skip this tick and try again next minute.

### 3. Brainstorm + critic (≤ 1 hr)

`brainstorm-captured.py` runs hourly via launchd. If any captured ideas exist, spawns one `claude --print` session that:

1. **Routes** each captured idea to a project via `references/projects.yml` keyword matching. Skips projects whose `references/context/<name>/product.md` is still a stub.
2. **Scores** on five dimensions (clarity, scope, pattern, risk, autonomy → 5–15 total).
3. **Brainstorms** following the eight-section structure in `references/brainstorm-output.md`. Reads the matched project's `product.md` + `decisions.md` as Tier 1 context, optionally reads codebase files (Tier 2, capped at 3 per idea).
4. **Critiques** by spawning a fresh subagent (Agent tool, general-purpose) with `references/critic-rubric.md`. Subagent returns JSON to `spec-eval.json`.
5. **Applies the verdict:**
   - `pass` → `status: brainstormed` (waits for your accept/reject)
   - `revise` → one revision attempt with critic feedback, then re-critique
   - `escalate` → `status: needs-critic-review` (you see it, decide if the brainstormer was just confused)
   - brainstorm verdict `needs-more-thought` → sharpener appends a single clarifying question as `## Open Question`, status moves to `needs-detail`

Notification (`ntfy.sh/taylor-barker`) only fires if anything moved into a state you'd care about. Empty ticks are silent.

### 4. Escalate to phone (≤ 10 min)

`escalate-needs-detail.py` runs every 10 min. For each `needs-detail` idea without an `escalated_at` stamp:

1. Mark `escalated_at: <now>` (idempotency — never spawns duplicate sessions for the same idea).
2. Double-fork into a daemon, allocate a pseudo-tty via Python's `pty.spawn`, exec `claude --remote-control idea/<short-name>` inside it with the brainstorm + open question seeded as the first user turn.

The pty is **load-bearing** — without it, Claude detects "non-TTY" and runs as `--print`, exiting immediately and never registering with Remote Control. See [Known gotchas](#known-gotchas).

The session uses `--permission-mode bypassPermissions` and instructs Claude to use a single `Edit` call to update both the body and the frontmatter — avoids the double-prompt UX that `acceptEdits` produced when frontmatter changes wanted Bash.

Push notification fires on your phone (Claude Code's built-in "needs a decision" trigger, requires v2.1.110+ and `agentPushNotifEnabled: true` in user settings). You tap, read, type a decision. Claude writes `## Decision`, flips `status: brainstormed`, exits. The session disappears from your phone.

### 5. Build (≤ 15 min, autonomous)

`build-accepted.py` runs every 15 min. For the OLDEST `brainstormed` idea without `do_not_build: true`:

1. Validate handoff (per `references/handoff-to-build.md`): all required frontmatter, brainstorm body has the chosen variant marked.
2. Resolve the project from `projects.yml`. Skip if the project's `product.md` is still a stub.
3. Pre-build hygiene: `git status --porcelain` in `local_path` must be empty.
4. Set `status: building`, bump `last_touched`.
5. Spawn the builder in the target repo (or its worktree if `uses_worktrees: true`) seeded with the brainstorm body + chosen variant + `simplicity-rules.md` + `branch-hygiene.md` + project conventions + bot identity setup. The builder implements on a feature branch, runs the project's tests, commits, pushes, runs `gh pr create`, prints `PR_URL=<url>`.
6. Parse `PR_URL`. On success: `status: pr-open`, `github_pr` set, `## PR` section appended to idea body. On failure: revert to `brainstormed` with a `## Notes` entry pointing at the build log.
7. Send one ntfy notification: `built {title}: <pr_url>` on success, or `build FAILED for {title}` on failure.

**Brainstormed = accepted in this flow.** No separate human-approve step. The brainstormer's score+route gates auth/payments/migrations to `needs-critic-review` BEFORE they reach `brainstormed`, so the autonomy is bounded. To stop a specific brainstormed idea from auto-building, set `status: rejected` (kills it) or add `do_not_build: true` to its frontmatter (pauses it).

One build per tick. If three ideas are brainstormed at the same time, they ship across three ticks (≤ 45 min for the batch). This caps cost per tick and avoids worktree contention.

### 6. Watch (Step 8 of the skill)

The build orchestrator's first action on each tick is reconcile: query `gh pr view` for any idea at `pr-open`, update status (`shipped` on merge, `rejected` on close, leave alone on change-requests). Eventually, this could re-spawn a builder to address review comments — for now, reviewing your own bot's PRs is a manual step.

---

## Setting it up on a fresh Mac

### Prerequisites

- macOS (Apple Reminders + iCloud Drive)
- Python 3 (preinstalled on macOS 13+)
- [Claude Code CLI](https://code.claude.com/docs) installed and logged in (`claude /login`)
- Claude Code **v2.1.110 or newer** (Remote Control requires it)
- A Reminders list named exactly **App Ideas** (create one if needed)
- iCloud sync enabled for Reminders

### Step 1: Clone this repo as your launch workspace

```bash
git clone https://github.com/taylorpetrehn/idea-harness.git ~/Projects/idea-harness
cd ~/Projects/idea-harness
```

This directory becomes your Mac launch workspace. The `.claude/hooks/` here are what spawned Claude sessions inherit when they `cd` here at startup.

### Step 2: Approve the workspace (one-time)

```bash
cd ~/Projects/idea-harness
claude
# Accept the workspace trust dialog when prompted
# Then /quit immediately — that's the only purpose of this run
```

Cron-spawned sessions auto-skip the trust dialog (non-TTY context) but the explicit one-time approval is the documented best-practice path.

### Step 3: Install the skill

The skill itself ships at `~/.claude/skills/idea-harness/`. If you maintain `~/.claude/` in version control, the skill is already there. If not, copy or symlink it from your authoritative source — the skill is currently authored in this repo's owner's dotfiles.

```bash
mkdir -p ~/.claude/skills
# Either copy or symlink:
# cp -R <source>/idea-harness ~/.claude/skills/idea-harness
# ln -s <source>/idea-harness ~/.claude/skills/idea-harness
```

### Step 4: Install the global safety hook

```bash
cp ~/.claude/skills/idea-harness/templates/repo/.claude/hooks/safety-check.sh ~/.claude/hooks/safety-check.sh 2>/dev/null \
  || cp ~/Projects/idea-harness/.claude/hooks/safety-check.sh ~/.claude/hooks/safety-check.sh
chmod +x ~/.claude/hooks/safety-check.sh
```

Add it to `~/.claude/settings.json` under `hooks.PreToolUse`:

```json
{
  "matcher": "Write|Edit",
  "hooks": [
    { "type": "command", "command": "$HOME/.claude/hooks/safety-check.sh" }
  ]
}
```

The hook is a **no-op** if a project has no `.harness/config.json` or no `safety` block. Safe to install globally.

### Step 5: Install the LaunchAgents

```bash
mkdir -p ~/.claude/skills/idea-harness/logs
mkdir -p ~/.claude/plans/specs
mkdir -p ~/Library/LaunchAgents

# Each plist (harvest, brainstorm, escalate). Replace `taylorpetrehn` in
# the Label and HOME values with your username.
for name in harvest brainstorm escalate; do
  cp templates/launchagents/com.taylorpetrehn.idea-harness-${name}.plist \
     ~/Library/LaunchAgents/
  launchctl load ~/Library/LaunchAgents/com.taylorpetrehn.idea-harness-${name}.plist
done

launchctl list | grep idea-harness  # should show all three
```

(If `templates/launchagents/` doesn't exist in your clone, the canonical plists live at `~/Library/LaunchAgents/` on the original machine; copy them into this repo's `templates/launchagents/` to bootstrap a new Mac.)

### Step 6: Grant Reminders automation permission

The first time `harvest.py` runs, macOS may pop an Automation prompt asking if `python3` (or `osascript`) can control Reminders. Approve it. If you missed the prompt, grant it manually:

**System Settings → Privacy & Security → Automation → python3 → Reminders** (toggle on).

### Step 7: Smoke test

```bash
# Dictate "Hey Siri, add 'smoke test' to App Ideas"
# Wait 60 s
~/.claude/skills/idea-harness/scripts/inflight.sh
# Should show one captured idea
```

### Step 8: Configure push notifications

In Claude Code: `/config` → enable **"Push when Claude decides"**. You'll need the Claude mobile app installed and signed in to the same account as `claude /login`.

You're set. Capture an idea on the way home; come back to a brainstormed queue.

---

## Onboarding a new project

Onboarding means: **stamp `.harness/config.json` + a `CLAUDE.md` template into the repo, and add the project to the routing registry.**

### Step 1: Add the project to the registry

Edit `~/.claude/skills/idea-harness/references/projects.yml` and add a new entry:

```yaml
projects:
  myproject:
    github_repo: "you/myproject"
    local_path: "~/Projects/myproject"
    base_branch: "main"
    bot_name: "you"
    bot_email: "you@users.noreply.github.com"
    bot_pat_file: "~/.secrets/myproject-bot-pat"
    spec_location: "specs/{date}-{slug}/spec.md"
    worktree_pattern: "../myproject-wt-{slug}"
    uses_worktrees: true
    conventions_path: "references/context/myproject/conventions.md"
    test_command: "npm test"
    keywords:
      - keyword1
      - keyword2
      # …
```

Pick keywords carefully — they're how the brainstormer auto-routes captured ideas to this project. If multiple projects match, highest hit count wins; if zero match, the idea goes to `needs-detail` with a "which project?" question.

### Step 2: Create per-project context

```bash
mkdir -p ~/.claude/skills/idea-harness/references/context/myproject
cd ~/.claude/skills/idea-harness/references/context/myproject

# Three files. Bigger projects warrant more detail; keep each ~1500 tokens.
touch product.md decisions.md conventions.md
```

- **`product.md`** — what the product is, the stack, surface areas, current focus, how to think about ideas in this context. Read by the brainstormer as Tier 1 on every brainstorm. **Until this contains a real description (not the literal word "STUB"), the brainstormer routes ideas for this project to `needs-detail`.**
- **`decisions.md`** — append-only ledger of conscious non-choices ("we don't do X because Y"). Lets the brainstormer reject ideas that re-litigate settled questions.
- **`conventions.md`** — repo coding conventions, injected into builder spawn prompts.

Use `~/.claude/skills/idea-harness/references/context/letsbarker/` as a reference shape.

### Step 3: Add the project to `brainstorm-captured.py`'s `PROJECT_PATHS`

Open `~/.claude/skills/idea-harness/scripts/brainstorm-captured.py`, find `PROJECT_PATHS`, and add the repo's `local_path`. The brainstormer needs `--add-dir` access to read codebase files for Tier 2 footprint checks.

### Step 4: Stamp the repo

```bash
cd ~/Projects/myproject
cp -r ~/.claude/skills/idea-harness/templates/repo/.harness .
cp ~/.claude/skills/idea-harness/templates/repo/CLAUDE.md .
```

### Step 5: Edit `.harness/config.json`

The template is filled in for LetsBarker — change everything that's project-specific. The `CLAUDE.md` you just dropped contains a "First-time setup" callout listing the fields to update.

Required fields (everything else is optional):

- `name` — must match the key in `projects.yml`
- `identity.github_repo` — `owner/name` form
- `identity.local_path` — absolute path
- `vcs.base_branch` — typically `main`, sometimes `develop` / `preview`
- `commands.smoke` — must be cheap (≤ 1 s); used by long-running sessions to confirm a clean tree
- `commands.test_*` and `commands.lint` — actual shell commands for this repo
- `evidence.evaluators[]` — one entry per stack with `key`, `command`, `when_touched` glob

Example for a simple Python project:

```json
{
  "name": "myproject",
  "identity": { "github_repo": "you/myproject", "local_path": "~/Projects/myproject" },
  "vcs": { "base_branch": "main", "branch_pattern": "idea/{slug-stub}-{id4}", "uses_worktrees": false,
           "bot": { "name": "you", "email": "you@users.noreply.github.com",
                    "pat_file": "~/.secrets/myproject-bot-pat" } },
  "stacks": ["python"],
  "commands": {
    "smoke": "python -c 'import myproject; print(\"ok\")'",
    "test":  "pytest",
    "lint":  "ruff check .",
    "dev_server": "python -m myproject"
  },
  "evidence": {
    "results_file": ".harness/results.json",
    "evidence_patterns": ["tmp/screenshots/**/*.png", ".harness/results-*.json"],
    "evaluators": [
      { "key": "python", "command": "pytest --json-report --json-report-file=.harness/results-python.json",
        "when_touched": ["src/**", "tests/**"] }
    ]
  }
}
```

`safety` is entirely optional — leave it out unless you have specific guardrails to enforce. A good first list:

```json
"safety": {
  "must_not_touch": [".env", "secrets/**"],
  "never_force_push_branches": ["main"]
}
```

### Step 6: Verify

Run `claude` in the new repo once interactively to approve workspace trust:

```bash
cd ~/Projects/myproject
claude
# /quit immediately
```

Capture a test idea via Siri ("add 'test for myproject feature' to App Ideas"). Within ~60 s + 1 hr, it should land in `/inflight` routed to `myproject`. If it routes to `needs-detail` with "wrong project" or "stubbed product context," your keywords or `product.md` need work.

---

## Onboarding an existing project

Most projects you're considering already have *some* `.claude/` content (CLAUDE.md, hooks, agents, settings.json) and possibly conflicting tooling. Walk through this list:

### 1. Adopt without conflict

```bash
cd ~/Projects/existing-project
mkdir -p .harness
cp ~/.claude/skills/idea-harness/templates/repo/.harness/config.json .harness/config.json
```

`.harness/` is new — won't collide with anything. **Don't** overwrite an existing `CLAUDE.md`. Instead, append a section pointing at the harness:

```markdown
## Harness conventions

This repo is wired into the idea-harness pipeline. The machine-readable shape lives at `.harness/config.json`. When working in this repo, read it at the start of every session along with whatever conventions you usually follow here.

If you're an autonomous agent spawned by the harness's escalate or build flow:
- Read `.harness/config.json` for stacks, commands, evidence patterns, safety guardrails.
- Read `~/.claude/skills/idea-harness/references/context/{name}/conventions.md` for project conventions, where `{name}` is `.harness/config.json:name`.
- Use the Edit tool for `idea.md` modifications when invoked via escalate.
```

### 2. Reconcile hooks

If the repo already has `.claude/hooks/`, you have two cohabitation options:

- **Keep what's there**, add the harness primitives only if the existing hooks are absent or weaker. The cwc-long-running-agents primitives (kill-switch, steer, verify-gate, track-read, commit-on-stop) compose cleanly with most other hook setups.
- **Layer them** by including both in `.claude/settings.json`'s `PreToolUse` array. Hooks run in order; first one that returns `block` wins.

### 3. Add the project to the registry + brainstormer access list

Same as for new projects: edit `projects.yml`, create `references/context/<name>/{product,decisions,conventions}.md`, add the local path to `brainstorm-captured.py`'s `PROJECT_PATHS`. **Don't stub the context files** — write real content immediately, otherwise the brainstormer routes every idea to `needs-detail`.

### 4. Edit `.harness/config.json`

Change everything to match the existing repo. Pay particular attention to:

- `vcs.base_branch` — match the repo's actual default branch (often `main`, sometimes `develop`/`preview`/`trunk`).
- `vcs.uses_worktrees` — set to `true` only if you have a worktree workflow established. Otherwise builds happen on a feature branch in the main checkout.
- `commands.smoke` — pick something genuinely cheap that exercises the build system (Rails: `bin/rails runner 'puts 1'`; Node: `node -e 'console.log(1)'`; Python: `python -c 'print(1)'`). Long-running sessions run it on every restart.
- `safety.must_not_touch` — be liberal here for repos with any production exposure. The hook is a no-op if the field is empty, but it's free protection if you fill it in.

### 5. Verify

Same as for new projects. Capture a test idea, watch it route correctly.

---

## Operations

### What's running?

```bash
# All idea-harness LaunchAgents
launchctl list | grep idea-harness

# Their cadences
for plist in ~/Library/LaunchAgents/com.taylorpetrehn.idea-harness-*.plist; do
  label=$(plutil -extract Label raw "$plist")
  interval=$(plutil -extract StartInterval raw "$plist")
  printf "  %-50s every %ss\n" "$label" "$interval"
done

# In-flight ideas
harness ideas list                    # canonical (CLI; see "CLI + MCP" below)
~/.claude/skills/idea-harness/scripts/inflight.sh  # shim — defers to `harness` if installed
# or, from any Claude Code session:
/inflight
```

### CLI + MCP

Phase 2 of the bridge plan added a Python CLI at [cli/](cli/) that wraps
`idea.md` frontmatter in first-class verbs. Install:

```bash
pip install -e cli/
# now `harness` is on PATH
```

The CLI is dependency-free (stdlib only) and exposes:

| Verb | Purpose |
|---|---|
| `harness ideas list [--status X] [--project Y] [--score-gte N] [--json]` | Same output as `/inflight`. |
| `harness ideas show <slug> [--json]` | Frontmatter + body for one idea. |
| `harness ideas accept <slug>` / `reject <slug>` / `reroute <slug> <project>` | Mutate state. Atomic write of `idea.md`. |
| `harness ideas brainstorm <slug>` / `build <slug>` | Manual trigger of `brainstorm-captured.py` / `build-accepted.py` for one slug. Skips the cron wait. |
| `harness capture "<title>" [--project X] [--notes ...]` | Capture an idea without going through Reminders. |
| `harness init-harness [<repo-path>] [--apply]` | Scaffold `.harness/config.json` + `CLAUDE.md` in a repo. Defaults to dry-run; introspects stacks. |
| `harness reindex` | Rebuild `~/.claude/plans/index.sqlite` from disk. Cheap; safe to run anytime. |
| `harness reconcile [--dry-run]` | Poll `pr-open` ideas, update status from GitHub (merged → shipped, closed → rejected, change-requests → note). |
| `harness mcp serve` | JSON-RPC 2.0 stdio MCP server. Same verbs as MCP tools. |

The filesystem (`~/.claude/plans/specs/<slug>/idea.md`) stays canonical;
the CLI just makes the verbs first-class. The SQLite index is a derived
cache, rebuildable from disk.

To expose the verbs to Claude Code as MCP tools, add to `~/.claude/.mcp.json`:

```json
{
  "mcpServers": {
    "idea-harness": { "command": "harness", "args": ["mcp", "serve"] }
  }
}
```

Slash commands at [templates/commands/](templates/commands/) wrap the CLI:

- `/inflight` → `harness ideas list`
- `/idea-accept <slug>`, `/idea-reject <slug>`, `/idea-build <slug>`
- `/idea-search [filters]` — passthrough to `harness ideas list`
- `/harness-init [<path>]` → `harness init-harness`

### Tail the logs

```bash
# Capture (most-frequent, most-noisy)
tail -f ~/.claude/skills/idea-harness/logs/harvest.log

# Brainstorm (one entry per hour-tick where work happened)
tail -f ~/.claude/skills/idea-harness/logs/brainstorm.log

# Escalate (one entry per needs-detail spawn)
tail -f ~/.claude/skills/idea-harness/logs/escalate.log

# Per-idea escalation log (for the spawned RC session)
tail -f ~/.claude/plans/specs/<slug>/.escalation.log
```

### Force a tick now (don't wait for the cadence)

```bash
launchctl kickstart -k gui/$(id -u)/com.taylorpetrehn.idea-harness-harvest
launchctl kickstart -k gui/$(id -u)/com.taylorpetrehn.idea-harness-brainstorm
launchctl kickstart -k gui/$(id -u)/com.taylorpetrehn.idea-harness-escalate
```

### Disable / re-enable

```bash
# Temporary off (until reload or reboot)
launchctl unload ~/Library/LaunchAgents/com.taylorpetrehn.idea-harness-harvest.plist

# Permanent off (file removed)
launchctl unload ~/Library/LaunchAgents/com.taylorpetrehn.idea-harness-harvest.plist
rm ~/Library/LaunchAgents/com.taylorpetrehn.idea-harness-harvest.plist

# Re-enable
launchctl load ~/Library/LaunchAgents/com.taylorpetrehn.idea-harness-harvest.plist
```

Disable all three to fully pause the pipeline; capture-stop without affecting reminders. Re-enable in any order.

### Override or pause for a single idea

If the harness is going wild on a single idea (looping, mis-routing, etc.), edit its `idea.md` frontmatter directly:

```yaml
status: rejected   # take it out of every flow
# or
status: needs-detail
escalated_at: 2099-01-01T00:00:00Z   # arbitrary far-future timestamp
                                      # ⇒ never re-escalates
```

### Manual escalate of a single idea

```bash
# Clear the escalated_at marker, then run the script
python3 - <<'PY'
import re
from pathlib import Path
slug = "your-slug-here"
p = Path.home() / f".claude/plans/specs/{slug}/idea.md"
text = p.read_text()
text = re.sub(r"^escalated_at:.*$", "escalated_at: ~", text, count=1, flags=re.MULTILINE)
p.write_text(text)
PY
~/.claude/skills/idea-harness/scripts/escalate-needs-detail.py
```

### Manual harvest of a Reminder

```bash
python3 ~/.claude/skills/idea-harness/scripts/harvest.py
# add --dry-run to preview without writing
```

### Operator controls (per-repo, when a long-running session is active)

These come from the cwc-long-running-agents primitives in `.claude/hooks/`:

| Action | Command |
|---|---|
| Halt the agent immediately | `touch AGENT_STOP` (in repo root) |
| Resume | `rm AGENT_STOP` |
| Steer the agent mid-run | `echo "your steering note" > STEER.md` (surfaced once, then auto-cleared) |
| Bypass `safety.require_human_review` once | `mkdir -p .harness && touch .harness/.allow-once` |

---

## Reference

### Frontmatter schema (idea.md)

```yaml
---
id: <8-char hex>                                # generated at harvest
title: "<verbatim from source>"
slug: <kebab-title>-<id-prefix>                 # title up to 50 chars + 4-char hex
status: captured                                # see status flow below
source: reminders | conversation | feedback | coding
project: <name from projects.yml> | ~           # null until routed
score: <int 5-15> | ~                           # set at score+route
captured_at: <ISO 8601 UTC>
brainstormed_at: <ISO 8601> | ~
decided_at: <ISO 8601> | ~
critic_verdict: pass | revise | escalate | ~
github_issue: <url> | ~
github_pr: <url> | ~
loop_count: <int>                               # # of needs-more-thought cycles
escalated_at: <ISO 8601> | ~                    # set when RC session spawned
last_touched: <ISO 8601 UTC>                    # bumped on any change
---
```

### Status flow

```
                 [harvest]
                    ↓
                 captured
                    ↓ [brainstorm cron]
                    ↓ [route + score + brainstorm + critic]
              brainstormed ─────► needs-critic-review
                    ↓
            [Taylor reacts]
            ↓       ↓        ↓
        accepted  rejected  needs-detail (loop_count++)
            ↓                    ↓
         [build]            [escalate cron]
            ↓                    ↓
         building              Claude RC on phone
            ↓                    ↓
         pr-open              ## Decision written
            ↓ [PR merged]    ↓ status → brainstormed
         shipped
```

### `.harness/config.json` schema

```json
{
  "name": "<project-name>",                      // required, matches projects.yml key
  "identity": {
    "github_repo": "owner/name",                 // required
    "local_path": "~/path/to/repo"               // required
  },
  "vcs": {
    "base_branch": "main",                       // required
    "branch_pattern": "idea/{slug-stub}-{id4}",  // required
    "uses_worktrees": true,                      // required (boolean)
    "worktree_pattern": "../repo-wt-{slug}",     // required if uses_worktrees
    "bot": {
      "name": "...", "email": "...",             // required
      "pat_file": "~/.secrets/foo-pat"           // required if pushing as bot
    }
  },
  "stacks": ["rails", "expo", "vite"],           // required, declared not detected
  "commands": {
    "smoke": "...",                              // required, cheap (≤ 1 s)
    "test_<stack>": "...",                       // one per stack
    "lint": "...",                               // optional but recommended
    "dev_server": "..."                          // optional
  },
  "evidence": {
    "results_file": ".harness/results.json",     // path verify-gate watches
    "evidence_patterns": ["tmp/**/*.png", "..."], // what counts as proof
    "evaluators": [
      { "key": "<stack>", "command": "...",
        "when_touched": ["src/**", "..."] }
    ]
  },
  "safety": {                                    // entirely optional
    "must_not_touch": ["..."],                   // hard block at Write/Edit hook
    "require_human_review_when_touching": ["..."], // soft block; bypass with .allow-once
    "never_force_push_branches": ["main"],       // declarative; enforced by builder spawn
    "always_label_pr": ["agent:needs-review"]    // declarative; enforced by builder spawn
  }
}
```

### File-system overview

```
~/.claude/                                       (Tier 0 — cross-project)
├── skills/idea-harness/
│   ├── SKILL.md                                 ← operational doc
│   ├── references/
│   │   ├── projects.yml                         ← project routing registry
│   │   ├── brainstorm-output.md                 ← brainstormer contract
│   │   ├── critic-rubric.md                     ← critic's 8 checks
│   │   ├── handoff-to-build.md                  ← what an accepted idea must contain
│   │   ├── context-budget.md                    ← Tier 1/2/3 token caps
│   │   ├── simplicity-rules.md                  ← injected into builder spawns
│   │   ├── branch-hygiene.md                    ← branch + PR rules
│   │   ├── idea-schema.md                       ← idea.md frontmatter spec
│   │   └── context/<project>/{product,decisions,conventions}.md
│   ├── scripts/
│   │   ├── harvest.py                           ← Reminders → idea.md
│   │   ├── brainstorm-captured.py               ← captured → brainstormed
│   │   ├── escalate-needs-detail.py             ← needs-detail → phone (pty.spawn)
│   │   └── inflight.sh                          ← /inflight slash command backend
│   └── templates/repo/                          ← drop-in for new projects
│       ├── .harness/config.json
│       └── CLAUDE.md
├── commands/inflight.md                         ← /inflight definition
├── plans/specs/<slug>/idea.md                   ← per-idea state
└── hooks/safety-check.sh                        ← global Write/Edit guard

~/Library/LaunchAgents/                          (Tier 2 — execution)
├── com.taylorpetrehn.idea-harness-harvest.plist     (60 s)
├── com.taylorpetrehn.idea-harness-brainstorm.plist  (1 hr)
└── com.taylorpetrehn.idea-harness-escalate.plist    (10 min)

~/Projects/idea-harness/                         (this repo, Mac launch workspace)
├── README.md                                    ← what you're reading
├── CLAUDE.md                                    ← conventions for spawned sessions here
└── .claude/
    ├── settings.json                            ← hooks for sessions launched here
    ├── hooks/                                   ← cwc primitives
    │   ├── kill-switch.sh
    │   ├── steer.sh
    │   ├── verify-gate.sh
    │   ├── track-read.sh
    │   └── commit-on-stop.sh
    └── agents/evaluator.md                      ← fresh-context PR reviewer

<your-target-repos>/                             (Tier 1 — onboarded projects)
├── .harness/config.json                         ← machine-readable shape
├── CLAUDE.md (or .claude/CLAUDE.md)             ← human-readable conventions
└── .claude/                                     ← optional, hooks/agents per repo
```

---

## Known gotchas

| Gotcha | Fix |
|---|---|
| **Reminders.app hangs occasionally** (returns AppleEvent timeout -1712). Symptom: harvester logs "no incomplete reminders" repeatedly even when reminders exist. | Quit and relaunch Reminders.app, wait ~8 s for iCloud sync to settle. The harvester has 15 s/20 s timeouts; it'll recover automatically once Reminders responds again. |
| **Cron-spawned `claude --remote-control` exits immediately**, never appears on phone. | The session needs a pseudo-tty. The `escalate-needs-detail.py` script handles this via Python's `pty.spawn` inside a double-forked daemon. The macOS `script -q /dev/null` wrapper does NOT work in launchd context (no controlling tty in the parent). |
| **Double permission prompts when locking in a decision on phone.** | The escalate script uses `--permission-mode bypassPermissions` and instructs Claude to use a single Edit-tool call (not Bash sed). If you tweak the seed prompt, keep these constraints. |
| **`harvest.py` writes "missing value" in the body section.** | AppleScript returns the literal string "missing value" when a reminder has no body. The current script filters this out. If you see it appearing, you're on an old version. |
| **`status: needs-detail` idea won't re-escalate after you clear it.** | The `escalated_at` field is the dedup marker. Clear it (set to `~`) and the next escalate tick will spawn a fresh session. |
| **Brainstorm cron fires but does nothing.** | If no `idea.md` has `status: captured`, the script silently exits. Check `/inflight`. |
| **iOS Claude app shows nothing.** | (1) Confirm `claude --version` ≥ 2.1.110 on Mac. (2) `/config` → "Push when Claude decides" must be on. (3) Mobile app must be signed in to the same claude.ai account as `claude /login` on Mac. (4) The Mac must stay online (RC has a 10-min network timeout). |
| **TCC Automation prompt for python3 → Reminders.** | First-run prompt; if missed, grant via System Settings → Privacy & Security → Automation → python3 → Reminders. |
| **Workspace trust dialog blocks cron.** | Auto-skipped in non-TTY contexts (`-p`/`--print` mode or redirected stdout). For long-running interactive sessions, run `claude` once interactively in the dir to pre-approve. |

---

## Migration

Two distinct consolidations brought the current single-orchestrator design
into existence. Both are complete; this section is the breadcrumb trail.

### 2026-05-07 — Node CLI → Claude skill (`archive/v2-alpha`)

The earlier standalone Node CLI (Ink dashboard, `harness brainstorm` /
`harness ship` / `harness build` verbs, an `ideas/` folder under this repo,
contracts/agents in TypeScript) was archived at tag `archive/v2-alpha`. The
brainstorm/critic IP, `simplicity-rules.md`, `projects.yml`, and
`branch-hygiene.md` were ported into the canonical skill at
`~/.claude/skills/idea-harness/`. The Ink dashboard, runs ledger,
contracts package, and `npm link`-ed binary were retired in favor of the
filesystem-as-state design described above.

To poke around in the old code:

```bash
cd ~/Projects/idea-harness
git checkout archive/v2-alpha
# /inflight on the new system still works in parallel.
git checkout main   # back to the current world
```

The tag is on origin. Restoring the CLI binary requires `npm install &&
npm link` from the archived state.

### 2026-05-11 — OpenClaw `idea-pipeline` → idea-harness

The OpenClaw runtime at `~/.openclaw/` previously hosted a parallel
`idea-pipeline` skill (state in `ideas.jsonl`, cron + webhook trigger,
four-reviewer gauntlet, runtime evaluator). The bridge plan at
[docs/bridge-plan.md](docs/bridge-plan.md) called for collapsing both
orchestrators into idea-harness. This phase did that:

- **Review gauntlet ported** — OpenClaw's 4-reviewer gauntlet
  (spec-fidelity, codebase-patterns, risk, ux) is now
  [templates/skill-scripts/review-gauntlet.py](templates/skill-scripts/review-gauntlet.py)
  with rubrics in
  [templates/skill-scripts/review-rubrics/](templates/skill-scripts/review-rubrics/).
  `build-accepted.py` invokes it after `PR_URL=` is parsed.
- **Projects registry consolidated** — the canonical
  `~/.claude/skills/idea-harness/references/projects.yml` already covers
  every project OpenClaw routed to (LetsBarker, OpenClaw, Rewilding) plus
  Tooter, which OpenClaw never had. No re-merge needed.
- **Historical ideas archived** —
  [templates/skill-scripts/migrate-from-openclaw.py](templates/skill-scripts/migrate-from-openclaw.py)
  reads `~/.openclaw/workspace-bonnie/data/idea-pipeline/ideas.jsonl`,
  emits a summary ledger at
  `~/.claude/skills/idea-harness/logs/openclaw-migration.json`, and ports
  any non-terminal records as fresh `idea.md` files. Idempotent — safe to
  re-run. Defaults to `--dry-run`.
- **OpenClaw cron disabled** —
  [templates/skill-scripts/openclaw-disable.sh](templates/skill-scripts/openclaw-disable.sh)
  unloads any remaining `~/Library/LaunchAgents/com.openclaw.*` /
  `*idea-pipeline*` plists. Run after the merge PR lands.
- **LetsBarker doc redirect** — a sibling PR in the LetsBarker repo will
  swap `docs/orchestration-architecture.md`, `WORKFLOW.md`, and
  `AGENTS.md` to point at idea-harness rather than OpenClaw. That change
  cannot land in this repo; see
  [docs/letsbarker-redirect-patch.md](docs/letsbarker-redirect-patch.md)
  for the exact diff to apply.

See [docs/openclaw-merge.md](docs/openclaw-merge.md) for the full
move/dies/already-done/deferred breakdown, verification gates, and
rollback procedure. The `~/.openclaw/` directory is left intact for one
rollback cycle.

---

## License

MIT (the v2-alpha was Apache-2.0 with attribution; the harness primitives copied from `anthropics/cwc-long-running-agents` retain their Apache-2.0 + Anthropic copyright; everything in this repo at `main` is MIT unless otherwise noted).
