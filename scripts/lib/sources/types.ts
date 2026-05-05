/**
 * scripts/lib/sources/types.ts
 *
 * Shared types for idea-capture sources. Every source returns
 * `RawCapture[]` — a stable shape that the harvester / capture command
 * writes into ideas/<slug>.md.
 */

export interface RawCapture {
  /** The verbatim title; required. */
  title: string;
  /** Optional free-form notes that ride along into the idea body. */
  notes?: string;
  /** Optional project key from projects.yml; if absent, the harvester resolves it. */
  project?: string;
  /**
   * Source-side identifier (e.g. Reminder UUID, GitHub issue URL) so the
   * source can mark/complete/dedupe later if it has that affordance.
   */
  external_id?: string;
}

export interface Source {
  /** Stable key for the --from flag and contract names. */
  readonly id: string;
  /** Whether the source is functional in the current env (e.g. Reminders → macOS only). */
  available(): boolean;
  /** Pull pending captures from the source. Returns [] if nothing's available. */
  fetch(opts?: { project?: string; raw?: string }): Promise<RawCapture[]>;
  /** Optional: mark a capture handled in the upstream system (Reminders → mark complete). */
  acknowledge?(capture: RawCapture): Promise<void>;
}
