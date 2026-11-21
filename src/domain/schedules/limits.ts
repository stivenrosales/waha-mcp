export interface ScheduleLimits {
  /** Active schedules one tenant may hold. */
  maxActivePerTenant: number;
  /** `max_runs` of a recurring schedule when the owner gives none. */
  defaultRuns: number;
  /** Highest `max_runs` a recurring schedule may have. */
  maxRuns: number;
  /** A run later than this is not sent: it is logged as `missed`. */
  missedAfterMinutes: number;
}

export const DEFAULT_SCHEDULE_LIMITS: ScheduleLimits = {
  maxActivePerTenant: 20,
  defaultRuns: 12,
  maxRuns: 52,
  missedAfterMinutes: 60,
};
