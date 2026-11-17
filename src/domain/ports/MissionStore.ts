import type { MissionState, StopReason } from "../missions/mission.js";

export interface MissionRow {
  id: string;
  tenantId: string;
  chatId: string;
  state: MissionState;
  stopReason: StopReason | null;
  newContact: boolean;
  deadlineAt: string;
  nextWakeAt: string | null;
  createdAt: string;
  endedAt: string | null;
  sentCount: number;
  reminderCount: number;
  llmCalls: number;
  lastAgentAt: string | null;
  lastInboundAt: string | null;
  closingMessage: string | null;
  expectsFiles: boolean;
  noticeSeen: boolean;
}

/** What a new mission needs; counters, state and timestamps start at their defaults. */
export type NewMission = Pick<
  MissionRow,
  "tenantId" | "chatId" | "newContact" | "deadlineAt" | "expectsFiles"
> &
  Partial<Pick<MissionRow, "nextWakeAt" | "closingMessage">>;

/** Mission metadata (no content: that is sealed in the tenant's `MissionLog`). */
export interface MissionStore {
  create(q: NewMission): MissionRow;
  get(tenantId: string, id: string): MissionRow | null;
  list(tenantId: string, state?: MissionState): MissionRow[];
  update(id: string, patch: Partial<Omit<MissionRow, "id" | "tenantId">>): void;
  /** Active missions whose `nextWakeAt` is at or before `nowIso`. */
  due(nowIso: string): MissionRow[];
  countActive(tenantId: string): number;
  /** Missions with `newContact` created at or after `dayStartIso`. */
  countNewContactToday(tenantId: string, dayStartIso: string): number;
  /** Terminal missions whose outcome the owner has not been told yet. */
  unseenOutcomes(tenantId: string): MissionRow[];
  markSeen(ids: string[]): void;
  /** Ids of the tenant's missions that ended before `iso` (feeds `MissionLog.purgeMissions`). */
  endedBefore(tenantId: string, iso: string): string[];
  /** Deletes the given missions of the tenant (retention, after their log was purged). */
  deleteMissions(tenantId: string, ids: string[]): void;
  /** Terminal missions whose `nextWakeAt` is due: a closing line postponed (quiet hours, pause). */
  dueClosings(nowIso: string): MissionRow[];
  /**
   * WhatsApp's reach-out timelock on a tenant (from `session.status`); kept across restarts so a
   * deploy never lifts a pause. `paused: false` lifts it.
   */
  setPaused(tenantId: string, paused: boolean, atIso: string): void;
  pausedTenants(): string[];
  /** Deletes the tenant's missions and its pause. */
  deleteForTenant(tenantId: string): void;
}
