export type MissionLogKind =
  | "prompt"
  | "spec"
  | "message"
  | "notice"
  | "question"
  | "answer"
  | "summary"
  | "collected"
  /** A WhatsApp message id the engine sent (tells its own echoes from the owner's sends). */
  | "sent";

export interface MissionLogEntry {
  kind: MissionLogKind;
  /** ISO timestamp. */
  at: string;
  body: unknown;
}

/** Mission content of one tenant, sealed per entry. */
export interface MissionLog {
  append(missionId: string, entry: MissionLogEntry): void;
  read(missionId: string): MissionLogEntry[];
  /** Removes the content of the given missions (ids from `MissionStore.endedBefore`). */
  purgeMissions(missionIds: string[]): void;
  deleteAll(): void;
}
