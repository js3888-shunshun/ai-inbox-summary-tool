import type { DB } from "../db/index.js";
import type { Schedule } from "../domain/types.js";

interface ScheduleRow {
  grant_id: string;
  cadence: string;
  timezone: string;
  enabled: number;
}

function toSchedule(row: ScheduleRow): Schedule {
  return {
    grantId: row.grant_id,
    cadence: row.cadence,
    timezone: row.timezone,
    enabled: row.enabled === 1,
  };
}

/** Upsert a grant's cadence. Stored in the DB so changes need no code change. */
export function saveSchedule(db: DB, s: Schedule): void {
  db.prepare(
    `INSERT INTO schedules (grant_id, cadence, timezone, enabled)
     VALUES (@grantId, @cadence, @timezone, @enabled)
     ON CONFLICT(grant_id) DO UPDATE SET
       cadence = excluded.cadence, timezone = excluded.timezone, enabled = excluded.enabled`,
  ).run({
    grantId: s.grantId,
    cadence: s.cadence,
    timezone: s.timezone,
    enabled: s.enabled ? 1 : 0,
  });
}

export function getSchedule(db: DB, grantId: string): Schedule | undefined {
  const row = db.prepare(`SELECT * FROM schedules WHERE grant_id = ?`).get(grantId) as
    | ScheduleRow
    | undefined;
  return row ? toSchedule(row) : undefined;
}

/** All enabled schedules — the scheduler iterates these each tick (per-grant). */
export function listEnabledSchedules(db: DB): Schedule[] {
  const rows = db.prepare(`SELECT * FROM schedules WHERE enabled = 1`).all() as ScheduleRow[];
  return rows.map(toSchedule);
}
