/**
 * scripts/lib/projects.ts
 *
 * Project routing. Parses the idea-to-pr skill's references/projects.yml
 * (the single source of truth for project keywords) and resolves a project
 * key for a given idea title + notes.
 *
 * Path discovery:
 *   1. IDEA_HARNESS_PROJECTS_YML env var (explicit override)
 *   2. ~/.openclaw/workspace-bonnie/skills/idea-to-pr/references/projects.yml
 *   3. ~/.claude/skills/idea-to-pr/references/projects.yml
 *
 * If none exist, falls back to a baked-in projects list keyed on
 * "letsbarker" so the harness still functions.
 *
 * The parser is intentionally minimal — projects.yml has a stable shape
 * and we'd rather not pull in a yaml dep.
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";

export interface ProjectConfig {
  key: string;
  github_repo: string;
  local_path: string;
  base_branch: string;
  keywords: string[];
}

let cachedRegistry: ProjectConfig[] | null = null;
let cachedDefault: string = "ask_taylor";

function expandHome(p: string): string {
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  if (p === "~") return os.homedir();
  return p;
}

function candidatePaths(): string[] {
  const paths: string[] = [];
  if (process.env.IDEA_HARNESS_PROJECTS_YML) {
    paths.push(expandHome(process.env.IDEA_HARNESS_PROJECTS_YML));
  }
  paths.push(
    expandHome("~/.openclaw/workspace-bonnie/skills/idea-to-pr/references/projects.yml"),
    expandHome("~/.claude/skills/idea-to-pr/references/projects.yml")
  );
  return paths;
}

export function loadProjects(): ProjectConfig[] {
  if (cachedRegistry) return cachedRegistry;
  for (const candidate of candidatePaths()) {
    if (!fs.existsSync(candidate)) continue;
    try {
      const raw = fs.readFileSync(candidate, "utf8");
      const parsed = parseProjectsYml(raw);
      cachedRegistry = parsed.projects;
      cachedDefault = parsed.default;
      return cachedRegistry;
    } catch {
      // Try the next candidate.
    }
  }
  cachedRegistry = builtinProjects();
  return cachedRegistry;
}

export function resolveProject(title: string, notes: string | null | undefined): string | null {
  const haystack = `${title}\n${notes ?? ""}`.toLowerCase();
  const projects = loadProjects();

  const scored = projects
    .map((p) => ({
      key: p.key,
      hits: p.keywords.reduce(
        (acc, kw) => acc + (haystack.includes(kw.toLowerCase()) ? 1 : 0),
        0
      ),
    }))
    .filter((s) => s.hits > 0)
    .sort((a, b) => b.hits - a.hits);

  if (scored.length === 0) {
    return cachedDefault === "ask_taylor" ? null : cachedDefault;
  }
  return scored[0].key;
}

export function defaultProjectKey(): string {
  loadProjects();
  return cachedDefault === "ask_taylor" ? "letsbarker" : cachedDefault;
}

// ── YAML mini-parser ──────────────────────────────────────────────────
// Specialized for the idea-to-pr projects.yml shape. Not a general parser.

interface ParsedRegistry {
  projects: ProjectConfig[];
  default: string;
}

function parseProjectsYml(raw: string): ParsedRegistry {
  const lines = raw.split("\n").map((l) => l.replace(/\t/g, "  "));
  const projects: ProjectConfig[] = [];

  let inProjects = false;
  let inRouting = false;
  let current: Partial<ProjectConfig> | null = null;
  let inKeywords = false;
  let routingDefault = "ask_taylor";

  const flush = () => {
    if (current && current.key) {
      projects.push({
        key: current.key,
        github_repo: current.github_repo ?? "",
        local_path: current.local_path ?? "",
        base_branch: current.base_branch ?? "main",
        keywords: current.keywords ?? [],
      });
    }
    current = null;
    inKeywords = false;
  };

  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+$/, "");
    if (!line.trim() || line.trim().startsWith("#")) continue;

    if (line === "projects:" || line.startsWith("projects:")) {
      inProjects = true;
      inRouting = false;
      continue;
    }
    if (line === "routing_rules:" || line.startsWith("routing_rules:")) {
      flush();
      inProjects = false;
      inRouting = true;
      continue;
    }

    if (inRouting) {
      const m = line.match(/^\s+default:\s*"?([^"]+)"?\s*$/);
      if (m) routingDefault = m[1].trim();
      continue;
    }

    if (!inProjects) continue;

    const projectKeyMatch = line.match(/^  ([a-zA-Z0-9_-]+):\s*$/);
    if (projectKeyMatch) {
      flush();
      current = { key: projectKeyMatch[1], keywords: [] };
      inKeywords = false;
      continue;
    }

    if (!current) continue;

    const fieldMatch = line.match(/^    ([a-zA-Z0-9_]+):\s*(.*)$/);
    if (fieldMatch) {
      const [, key, rawValue] = fieldMatch;
      const value = rawValue.trim().replace(/^"|"$/g, "");
      if (key === "keywords") {
        inKeywords = true;
        current.keywords = [];
      } else {
        inKeywords = false;
        if (key === "github_repo") current.github_repo = value;
        else if (key === "local_path") current.local_path = value;
        else if (key === "base_branch") current.base_branch = value;
      }
      continue;
    }

    if (inKeywords) {
      const kwMatch = line.match(/^\s+-\s+"?([^"]+)"?\s*$/);
      if (kwMatch && current.keywords) {
        current.keywords.push(kwMatch[1].trim());
      }
    }
  }

  flush();
  return { projects, default: routingDefault };
}

function builtinProjects(): ProjectConfig[] {
  return [
    {
      key: "letsbarker",
      github_repo: "BarkerEnterprises/LetsBarker",
      local_path: "~/Projects/PrimaryBarker/LetsBarker",
      base_branch: "preview",
      keywords: [
        "employee",
        "team",
        "shift",
        "task",
        "onboarding",
        "barker",
        "mobile",
        "schedule",
        "attendance",
        "timecard",
        "invoice",
        "ocr",
      ],
    },
  ];
}
