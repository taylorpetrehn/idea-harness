/**
 * scripts/lib/metrics.ts
 *
 * Rolling counters at state/metrics.json. Cheap, file-backed, additive only.
 * Used to track accept rate, time-to-decision, escalation rate over time —
 * surfaced by `harness inspect`.
 */

import * as fs from "fs";
import * as path from "path";

const STATE_DIR = path.join(__dirname, "..", "..", "state");
const METRICS_FILE = path.join(STATE_DIR, "metrics.json");

export interface Metrics {
  counters: Record<string, number>;
  events: Array<{ at: string; key: string; delta: number }>;
}

export function readMetrics(): Metrics {
  if (!fs.existsSync(METRICS_FILE)) return { counters: {}, events: [] };
  try {
    const parsed = JSON.parse(fs.readFileSync(METRICS_FILE, "utf8")) as Partial<Metrics>;
    return {
      counters: parsed.counters ?? {},
      events: parsed.events ?? [],
    };
  } catch {
    return { counters: {}, events: [] };
  }
}

export function recordMetric(key: string, delta: number): void {
  if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true });
  const m = readMetrics();
  m.counters[key] = (m.counters[key] ?? 0) + delta;
  m.events.push({ at: new Date().toISOString(), key, delta });
  // Keep only the most recent ~500 events to bound file size.
  if (m.events.length > 500) m.events = m.events.slice(-500);
  fs.writeFileSync(METRICS_FILE, JSON.stringify(m, null, 2), "utf8");
}
