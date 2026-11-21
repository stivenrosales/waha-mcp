import type { ScheduleRepeat } from "../schedules/recurrence.js";

export type ScheduleKind = "fixed" | "ai";
export type ScheduleState = "active" | "done" | "cancelled";

/** Schedule metadata. The message text / instruction lives sealed in `ScheduleLog`. */
export interface ScheduleRow {
  id: string;
  tenantId: string;
  chatId: string;
  kind: ScheduleKind;
  repeat: ScheduleRepeat;
  /** The original first occurrence (input to `occurrenceAt`). */
  firstAt: string;
  nextRunAt: string | null;
  runsDone: number;
  maxRuns: number;
  newContact: boolean;
  state: ScheduleState;
  createdAt: string;
  endedAt: string | null;
  /**
   * Follow-ups only ("if no reply within"): the anchor. The run is skipped when the contact
   * wrote in the chat after it. Null for a regular schedule.
   */
  followUpSince: string | null;
}

export type NewSchedule = Omit<
  ScheduleRow,
  "id" | "runsDone" | "state" | "createdAt" | "endedAt" | "followUpSince"
> & { followUpSince?: string | null };

export interface ScheduleStore {
  create(q: NewSchedule): ScheduleRow;
  get(tenantId: string, id: string): ScheduleRow | null;
  /** Active schedules of the tenant, newest first. */
  listActive(tenantId: string): ScheduleRow[];
  countActive(tenantId: string): number;
  /**
   * Active schedules of active tenants with `nextRunAt <= nowIso`, oldest first, leaving out
   * `excludeTenantIds` (tenants whose runtime cannot be opened right now).
   */
  due(nowIso: string, limit: number, excludeTenantIds?: string[]): ScheduleRow[];
  /**
   * Active schedules of active tenants whose run was claimed (`nextRunAt` null) and never
   * recorded: a shutdown, crash or database error between the claim and the record.
   */
  claimed(): ScheduleRow[];
  update(
    id: string,
    patch: Partial<Pick<ScheduleRow, "nextRunAt" | "runsDone" | "state" | "endedAt">>,
  ): void;
  countNewContactToday(tenantId: string, dayStartIso: string): number;
  endedBefore(tenantId: string, iso: string): string[];
  deleteSchedules(tenantId: string, ids: string[]): void;
  deleteForTenant(tenantId: string): void;
}
