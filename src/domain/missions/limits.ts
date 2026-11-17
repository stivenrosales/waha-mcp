export interface MissionLimits {
  maxMessagesPerMission: number;
  maxActivePerTenant: number;
  maxNewContactsPerDay: number;
  maxReminders: number;
  maxRemindersNewContact: number;
  reminderGapMs: number;
  debounceMs: number;
  maxDurationMinutes: number;
  maxLlmCallsPerMission: number;
  quietStartHour: number;
  quietEndHour: number;
}

export const DEFAULT_MISSION_LIMITS: MissionLimits = {
  maxMessagesPerMission: 40,
  maxActivePerTenant: 3,
  maxNewContactsPerDay: 5,
  maxReminders: 2,
  maxRemindersNewContact: 1,
  reminderGapMs: 1_800_000,
  debounceMs: 15_000,
  maxDurationMinutes: 120,
  maxLlmCallsPerMission: 60,
  quietStartHour: 22,
  quietEndHour: 8,
};
