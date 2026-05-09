# Templates

Drop-in resources for setting up the idea-harness on a fresh Mac and onboarding new or existing projects. See [../README.md](../README.md) for the full setup guide.

## Layout

```
templates/
├── launchagents/            ← three .plist files for the harness LaunchAgents
│   ├── com.taylorpetrehn.idea-harness-harvest.plist     (every 60 s)
│   ├── com.taylorpetrehn.idea-harness-brainstorm.plist  (every 1 hr)
│   └── com.taylorpetrehn.idea-harness-escalate.plist    (every 10 min)
│
├── hooks/
│   └── safety-check.sh      ← global Write/Edit guard, install at ~/.claude/hooks/
│
├── commands/
│   └── inflight.md          ← /inflight slash command, install at ~/.claude/commands/
│
├── skill-scripts/           ← canonical script copies (mirror of
│   ├── harvest.py             ~/.claude/skills/idea-harness/scripts/)
│   ├── brainstorm-captured.py
│   ├── escalate-needs-detail.py
│   └── inflight.sh
│
└── repo/                    ← drop into target repos when onboarding
    ├── .harness/config.json   ← machine-readable per-repo config
    └── CLAUDE.md              ← human-readable conventions for the repo
```

## Quick install (fresh Mac)

```bash
# From a clone of this repo
cd ~/Projects/idea-harness

# 1. LaunchAgents (replace `taylorpetrehn` in the Label/HOME with your username)
mkdir -p ~/Library/LaunchAgents
for name in harvest brainstorm escalate; do
  cp templates/launchagents/com.taylorpetrehn.idea-harness-${name}.plist \
     ~/Library/LaunchAgents/
done

# 2. Global safety hook
mkdir -p ~/.claude/hooks
cp templates/hooks/safety-check.sh ~/.claude/hooks/safety-check.sh
chmod +x ~/.claude/hooks/safety-check.sh
# Then add it to ~/.claude/settings.json (see ../README.md Step 4)

# 3. Slash command
mkdir -p ~/.claude/commands
cp templates/commands/inflight.md ~/.claude/commands/inflight.md

# 4. Skill scripts (if ~/.claude/skills/idea-harness/scripts/ is empty)
mkdir -p ~/.claude/skills/idea-harness/scripts
cp templates/skill-scripts/* ~/.claude/skills/idea-harness/scripts/
chmod +x ~/.claude/skills/idea-harness/scripts/*.{sh,py}

# 5. Load the LaunchAgents
for name in harvest brainstorm escalate; do
  launchctl load ~/Library/LaunchAgents/com.taylorpetrehn.idea-harness-${name}.plist
done

launchctl list | grep idea-harness    # all three should be listed
```

The skill itself (SKILL.md, references/, templates/repo/) is more substantial — keep it in your dotfiles or copy from a working install. See [../README.md](../README.md#step-3-install-the-skill) for details.

## Onboarding a new repo

```bash
cd ~/Projects/myproject
cp -r ~/Projects/idea-harness/templates/repo/.harness .
cp ~/Projects/idea-harness/templates/repo/CLAUDE.md .
$EDITOR .harness/config.json     # update every field for this repo
```

Then add the project to `~/.claude/skills/idea-harness/references/projects.yml` and create per-project context at `~/.claude/skills/idea-harness/references/context/<name>/{product,decisions,conventions}.md`. See [../README.md](../README.md#onboarding-a-new-project) for the full procedure.

## Drift check

The files in `templates/` should mirror what's actually running on Taylor's Mac. To verify (or to refresh templates after changes):

```bash
cd ~/Projects/idea-harness

# LaunchAgents
diff -q templates/launchagents/com.taylorpetrehn.idea-harness-harvest.plist     ~/Library/LaunchAgents/com.taylorpetrehn.idea-harness-harvest.plist
diff -q templates/launchagents/com.taylorpetrehn.idea-harness-brainstorm.plist  ~/Library/LaunchAgents/com.taylorpetrehn.idea-harness-brainstorm.plist
diff -q templates/launchagents/com.taylorpetrehn.idea-harness-escalate.plist    ~/Library/LaunchAgents/com.taylorpetrehn.idea-harness-escalate.plist

# Hook
diff -q templates/hooks/safety-check.sh ~/.claude/hooks/safety-check.sh

# Slash command
diff -q templates/commands/inflight.md ~/.claude/commands/inflight.md

# Skill scripts
diff -q templates/skill-scripts/harvest.py              ~/.claude/skills/idea-harness/scripts/harvest.py
diff -q templates/skill-scripts/brainstorm-captured.py  ~/.claude/skills/idea-harness/scripts/brainstorm-captured.py
diff -q templates/skill-scripts/escalate-needs-detail.py ~/.claude/skills/idea-harness/scripts/escalate-needs-detail.py
diff -q templates/skill-scripts/inflight.sh             ~/.claude/skills/idea-harness/scripts/inflight.sh

# Per-repo template
diff -rq templates/repo ~/.claude/skills/idea-harness/templates/repo
```

Any divergence means either (a) you've improved the live config and should mirror back, or (b) you've changed templates and should propagate to the live install.
