/**
 * scripts/agents/builder.ts
 *
 * L6: Build. Takes an accepted idea and produces a real PR.
 *
 * Design (per Taylor): the brainstorm IS the spec. Don't add a specifier
 * agent. Spawn a Claude CLI session inside the target repo's working
 * directory, hand it the brainstorm body, point it at the chosen variant,
 * and let it plan/implement/test/PR end-to-end.
 *
 * What the builder does:
 *   1. Resolve the target repo from frontmatter `project` → projects.yml.
 *   2. Pick a branch name: idea/<slug-stub>-<id4>.
 *   3. Compose a prompt that tells Claude Code to explore, implement on
 *      that branch, run tests, push, and open a PR with `gh pr create`.
 *   4. Spawn `claude --print` with cwd = repo, capture output.
 *   5. Parse `PR_URL=...` from the response.
 *   6. Update idea frontmatter: status → pr-open, github_pr set.
 *   7. Append a `## PR` section to the idea body.
 *
 * Modes (IDEA_HARNESS_BUILDER):
 *   - "live"    (default): spawn claude in the repo, do the real build.
 *   - "offline": don't spawn; produce a fake PR URL for tests/dry runs.
 *   - "dry"    : print the prompt and the resolved settings, then exit
 *                without spawning. Lets you eyeball what would be sent.
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { spawn } from "child_process";
import { Run, writeRunArtifact } from "../lib/runs";
import { loadProjects, ProjectConfig } from "../lib/projects";
import { setStatusInFile, IdeaSummary, listIdeas, appendNote } from "../lib/ideas";
import { prepareWorktree } from "../lib/worktree";
import { log } from "../lib/log";

const IDEAS_DIR = path.join(__dirname, "..", "..", "ideas");

export interface BuildResult {
  slug: string;
  status: "pr-open" | "failed" | "dry";
  branch: string;
  base_branch: string;
  worktree_path: string | null;
  pr_url: string | null;
  durationMs: number;
  exitCode: number;
  stdoutTail: string;
  stderrTail: string;
}

export interface BuildOptions {
  /** Override the variant choice. Falls back to **If accepted, build:** in the brainstorm. */
  variant?: string;
  /**
   * "build" (default) → fresh implementation from the brainstorm.
   * "resume"          → branch already exists with uncommitted/unpushed work; just
   *                     commit/push/PR. Used when a prior session ran but couldn't
   *                     reach the commit step (e.g. a permission gate, a network blip).
   */
  intent?: "build" | "resume";
}

type Mode = "live" | "offline" | "dry";

function mode(): Mode {
  const m = (process.env.IDEA_HARNESS_BUILDER ?? "live").toLowerCase();
  if (m === "offline" || m === "dry") return m;
  return "live";
}

function expandHome(p: string): string {
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  if (p === "~") return os.homedir();
  return p;
}

const CLI_TIMEOUT_MS = parseInt(process.env.IDEA_HARNESS_BUILDER_TIMEOUT_MS ?? "1800000", 10); // 30 min default

const BUILD_SYSTEM_PROMPT = `You are Claude Code, invoked by the LetsBarker idea-harness to turn an accepted idea into a real pull request.

You are running inside a git WORKTREE that has already been set up for you:
- cwd is the worktree directory (NOT the user's primary checkout)
- BRANCH_NAME has already been created and checked out, branched from origin/BASE_BRANCH
- Working tree is clean — \`git status\` should show no changes when you start
You don't need to create a branch. You just implement, commit, push, PR.

Your job in this session, in order:
1. Read the brainstorm in the user message — it is your spec. Identify the chosen variant (from the BUILD_VARIANT directive or the **If accepted, build:** line).
2. Confirm \`git rev-parse --abbrev-ref HEAD\` returns BRANCH_NAME and \`git status\` is clean. If not, STOP and explain — the harness set this up wrong.
3. Explore the codebase (grep, read) to find the right files to change. The brainstorm's "Existing footprint" section is your starting point — verify it before relying on it.
4. Implement the chosen variant. Stay narrowly scoped — do not refactor surrounding code.
5. Run the project's test command (check package.json / Gemfile for the convention). Fix any tests you broke.
6. Commit the changes on the feature branch with a message that references the idea slug.
7. Push the branch to origin (\`git push -u origin BRANCH_NAME\`).
8. Open a PR with \`gh pr create --base BASE_BRANCH --head BRANCH_NAME --title "<short title>" --body "<body>"\`. The body should reference the idea slug and include the brainstorm's "Why" sentence.
9. As the LAST line of your response — and nothing else after it — print: PR_URL=<the URL gh returned>

Constraints:
- Never check out, push to, or merge into main, master, preview, or any branch other than BRANCH_NAME.
- Never merge the PR. The PR is the human gate.
- Never use --no-verify or --no-gpg-sign.
- The harness invokes you with --permission-mode bypassPermissions specifically so you can run git and gh without per-command approval. Stay within the constraints above; the permission removal is for ergonomics, not for taking risks.
- If a step fails (test failure, push rejected, gh error), STOP and explain in plain text. Do NOT print PR_URL=. The harness treats absence of PR_URL= as a failure.
- If the brainstorm references a file/path that doesn't exist, treat the brainstorm as a hint, not gospel — verify before you edit.

Output format: prose is fine for steps 1-8 (you can think out loud, run commands, narrate). The LAST line MUST be PR_URL=<url> on success or a single sentence explaining why you stopped on failure.`;

const RESUME_SYSTEM_PROMPT = `You are Claude Code, recovering an in-flight build for the LetsBarker idea-harness.

You are running inside a git WORKTREE that the harness set up:
- cwd is the worktree directory (NOT the user's primary checkout)
- BRANCH_NAME is checked out
- The worktree may or may not contain uncommitted changes from a prior session — check \`git status\` to see

A previous session implemented the changes but couldn't complete the commit/push/PR step. Your only job is to land whatever's there.

Your job in this session, in order:
1. Confirm \`git rev-parse --abbrev-ref HEAD\` returns BRANCH_NAME.
2. Run \`git status\` to see the state. Three possible cases:
   a. Uncommitted changes → review with \`git diff\` to confirm they match BUILD_VARIANT in the user message. If anything looks wrong (totally unrelated edits, secrets, huge unintended diffs), STOP and explain — do NOT commit garbage just to land a PR.
   b. Clean working tree but local commits not pushed → push them.
   c. Clean working tree and no local commits → there's nothing to recover from this worktree. If \`gh pr view BRANCH_NAME\` returns an existing PR, print its URL as PR_URL= and stop. Otherwise STOP and explain.
3. Stage and commit any uncommitted changes with a clear message referencing the idea slug.
4. Push the branch to origin (\`git push -u origin BRANCH_NAME\`).
5. Open a PR with \`gh pr create --base BASE_BRANCH --head BRANCH_NAME --title "<short title>" --body "<body>"\`. The body should reference the idea slug and include the brainstorm's "Why" sentence.
6. As the LAST line of your response — and nothing else after it — print: PR_URL=<the URL gh returned>

Constraints:
- Do NOT make new feature changes. The build is done; you are just landing it.
- Never push to main, master, preview, or any branch other than BRANCH_NAME.
- Never merge the PR. The PR is the human gate.
- Never use --no-verify or --no-gpg-sign.
- If a PR already exists for BRANCH_NAME (\`gh pr view BRANCH_NAME\` returns one), print its URL as PR_URL= and stop — don't open a duplicate.
- The harness invokes you with --permission-mode bypassPermissions so git and gh just work.

Output format: prose is fine for the steps. The LAST line MUST be PR_URL=<url> on success or a single sentence explaining why you stopped on failure.`;

export async function build(
  idea: IdeaSummary,
  run: Run,
  opts: BuildOptions = {}
): Promise<BuildResult> {
  const start = Date.now();
  const intent = opts.intent ?? "build";
  const systemPrompt = intent === "resume" ? RESUME_SYSTEM_PROMPT : BUILD_SYSTEM_PROMPT;

  const project = resolveProjectConfig(idea.project);
  const repoPath = expandHome(project.local_path);
  if (!fs.existsSync(repoPath)) {
    throw new Error(`Repo path does not exist for project "${project.key}": ${repoPath}`);
  }

  const branch = computeBranchName(idea);
  const baseBranch = project.base_branch || "main";
  const variant = opts.variant ?? extractVariant(readIdeaBody(idea)) ?? "simplest version";
  const brainstormBody = extractBrainstormBody(readIdeaBody(idea));

  const userPrompt =
    intent === "resume"
      ? buildResumePrompt({ idea, project, brainstorm: brainstormBody, branch, baseBranch, variant })
      : buildUserPrompt({ idea, project, brainstorm: brainstormBody, branch, baseBranch, variant });

  const m = mode();
  if (m === "dry") {
    log.info(`Builder dry mode (${intent}) for ${idea.slug}:`);
    log.info(`  repo: ${repoPath}`);
    log.info(`  branch: ${branch} (base: ${baseBranch})`);
    log.info(`  variant: ${variant}`);
    log.info(`  prompt length: ${userPrompt.length} chars`);
    log.info(`  (worktree would be created at <repo-parent>/${path.basename(repoPath)}-worktrees/${branch.replace(/\//g, "-")})`);
    writeRunArtifact(run, `build-${idea.slug}.json`, {
      slug: idea.slug,
      intent,
      mode: m,
      repoPath,
      branch,
      baseBranch,
      variant,
      systemPrompt,
      userPrompt,
    });
    return {
      slug: idea.slug,
      status: "dry",
      branch,
      base_branch: baseBranch,
      worktree_path: null,
      pr_url: null,
      durationMs: Date.now() - start,
      exitCode: 0,
      stdoutTail: "",
      stderrTail: "",
    };
  }

  if (m === "offline") {
    const fakeUrl = `https://github.com/${project.github_repo}/pull/0`;
    log.info(`Builder offline mode (${intent}) for ${idea.slug} → fake PR ${fakeUrl}`);
    writeRunArtifact(run, `build-${idea.slug}.json`, {
      slug: idea.slug,
      intent,
      mode: m,
      repoPath,
      branch,
      baseBranch,
      variant,
      pr_url: fakeUrl,
    });
    return {
      slug: idea.slug,
      status: "pr-open",
      branch,
      base_branch: baseBranch,
      worktree_path: null,
      pr_url: fakeUrl,
      durationMs: Date.now() - start,
      exitCode: 0,
      stdoutTail: "",
      stderrTail: "",
    };
  }

  // ── Live mode: prepare worktree, then spawn claude inside it ─────────
  let worktree;
  try {
    worktree = await prepareWorktree({ repoPath, branch, baseBranch, intent });
  } catch (err) {
    const msg = `Worktree preparation failed: ${(err as Error).message}`;
    log.error(`  ${msg}`);
    writeRunArtifact(run, `build-${idea.slug}.error.json`, {
      slug: idea.slug,
      intent,
      branch,
      baseBranch,
      stage: "prepareWorktree",
      error: (err as Error).message,
      stack: (err as Error).stack,
    });
    return {
      slug: idea.slug,
      status: "failed",
      branch,
      base_branch: baseBranch,
      worktree_path: null,
      pr_url: null,
      durationMs: Date.now() - start,
      exitCode: -1,
      stdoutTail: "",
      stderrTail: msg,
    };
  }

  // Drop a breadcrumb on the idea so the user can `cd` to the worktree.
  appendNoteSafe(
    idea,
    `${intent === "resume" ? "Resume" : "Build"} worktree: ${worktree.path} (branch ${branch})`
  );

  const logPath = path.join(run.dir, `build-${idea.slug}.log`);
  const verb = intent === "resume" ? "Resuming" : "Building";
  log.info(`${verb} ${idea.slug} on branch ${branch}…`);
  log.info(`  Worktree: ${worktree.path}${worktree.reused ? " (reused)" : " (fresh)"}`);
  log.info(`  Live output: tail -f ${logPath}`);

  const result = await spawnClaude({
    cwd: worktree.path,
    userPrompt,
    systemPrompt,
    logPath,
  });

  const prUrl = parsePrUrl(result.stdout);
  const status: BuildResult["status"] = prUrl ? "pr-open" : "failed";

  writeRunArtifact(run, `build-${idea.slug}.json`, {
    slug: idea.slug,
    intent,
    mode: m,
    repoPath,
    worktreePath: worktree.path,
    worktreeReused: worktree.reused,
    branch,
    baseBranch,
    variant,
    pr_url: prUrl,
    exitCode: result.exitCode,
    durationMs: Date.now() - start,
    stdout: result.stdout,
    stderr: result.stderr,
    logPath,
    systemPrompt,
    userPrompt,
  });

  return {
    slug: idea.slug,
    status,
    branch,
    base_branch: baseBranch,
    worktree_path: worktree.path,
    pr_url: prUrl,
    durationMs: Date.now() - start,
    exitCode: result.exitCode,
    stdoutTail: tail(result.stdout, 2000),
    stderrTail: tail(result.stderr, 2000),
  };
}

function appendNoteSafe(idea: IdeaSummary, note: string): void {
  try {
    appendNote(path.join(IDEAS_DIR, idea.filename), note);
  } catch (err) {
    log.warn(`Could not append note to ${idea.filename}: ${(err as Error).message}`);
  }
}

/**
 * After a successful build, write the PR back to the idea file.
 */
export function recordPrOnIdea(idea: IdeaSummary, prUrl: string): void {
  const filepath = path.join(IDEAS_DIR, idea.filename);
  let content = fs.readFileSync(filepath, "utf8");

  // Frontmatter: status → pr-open, github_pr → url.
  content = content.replace(/^github_issue:.+$/m, (orig) =>
    /^github_pr:/m.test(content) ? orig : `${orig}\ngithub_pr: ${prUrl}`
  );
  if (/^github_pr:/m.test(content)) {
    content = content.replace(/^github_pr:.+$/m, `github_pr: ${prUrl}`);
  }

  fs.writeFileSync(filepath, content, "utf8");
  setStatusInFile(filepath, "pr-open");

  // Body: append a ## PR section if not already present.
  content = fs.readFileSync(filepath, "utf8");
  if (!/^## PR\s*$/m.test(content)) {
    const stamp = new Date().toISOString().slice(0, 10);
    content = content.trimEnd() + `\n\n## PR\n\n- ${stamp}: ${prUrl}\n`;
    fs.writeFileSync(filepath, content, "utf8");
  }
}

// ── Internal ───────────────────────────────────────────────────────────

function resolveProjectConfig(projectKey: string): ProjectConfig {
  const projects = loadProjects();
  const match = projects.find((p) => p.key === projectKey);
  if (!match) {
    throw new Error(
      `Idea project "${projectKey}" not found in projects.yml. Available: ${projects
        .map((p) => p.key)
        .join(", ")}`
    );
  }
  if (!match.local_path) {
    throw new Error(`Project "${projectKey}" has no local_path in projects.yml.`);
  }
  return match;
}

function computeBranchName(idea: IdeaSummary): string {
  const stem = idea.slug.replace(/-[a-f0-9]{4}$/, "").slice(0, 40).replace(/-+$/, "");
  const id4 = idea.id.slice(0, 4) || "0000";
  return `idea/${stem}-${id4}`;
}

function readIdeaBody(idea: IdeaSummary): string {
  return fs.readFileSync(path.join(IDEAS_DIR, idea.filename), "utf8");
}

function extractBrainstormBody(content: string): string {
  const m = content.match(/## Brainstorm\n+([\s\S]*?)(?=\n## (?!Brainstorm)|\n*$)/);
  return (m?.[1] ?? "").trim();
}

/**
 * If Taylor selected a non-default variant during conversational review,
 * the most recent `> YYYY-MM-DD: ... variant N ...` line in ## Notes wins.
 * Otherwise fall back to the brainstorm's **If accepted, build:** line.
 */
function extractVariant(content: string): string | null {
  const notesBlock = content.match(/## Notes\n+([\s\S]*?)(?=\n## )/)?.[1] ?? "";
  const variantNotes = notesBlock
    .split("\n")
    .filter((l) => /variant \d|simplest|the simpler/i.test(l));
  if (variantNotes.length) {
    const last = variantNotes[variantNotes.length - 1];
    const m = last.match(/(simplest version|variant \d+)/i);
    if (m) return m[1].toLowerCase();
  }
  const buildLine = content.match(/\*\*If accepted, build:\*\*\s*(.+)/);
  return buildLine ? buildLine[1].trim() : null;
}

function buildUserPrompt(args: {
  idea: IdeaSummary;
  project: ProjectConfig;
  brainstorm: string;
  branch: string;
  baseBranch: string;
  variant: string;
}): string {
  const { idea, project, brainstorm, branch, baseBranch, variant } = args;
  return `# Build directive

REPO: ${project.github_repo}
PROJECT_KEY: ${project.key}
BRANCH_NAME: ${branch}
BASE_BRANCH: ${baseBranch}
BUILD_VARIANT: ${variant}
IDEA_SLUG: ${idea.slug}
IDEA_ID: ${idea.id}

## Idea title
${idea.title}

## Brainstorm (this is your spec)

${brainstorm}

---

Implement BUILD_VARIANT on BRANCH_NAME, branched from BASE_BRANCH. Open a PR against BASE_BRANCH. Output PR_URL=<url> as your final line on success. Stop without printing PR_URL= on failure.`;
}

function buildResumePrompt(args: {
  idea: IdeaSummary;
  project: ProjectConfig;
  brainstorm: string;
  branch: string;
  baseBranch: string;
  variant: string;
}): string {
  const { idea, project, brainstorm, branch, baseBranch, variant } = args;
  return `# Resume directive

A previous session implemented this idea on the named branch but couldn't finish the commit/push/PR step. Your only job is to land it.

REPO: ${project.github_repo}
PROJECT_KEY: ${project.key}
BRANCH_NAME: ${branch}
BASE_BRANCH: ${baseBranch}
BUILD_VARIANT: ${variant}
IDEA_SLUG: ${idea.slug}
IDEA_ID: ${idea.id}

## Idea title
${idea.title}

## Brainstorm (the spec the prior session worked from — for reference, not re-implementation)

${brainstorm}

---

Confirm BRANCH_NAME exists with relevant uncommitted/staged work. Verify the diff matches BUILD_VARIANT. Commit, push, open a PR. Output PR_URL=<url> as your final line on success.`;
}

function parsePrUrl(stdout: string): string | null {
  // Preferred: the explicit sentinel. Take the last occurrence so the final
  // emission wins (the model is instructed to print this as the LAST line).
  const sentinelMatches = stdout.match(/PR_URL=(\S+)/g);
  if (sentinelMatches && sentinelMatches.length > 0) {
    const last = sentinelMatches[sentinelMatches.length - 1];
    const url = last.replace(/^PR_URL=/, "").replace(/[.,;)\]]+$/, "");
    if (url) return url;
  }

  // Belt-and-suspenders: if the model didn't follow the sentinel format but
  // a PR was actually opened, the URL almost certainly appears in stdout.
  // Take the LAST github.com .../pull/<number> we see.
  const urlMatches = stdout.match(/https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/g);
  if (urlMatches && urlMatches.length > 0) {
    return urlMatches[urlMatches.length - 1];
  }

  return null;
}

function tail(s: string, n: number): string {
  return s.length <= n ? s : s.slice(-n);
}

function claudeBin(): string {
  return process.env.IDEA_HARNESS_CLAUDE_BIN || "claude";
}

interface SpawnResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function spawnClaude(args: {
  cwd: string;
  userPrompt: string;
  systemPrompt: string;
  logPath: string;
}): Promise<SpawnResult> {
  const bin = claudeBin();

  // bypassPermissions: the builder needs git + gh to run without per-command
  // approval (the dm-cohorts-d2e3 run failed with acceptEdits because Bash(git
  // commit), Bash(git push), Bash(gh pr create) were all gated by the target
  // repo's settings.local.json allow-list). Risk is bounded by the system
  // prompt: branch name pinned, no merging, no force-push.
  //
  // Plain prose output with a PR_URL= sentinel on the last line — we don't
  // ask for --output-format stream-json because we want a session that's
  // tail -f-able by the user during a long build.
  const cliArgs = [
    "--print",
    "--system-prompt",
    args.systemPrompt,
    "--permission-mode",
    "bypassPermissions",
  ];

  // Write a header into the log so a follower knows what they're looking at.
  const logStream = fs.createWriteStream(args.logPath, { flags: "w" });
  logStream.write(
    `# idea-harness builder session\n` +
      `# cwd: ${args.cwd}\n` +
      `# started: ${new Date().toISOString()}\n` +
      `# bin: ${bin} ${cliArgs.join(" ")}\n` +
      `# ---\n`
  );

  return await new Promise((resolve, reject) => {
    const child = spawn(bin, cliArgs, {
      cwd: args.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (result: SpawnResult | null, err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      logStream.end(() => {
        if (err) reject(err);
        else if (result) resolve(result);
      });
    };

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish(null, new Error(`Builder claude session timed out after ${CLI_TIMEOUT_MS}ms`));
    }, CLI_TIMEOUT_MS);

    child.stdout.on("data", (chunk) => {
      const s = chunk.toString("utf8");
      stdout += s;
      logStream.write(s);
      process.stderr.write(s);
    });
    child.stderr.on("data", (chunk) => {
      const s = chunk.toString("utf8");
      stderr += s;
      logStream.write(s);
      process.stderr.write(s);
    });

    child.on("error", (err) => finish(null, new Error(`Failed to spawn claude: ${err.message}`)));
    child.on("close", (code) => finish({ stdout, stderr, exitCode: code ?? -1 }));

    child.stdin.write(args.userPrompt);
    child.stdin.end();
  });
}

/**
 * Convenience: find an accepted idea by slug. Used by the graduator.
 */
export function findAccepted(slug: string): IdeaSummary | null {
  const all = listIdeas();
  return all.find((i) => i.slug === slug && i.status === "accepted") ?? null;
}
