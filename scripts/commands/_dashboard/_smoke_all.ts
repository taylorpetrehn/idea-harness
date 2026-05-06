/**
 * scripts/commands/_dashboard/_smoke_all.ts
 *
 * Runs every _smoke_*.ts in this directory in sequence, prints a
 * per-suite pass/fail summary, and exits non-zero if anything failed.
 *
 *   tsx scripts/commands/_dashboard/_smoke_all.ts
 *   tsx scripts/commands/_dashboard/_smoke_all.ts --quick
 *
 * --quick skips the long-running build-spawn smoke (~3 sec child
 * process) so dev iteration stays snappy.
 *
 * Output mirrors the bash loop maintainers were hand-copying:
 *
 *   _smoke_live: PASS=5 FAIL=0
 *   _smoke_handoff: PASS=6 FAIL=0
 *   ...
 *   ──────────────────────────────────────
 *   16 suites · 160 PASS · 0 FAIL · 8.4s
 */

import * as fs from "fs";
import * as path from "path";
import { spawnSync } from "child_process";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.join(HERE, "..", "..", "..");
const TSX_BIN = path.join(ROOT, "node_modules", ".bin", "tsx");

interface Result {
  name: string;
  pass: number;
  fail: number;
  durationMs: number;
  exitCode: number | null;
  /** Captured stderr — only shown for failed suites. */
  stderr: string;
}

function listSmokes(): string[] {
  const here = HERE;
  return fs.readdirSync(here)
    .filter((f) => f.startsWith("_smoke_") && f.endsWith(".ts"))
    .filter((f) => f !== "_smoke_all.ts")
    .sort();
}

function runSmoke(filename: string, cols?: number): Result {
  const filepath = path.join(HERE, filename);
  const args: string[] = [filepath];
  // _smoke.ts (the static render smoke) is a special case — it expects
  // a --cols flag and prints the rendered frame to stdout instead of
  // PASS/FAIL lines. Exit code is the source of truth.
  if (filename === "_smoke.ts" && cols) args.push(`--cols=${cols}`);

  const start = Date.now();
  const out = spawnSync(TSX_BIN, args, {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 30_000,
  });
  const durationMs = Date.now() - start;
  const stderr = out.stderr ?? "";
  const stdout = out.stdout ?? "";
  const haystack = stderr + "\n" + stdout;
  const pass = (haystack.match(/^PASS:/gm) ?? []).length;
  const fail = (haystack.match(/^FAIL:/gm) ?? []).length;

  return {
    name: filename.replace(/\.ts$/, ""),
    pass,
    fail,
    durationMs,
    exitCode: out.status,
    stderr,
  };
}

async function main() {
  const quick = process.argv.includes("--quick");
  const showStderr = process.argv.includes("--verbose");
  const all = listSmokes();
  const results: Result[] = [];

  process.stderr.write(`harness dashboard smoke runner — ${all.length} suites\n\n`);

  for (const f of all) {
    if (quick && f === "_smoke_build.ts") {
      process.stderr.write(`${f.replace(/\.ts$/, "")}: SKIPPED (--quick)\n`);
      continue;
    }
    const r = runSmoke(f);
    results.push(r);
    const tag = r.fail > 0 || (r.exitCode !== 0 && r.pass === 0)
      ? "✗"
      : r.exitCode === 0 ? "✓" : "?";
    const summary = r.pass === 0 && r.fail === 0
      ? `exit=${r.exitCode}`
      : `PASS=${r.pass} FAIL=${r.fail}`;
    process.stderr.write(
      `${tag} ${r.name.padEnd(22)} ${summary.padEnd(18)} ${(r.durationMs / 1000).toFixed(1)}s\n`
    );
    if (r.fail > 0 && showStderr) {
      process.stderr.write(indent(r.stderr.trim(), "    ") + "\n");
    }
  }

  const totalPass = results.reduce((a, r) => a + r.pass, 0);
  const totalFail = results.reduce((a, r) => a + r.fail, 0);
  const totalSec = results.reduce((a, r) => a + r.durationMs, 0) / 1000;
  const exitFails = results.filter((r) => r.exitCode !== 0).length;

  process.stderr.write("\n" + "─".repeat(50) + "\n");
  process.stderr.write(
    `${results.length} suites · ${totalPass} PASS · ${totalFail} FAIL · ${totalSec.toFixed(1)}s\n`
  );

  if (totalFail > 0 || exitFails > 0) {
    if (exitFails > 0 && totalFail === 0) {
      process.stderr.write(`${exitFails} suite(s) exited non-zero with no FAIL line — re-run with --verbose to see stderr\n`);
    }
    process.exit(1);
  }
  process.exit(0);
}

function indent(s: string, prefix: string): string {
  return s.split("\n").map((l) => prefix + l).join("\n");
}

main().catch((e) => {
  console.error("smoke-all FAIL:", e);
  process.exit(1);
});
