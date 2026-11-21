export type RunOutcome = "sent" | "skipped" | "failed" | "missed" | "unknown";

export interface ScheduleContent {
  text?: string;
  instruction?: string;
}

export interface ScheduleRun {
  at: string;
  outcome: RunOutcome;
  text?: string;
  reason?: string;
}

/** Sealed per-tenant schedule content and run history. */
export interface ScheduleLog {
  putContent(scheduleId: string, c: ScheduleContent): void;
  content(scheduleId: string): ScheduleContent | null;
  appendRun(scheduleId: string, run: ScheduleRun): void;
  /** Newest first. */
  runs(scheduleId: string, limit: number): ScheduleRun[];
  purgeRunsBefore(iso: string): void;
  deleteSchedules(ids: string[]): void;
}
