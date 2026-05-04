/**
 * scripts/commands/doctor.ts
 *
 * `harness doctor` — environment health check.
 *
 * Mirrors `expo-doctor`: green if everything's set up, yellow on
 * warnings, red on hard failures. Each check is independent — one
 * red doesn't block the rest from running.
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { execFileSync } from "child_process";
import { z } from "zod";
import { Output } from "../lib/output";
import { registerVerb } from "../lib/contracts";
import { loadProjects } from "../lib/projects";

export interface DoctorArgs {}

const Check = z.object({
  name: z.string(),
  status: z.enum(["ok", "warn", "fail", "skip"]),
  message: z.string(),
  hint: z.string().optional(),
});
const DoctorData = z.object({
  ok: z.boolean(),
  total: z.number(),
  failed: z.number(),
  warned: z.number(),
  checks: z.array(Check),
});

registerVerb({
  verb: "doctor",
  description: "Check environment health: projects, claude bin, gh auth, reminders perms.",
  data: DoctorData,
});

type Status = "ok" | "warn" | "fail" | "skip";

interface CheckRec {
  name: string;
  status: Status;
  message: string;
  hint?: string;
}

function expandHome(p: string): string {
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  if (p === "~") return os.homedir();
  return p;
}

function which(bin: string): string | null {
  try {
    const result = execFileSync("which", [bin], { encoding: "utf8" }).trim();
    return result || null;
  } catch {
    return null;
  }
}

function tryExec(bin: string, args: string[]): { ok: boolean; out: string } {
  try {
    const out = execFileSync(bin, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { ok: true, out: out.trim() };
  } catch (err) {
    return { ok: false, out: (err as Error).message };
  }
}

function checkClaudeBin(): CheckRec {
  const bin = process.env.IDEA_HARNESS_CLAUDE_BIN || "claude";
  const found = path.isAbsolute(bin) ? (fs.existsSync(bin) ? bin : null) : which(bin);
  if (!found) {
    return {
      name: "claude binary",
      status: "fail",
      message: `\`${bin}\` not found on PATH.`,
      hint: "Install Claude Code or set IDEA_HARNESS_CLAUDE_BIN to its absolute path.",
    };
  }
  return { name: "claude binary", status: "ok", message: found };
}

function checkAnthropicAuth(): CheckRec {
  if (process.env.ANTHROPIC_API_KEY) {
    return { name: "Anthropic auth", status: "ok", message: "ANTHROPIC_API_KEY is set." };
  }
  return {
    name: "Anthropic auth",
    status: "warn",
    message: "ANTHROPIC_API_KEY not set; will fall back to the claude CLI's auth.",
    hint: "Run `claude /login` if the CLI isn't already authenticated.",
  };
}

function checkGh(): CheckRec {
  if (!which("gh")) {
    return {
      name: "gh CLI",
      status: "fail",
      message: "gh not found.",
      hint: "Install with `brew install gh` and authenticate with `gh auth login`.",
    };
  }
  const auth = tryExec("gh", ["auth", "status"]);
  if (!auth.ok) {
    return {
      name: "gh CLI",
      status: "fail",
      message: "gh installed but not authenticated.",
      hint: "Run `gh auth login`.",
    };
  }
  return { name: "gh CLI", status: "ok", message: "authenticated." };
}

function checkProjects(): CheckRec[] {
  const checks: CheckRec[] = [];
  let projects;
  try {
    projects = loadProjects();
  } catch (err) {
    return [{
      name: "projects.yml",
      status: "fail",
      message: (err as Error).message,
      hint: "Set IDEA_HARNESS_PROJECTS_YML or place projects.yml in ~/.openclaw/...",
    }];
  }
  if (projects.length === 0) {
    checks.push({
      name: "projects.yml",
      status: "warn",
      message: "no projects loaded — running with built-in default only.",
    });
    return checks;
  }
  checks.push({
    name: "projects.yml",
    status: "ok",
    message: `${projects.length} project(s) configured.`,
  });
  for (const p of projects) {
    const local = expandHome(p.local_path);
    if (!fs.existsSync(local)) {
      checks.push({
        name: `project ${p.key}`,
        status: "fail",
        message: `local_path missing: ${local}`,
        hint: "Either clone the repo to that path or fix projects.yml.",
      });
    } else if (!fs.existsSync(path.join(local, ".git"))) {
      checks.push({
        name: `project ${p.key}`,
        status: "warn",
        message: `${local} is not a git repo — worktrees will fail.`,
      });
    } else {
      checks.push({ name: `project ${p.key}`, status: "ok", message: local });
    }
  }
  return checks;
}

function checkReminders(): CheckRec {
  if (process.platform !== "darwin") {
    return {
      name: "Apple Reminders",
      status: "skip",
      message: `non-Darwin platform (${process.platform}); capture --from reminders unavailable.`,
    };
  }
  if (process.env.IDEA_HARNESS_REMINDERS === "dry") {
    return { name: "Apple Reminders", status: "skip", message: "IDEA_HARNESS_REMINDERS=dry" };
  }
  const probe = tryExec("osascript", ["-e", 'tell application "Reminders" to count of lists']);
  if (!probe.ok) {
    return {
      name: "Apple Reminders",
      status: "warn",
      message: "osascript probe failed; harness will fall back to dry mode.",
      hint: "Grant Terminal/iTerm Automation access to Reminders in System Settings → Privacy.",
    };
  }
  return { name: "Apple Reminders", status: "ok", message: `${probe.out} list(s) accessible.` };
}

function checkGit(): CheckRec {
  if (!which("git")) {
    return { name: "git", status: "fail", message: "git not found on PATH." };
  }
  return { name: "git", status: "ok", message: which("git") || "" };
}

export async function run(_args: DoctorArgs, out: Output): Promise<void> {
  const checks: CheckRec[] = [
    checkGit(),
    checkClaudeBin(),
    checkAnthropicAuth(),
    checkGh(),
    ...checkProjects(),
    checkReminders(),
  ];

  const failed = checks.filter((c) => c.status === "fail").length;
  const warned = checks.filter((c) => c.status === "warn").length;

  if (out.mode === "pretty") {
    for (const c of checks) {
      const icon =
        c.status === "ok" ? "✓" :
        c.status === "warn" ? "⚠" :
        c.status === "fail" ? "✗" : "·";
      out.stdout(`${icon} ${c.name}: ${c.message}\n`);
      if (c.hint && c.status !== "ok") out.stdout(`    → ${c.hint}\n`);
    }
    out.stdout(`\n${checks.length - failed - warned} ok, ${warned} warn, ${failed} fail\n`);
  }

  out.result(
    {
      ok: failed === 0,
      total: checks.length,
      failed,
      warned,
      checks,
    },
    failed > 0 ? "Address the failed checks before running `harness brainstorm`." : undefined
  );
}
