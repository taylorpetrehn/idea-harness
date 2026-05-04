/**
 * scripts/lib/output.ts
 *
 * Output abstraction. Every verb fn receives an `Output` object and
 * uses it to surface results, events, errors, and informational
 * messages. The CLI picks a mode (pretty / json / ndjson) once from
 * the top-level flags and the same code path serves humans and agents.
 *
 * Modes:
 *   pretty  — colored TTY output to stderr, no envelope.
 *             stdout is reserved for "the answer" (e.g. file contents
 *             from `harness ideas show`) so it stays pipe-friendly.
 *   json    — single envelope to stdout at end of command. Events are
 *             buffered and dropped (or surfaced as warnings).
 *   ndjson  — one event per line to stdout, terminated with the
 *             final envelope.
 *
 * Invariants:
 *   - In json mode, exactly ONE line is written to stdout (the envelope).
 *   - In ndjson mode, the LAST line is always the envelope.
 *   - In pretty mode, nothing structured ever lands on stdout from
 *     this module — only `stdout()` calls from verb fns.
 */

import {
  SCHEMA_VERSION,
  ErrorCode,
  HarnessError,
  SuccessEnvelope,
  ErrorEnvelope,
  HarnessEvent,
} from "./contracts";

export type OutputMode = "pretty" | "json" | "ndjson";

export interface OutputOptions {
  mode: OutputMode;
  verb: string;
  /** Optional sink override — defaults to process.stdout/stderr. */
  stdout?: (s: string) => void;
  stderr?: (s: string) => void;
  /** When true, color codes are emitted in pretty mode. */
  color?: boolean;
}

const ANSI = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  bold: "\x1b[1m",
};

function color(use: boolean | undefined, code: keyof typeof ANSI, s: string): string {
  return use ? `${ANSI[code]}${s}${ANSI.reset}` : s;
}

export class Output {
  readonly mode: OutputMode;
  readonly verb: string;
  private readonly _stdout: (s: string) => void;
  private readonly _stderr: (s: string) => void;
  private readonly _color: boolean;
  private _started: number;
  private _warnings: string[] = [];
  private _settled = false;

  constructor(opts: OutputOptions) {
    this.mode = opts.mode;
    this.verb = opts.verb;
    this._stdout = opts.stdout ?? ((s) => process.stdout.write(s));
    this._stderr = opts.stderr ?? ((s) => process.stderr.write(s));
    this._color = opts.color ?? (this.mode === "pretty" && process.stderr.isTTY === true);
    this._started = Date.now();
  }

  /** Free-form pretty output to stderr. Suppressed in json/ndjson modes. */
  info(msg: string): void {
    if (this.mode !== "pretty") return;
    this._stderr(`${msg}\n`);
  }

  /**
   * Caution-line output. Always shows in pretty mode (yellow), and is
   * collected into the final envelope's `warnings[]` for structured modes.
   */
  warn(msg: string): void {
    this._warnings.push(msg);
    if (this.mode === "pretty") {
      this._stderr(`${color(this._color, "yellow", "⚠")} ${msg}\n`);
    }
  }

  /**
   * Streaming event. Emitted as a JSON line in ndjson mode, ignored in
   * json mode (callers should prefer the final result envelope), and
   * pretty-printed (dimmed) in pretty mode.
   */
  event(type: string, data: unknown = {}): void {
    if (this.mode === "ndjson") {
      const evt: HarnessEvent = {
        schema: SCHEMA_VERSION,
        verb: this.verb,
        ts: new Date().toISOString(),
        type,
        data,
      };
      this._stdout(JSON.stringify(evt) + "\n");
    } else if (this.mode === "pretty") {
      const ds = data && Object.keys(data as object).length > 0
        ? ` ${color(this._color, "dim", JSON.stringify(data))}`
        : "";
      this._stderr(`${color(this._color, "cyan", `· ${type}`)}${ds}\n`);
    }
    // json mode: silently dropped. Events are for streaming, not snapshots.
  }

  /**
   * Plain-text passthrough to stdout. Use for raw content that should
   * be pipeable (e.g. `harness ideas show` returning the file body).
   * Suppressed in json/ndjson — callers should put structured data in
   * the envelope.
   */
  stdout(s: string): void {
    if (this.mode !== "pretty") return;
    this._stdout(s);
  }

  /** Final success envelope. Marks the output settled. */
  result(data: unknown, hint?: string): SuccessEnvelope {
    if (this._settled) throw new Error("Output already settled");
    this._settled = true;

    const envelope: SuccessEnvelope = {
      schema: SCHEMA_VERSION,
      verb: this.verb,
      ok: true,
      data,
      warnings: this._warnings,
      ...(hint ? { hint } : {}),
      duration_ms: Date.now() - this._started,
    };

    if (this.mode === "json" || this.mode === "ndjson") {
      this._stdout(JSON.stringify(envelope) + "\n");
    } else if (hint) {
      this._stderr(`${color(this._color, "dim", `→ ${hint}`)}\n`);
    }
    return envelope;
  }

  /** Final error envelope. Marks the output settled. */
  error(
    code: ErrorCode,
    message: string,
    opts: { hint?: string; recoverable?: boolean; details?: Record<string, unknown> } = {}
  ): ErrorEnvelope {
    if (this._settled) throw new Error("Output already settled");
    this._settled = true;

    const envelope: ErrorEnvelope = {
      schema: SCHEMA_VERSION,
      verb: this.verb,
      ok: false,
      error: {
        code,
        message,
        ...(opts.recoverable !== undefined ? { recoverable: opts.recoverable } : {}),
        ...(opts.details ? { details: opts.details } : {}),
      } satisfies HarnessError,
      ...(opts.hint ? { hint: opts.hint } : {}),
      duration_ms: Date.now() - this._started,
    };

    if (this.mode === "json" || this.mode === "ndjson") {
      this._stdout(JSON.stringify(envelope) + "\n");
    } else {
      this._stderr(`${color(this._color, "red", `✗ ${code}`)}: ${message}\n`);
      if (opts.hint) {
        this._stderr(`${color(this._color, "dim", `→ ${opts.hint}`)}\n`);
      }
    }
    return envelope;
  }

  get settled(): boolean {
    return this._settled;
  }
}

/** Convenience: pick mode from CLI flags. */
export function modeFromFlags(flags: { json?: boolean; ndjson?: boolean }): OutputMode {
  if (flags.ndjson) return "ndjson";
  if (flags.json) return "json";
  return "pretty";
}
