/**
 * scripts/lib/log.ts
 *
 * Tiny stderr logger. Stdout is reserved for JSON output of CLI commands
 * (so callers can pipe to jq); all human-readable progress goes to stderr.
 *
 * Log level is controlled by LOG_LEVEL env: silent | error | warn | info | debug.
 * Default: info.
 */

type Level = "silent" | "error" | "warn" | "info" | "debug";

const LEVELS: Record<Level, number> = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
};

function currentLevel(): number {
  const raw = (process.env.LOG_LEVEL ?? "info").toLowerCase() as Level;
  return LEVELS[raw] ?? LEVELS.info;
}

function emit(level: Level, args: unknown[]): void {
  if (LEVELS[level] > currentLevel()) return;
  const stream = process.stderr;
  stream.write(args.map(formatArg).join(" ") + "\n");
}

function formatArg(a: unknown): string {
  if (a instanceof Error) return a.stack ?? a.message;
  if (typeof a === "string") return a;
  try {
    return JSON.stringify(a);
  } catch {
    return String(a);
  }
}

export const log = {
  silent: (...args: unknown[]) => emit("silent", args),
  error: (...args: unknown[]) => emit("error", args),
  warn: (...args: unknown[]) => emit("warn", args),
  info: (...args: unknown[]) => emit("info", args),
  debug: (...args: unknown[]) => emit("debug", args),
};
