/**
 * scripts/commands/_dashboard/_smoke_cli.ts
 *
 * Spec contract: "Don't break --json/--ndjson modes (dashboard
 * remains TTY-only)." This smoke spawns the real harness binary
 * (not the dashboard module in-process) and verifies that:
 *
 *   1. `harness --json` (no args) returns a single-line envelope
 *      with schema=harness/v1, verb=dashboard, ok=false,
 *      error.code=BAD_INPUT.
 *   2. `harness --ndjson` (no args) likewise — last line is the
 *      envelope.
 *   3. The error hint points agents at `ideas list` instead of
 *      letting them think the dashboard "broke" non-interactively.
 *   4. Exit code is 0 in both cases (clean error envelope, not crash).
 *
 * This guards the spec's literal "Don't break agent modes" clause.
 * Until now it was only verified ad-hoc.
 */

import * as path from "path";
import { spawnSync } from "child_process";

async function main() {
  const ROOT = process.cwd();
  const HARNESS_BIN = path.join(ROOT, "bin", "harness.ts");
  const TSX_BIN = path.join(ROOT, "node_modules", ".bin", "tsx");

  let pass = true;
  const check = (name: string, ok: boolean, detail?: string) => {
    process.stderr.write(`${ok ? "PASS" : "FAIL"}: ${name}${detail ? `  (${detail})` : ""}\n`);
    if (!ok) pass = false;
  };

  // Spawn helper. Inherit stdin from /dev/null to guarantee a
  // non-TTY environment regardless of how the smoke itself is run.
  const run = (mode: "--json" | "--ndjson") => {
    return spawnSync(TSX_BIN, [HARNESS_BIN, mode], {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
      timeout: 10_000,
    });
  };

  // ── --json mode ──────────────────────────────────────────────────
  process.stderr.write("--- --json envelope ---\n");
  {
    const out = run("--json");
    check("--json: exit code 0 (clean error envelope)", out.status === 0,
      `status=${out.status} stderr=${(out.stderr ?? "").slice(0, 120)}`);
    const stdout = (out.stdout ?? "").trim();
    check("--json: stdout has exactly one line",
      stdout.split("\n").filter(Boolean).length === 1,
      `lines=${stdout.split("\n").length}`);

    let env: any = null;
    try { env = JSON.parse(stdout); } catch { /* fail next check */ }
    check("--json: stdout is valid JSON", env !== null);
    if (env) {
      check("--json: schema === harness/v1", env.schema === "harness/v1");
      check("--json: verb === dashboard", env.verb === "dashboard");
      check("--json: ok === false", env.ok === false);
      check("--json: error.code === BAD_INPUT", env.error?.code === "BAD_INPUT");
      check("--json: hint points at ideas list",
        typeof env.hint === "string" && /ideas list/.test(env.hint));
    }
  }

  // ── --ndjson mode ────────────────────────────────────────────────
  process.stderr.write("--- --ndjson envelope ---\n");
  {
    const out = run("--ndjson");
    check("--ndjson: exit code 0", out.status === 0);
    const stdout = (out.stdout ?? "").trim();
    const lines = stdout.split("\n").filter(Boolean);
    check("--ndjson: at least one line on stdout", lines.length >= 1);

    let env: any = null;
    try { env = JSON.parse(lines[lines.length - 1]); } catch { /* fail next */ }
    check("--ndjson: last line is valid JSON envelope", env !== null);
    if (env) {
      check("--ndjson: envelope schema === harness/v1", env.schema === "harness/v1");
      check("--ndjson: envelope verb === dashboard", env.verb === "dashboard");
      check("--ndjson: envelope ok === false", env.ok === false);
      check("--ndjson: envelope error.code === BAD_INPUT", env.error?.code === "BAD_INPUT");
    }
  }

  process.exit(pass ? 0 : 1);
}

main().catch((e) => {
  console.error("smoke-cli FAIL:", e);
  process.exit(1);
});
