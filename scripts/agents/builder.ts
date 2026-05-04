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
import { setStatusInFile, IdeaSummary, listIdeas } from "../lib/ideas";
import { log } from "../lib/log";

const IDEAS_DIR = path.join(__dirname, "..", "..", "ideas");

export interface BuildResult {
  slug: string;
  status: "pr-open" | "failed" | "dry";
  branch: string;
  base_branch: string;
  pr_url: string | null;
  durationMs: number;
  exitCode: number;
  stdoutTail: string;
  stderrTail: string;
}

export interface BuildOptions {
  /** Override the variant choice. Falls back to **If accepted, build:** in the brainstorm. */
  variant?: string;
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

const SYSTEM_PROMPT = `You are Claude Code, invoked by the LetsBarker idea-harness to turn an accepted idea into a real pull request.

Your job in this session, in order:
1. Read the brainstorm in the user message — it is your spec. Identify the chosen variant (from the BUILD_VARIANT directive or the **If accepted, build:** line).
2. Explore the codebase (grep, read) to find the right files to change. The brainstorm's "Existing footprint" section is your starting point — verify it before relying on it.
3. Create the feature branch named in BRANCH_NAME, branched from BASE_BRANCH.
4. Implement the chosen variant. Stay narrowly scoped — do not refactor surrounding code.
5. Run the project's test command (check package.json / Gemfile for the convention). Fix any tests you broke.
6. Commit the changes on the feature branch with a message that references the idea.
7. Push the branch to origin.
8. Open a PR with \`gh pr create --base BASE_BRANCH --head BRANCH_NAME --title "<short title>" --body "<body>"\`. The body should reference the idea slug and include the brainstorm's "Why" sentence.
9. As the LAST line of your response — and nothing else after it — print: PR_URL=<the URL gh returned>

Constraints:
- Never push to main, master, preview, or any branch other than BRANCH_NAME.
- Never merge the PR. The PR is the human gate.
- Never use --no-verify or --no-gpg-sign.
- If a step fails (test failure, push rejected, gh error), STOP and explain in plain text. Do NOT print PR_URL=. The harness treats absence of PR_URL= as a failure.
- If the brainstorm references a file/path that doesn't exist, treat the brainstorm as a hint, not gospel — verify before you edit.

Output format: prose is fine for steps 1-8 (you can think out loud, run commands, narrate). The LAST line MUST be PR_URL=<url> on success or a single sentence explaining why you stopped on failure.`;

export async function build(
  idea: IdeaSummary,
  run: Run,
  opts: BuildOptions = {}
): Promise<BuildResult> {
  const start = Date.now();

  const project = resolveProjectConfig(idea.project);
  const repoPath = expandHome(project.local_path);
  if (!fs.existsSync(repoPath)) {
    throw new Error(`Repo path does not exist for project "${project.key}": ${repoPath}`);
  }

  const branch = computeBranchName(idea);
  const baseBranch = project.base_branch || "main";
  const variant = opts.variant ?? extractVariant(readIdeaBody(idea)) ?? "simplest version";
  const brainstormBody = extractBrainstormBody(readIdeaBody(idea));

  const userPrompt = buildUserPrompt({
    idea,
    project,
    brainstorm: brainstormBody,
    branch,
    baseBranch,
    variant,
  });

  const m = mode();
  if (m === "dry") {
    log.info(`Builder dry mode for ${idea.slug}:`);
    log.info(`  repo: ${repoPath}`);
    log.info(`  branch: ${branch} (base: ${baseBranch})`);
    log.info(`  variant: ${variant}`);
    log.info(`  prompt length: ${userPrompt.length} chars`);
    writeRunArtifact(run, `build-${idea.slug}.json`, {
      slug: idea.slug,
      mode: m,
      repoPath,
      branch,
      baseBranch,
      variant,
      systemPrompt: SYSTEM_PROMPT,
      userPrompt,
    });
    return {
      slug: idea.slug,
      status: "dry",
      branch,
      base_branch: baseBranch,
      pr_url: null,
      durationMs: Date.now() - start,
      exitCode: 0,
      stdoutTail: "",
      stderrTail: "",
    };
  }

  if (m === "offline") {
    const fakeUrl = `https://github.com/${project.github_repo}/pull/0`;
    log.info(`Builder offline mode for ${idea.slug} → fake PR ${fakeUrl}`);
    writeRunArtifact(run, `build-${idea.slug}.json`, {
      slug: idea.slug,
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
      pr_url: fakeUrl,
      durationMs: Date.now() - start,
      exitCode: 0,
      stdoutTail: "",
      stderrTail: "",
    };
  }

  // ── Live mode: spawn claude in the repo ──────────────────────────────
  log.info(`Building ${idea.slug} in ${repoPath} on branch ${branch}…`);
  const result = await spawnClaude({ cwd: repoPath, userPrompt });

  const prUrl = parsePrUrl(result.stdout);
  const status: BuildResult["status"] = prUrl ? "pr-open" : "failed";

  writeRunArtifact(run, `build-${idea.slug}.json`, {
    slug: idea.slug,
    mode: m,
    repoPath,
    branch,
    baseBranch,
    variant,
    pr_url: prUrl,
    exitCode: result.exitCode,
    durationMs: Date.now() - start,
    stdout: result.stdout,
    stderr: result.stderr,
    systemPrompt: SYSTEM_PROMPT,
    userPrompt,
  });

  return {
    slug: idea.slug,
    status,
    branch,
    base_branch: baseBranch,
    pr_url: prUrl,
    durationMs: Date.now() - start,
    exitCode: result.exitCode,
    stdoutTail: tail(result.stdout, 2000),
    stderrTail: tail(result.stderr, 2000),
  };
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

function parsePrUrl(stdout: string): string | null {
  // Look for the LAST PR_URL= line (most reliable: last instruction Claude
  // emitted). Tolerate trailing whitespace/punctuation.
  const matches = stdout.match(/PR_URL=(\S+)/g);
  if (!matches || matches.length === 0) return null;
  const last = matches[matches.length - 1];
  return last.replace(/^PR_URL=/, "").replace(/[.,;)\]]+$/, "") || null;
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

async function spawnClaude(args: { cwd: string; userPrompt: string }): Promise<SpawnResult> {
  const bin = claudeBin();
  // We deliberately do NOT pass --output-format json here — the build session
  // is long-running and may stream tool calls; we want plain prose with the
  // PR_URL= sentinel on the last line. Token counts are not load-bearing
  // for the build path.
  const cliArgs = [
    "--print",
    "--system-prompt",
    SYSTEM_PROMPT,
    "--permission-mode",
    "acceptEdits",
  ];

  return await new Promise((resolve, reject) => {
    const child = spawn(bin, cliArgs, {
      cwd: args.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      reject(new Error(`Builder claude session timed out after ${CLI_TIMEOUT_MS}ms`));
    }, CLI_TIMEOUT_MS);

    child.stdout.on("data", (chunk) => {
      const s = chunk.toString("utf8");
      stdout += s;
      // Stream live output to stderr so a watcher can follow progress.
      process.stderr.write(s);
    });
    child.stderr.on("data", (chunk) => {
      const s = chunk.toString("utf8");
      stderr += s;
      process.stderr.write(s);
    });

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`Failed to spawn claude: ${err.message}`));
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code ?? -1 });
    });

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
