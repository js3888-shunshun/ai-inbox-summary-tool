/**
 * Pure cadence logic — no I/O, fully unit-testable. Supported cadence strings
 * (stored per-grant in the DB, so changing cadence needs no code change):
 *   - "hourly"            → every hour
 *   - "every:<N>m"        → every N minutes
 *   - "every:<N>h"        → every N hours
 *   - "daily:HH:MM"       → once a day at HH:MM in the grant's timezone
 *
 * A "window" is the time slice a digest covers. `windowKeyAt` returns a
 * deterministic key for the window containing `now`; the scheduler uses it as
 * an idempotency key so each window fires exactly once.
 */
export type Cadence =
  | { kind: "interval"; ms: number }
  | { kind: "daily"; hour: number; minute: number };

/** Defaults applied to a freshly connected mailbox so it starts active, not unscheduled. */
export const DEFAULT_CADENCE = "daily:09:00";
export const DEFAULT_TIMEZONE = "UTC";

export function parseCadence(input: string): Cadence {
  if (input === "hourly") return { kind: "interval", ms: 3_600_000 };

  const interval = input.match(/^every:(\d+)([mh])$/);
  if (interval) {
    const n = Number(interval[1]);
    if (n <= 0) throw new Error(`Cadence interval must be positive: ${input}`);
    const unitMs = interval[2] === "h" ? 3_600_000 : 60_000;
    return { kind: "interval", ms: n * unitMs };
  }

  const daily = input.match(/^daily:(\d{2}):(\d{2})$/);
  if (daily) {
    const hour = Number(daily[1]);
    const minute = Number(daily[2]);
    if (hour > 23 || minute > 59) throw new Error(`Invalid daily time: ${input}`);
    return { kind: "daily", hour, minute };
  }

  throw new Error(`Unrecognized cadence: "${input}"`);
}

/** True if `input` is a valid cadence string. */
export function isValidCadence(input: string): boolean {
  try {
    parseCadence(input);
    return true;
  } catch {
    return false;
  }
}

/** UTC ms of the start of the window containing `nowMs`. */
export function windowStartAt(cadence: Cadence, nowMs: number, timezone = "UTC"): number {
  if (cadence.kind === "interval") {
    // Align interval boundaries to the epoch so they are stable across restarts.
    return Math.floor(nowMs / cadence.ms) * cadence.ms;
  }
  // daily: the most recent HH:MM (in `timezone`) at or before now.
  const today = zonedTimeToUtc(nowMs, cadence.hour, cadence.minute, timezone);
  return today <= nowMs ? today : today - 86_400_000;
}

/** Deterministic idempotency key for the window containing `nowMs`. */
export function windowKeyAt(
  cadenceString: string,
  cadence: Cadence,
  nowMs: number,
  timezone = "UTC",
): string {
  const start = windowStartAt(cadence, nowMs, timezone);
  return `${cadenceString}@${new Date(start).toISOString()}`;
}

/**
 * Convert a wall-clock HH:MM "today" in `timezone` to a UTC ms timestamp, using
 * the timezone's offset at `nowMs`. Avoids pulling in a date library.
 */
function zonedTimeToUtc(nowMs: number, hour: number, minute: number, timezone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(nowMs));
  const get = (t: string): number => Number(parts.find((p) => p.type === t)?.value);
  const y = get("year");
  const m = get("month");
  const d = get("day");

  const naiveUtc = Date.UTC(y, m - 1, d, hour, minute, 0);
  const offset = timezoneOffsetMs(naiveUtc, timezone);
  return naiveUtc - offset;
}

/** Offset (ms) of `timezone` from UTC at the given instant: localWall - utcWall. */
function timezoneOffsetMs(instantMs: number, timezone: string): number {
  const local = new Date(new Date(instantMs).toLocaleString("en-US", { timeZone: timezone }));
  const utc = new Date(new Date(instantMs).toLocaleString("en-US", { timeZone: "UTC" }));
  return local.getTime() - utc.getTime();
}
