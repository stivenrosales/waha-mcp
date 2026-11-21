import { describe, expect, it } from "vitest";
import { InvalidInputError } from "../../../src/domain/errors.js";
import {
  formatLocal,
  occurrenceAt,
  parseLocalDateTime,
} from "../../../src/domain/schedules/recurrence.js";

const LIMA = "America/Lima";
const NY = "America/New_York";

describe("parseLocalDateTime", () => {
  it("parses local time in Lima", () => {
    expect(parseLocalDateTime("2026-12-05 09:00", LIMA).toISOString()).toBe(
      "2026-12-05T14:00:00.000Z",
    );
  });

  it("rejects bad format and impossible dates", () => {
    for (const text of ["2026-12-5 9:00", "2026-02-30 10:00", "2026-12-05 24:00", "nope"]) {
      expect(() => parseLocalDateTime(text, LIMA)).toThrow(InvalidInputError);
    }
    expect(() => parseLocalDateTime("2026-12-5 9:00", LIMA)).toThrow(
      "Use the format YYYY-MM-DD HH:mm, e.g. 2026-12-05 09:00.",
    );
  });
});

describe("occurrenceAt", () => {
  it("keeps local hour across DST", () => {
    const first = parseLocalDateTime("2026-03-07 09:00", NY);
    expect(formatLocal(occurrenceAt(first, "daily", 1, NY), NY)).toBe("2026-03-08 09:00");
    expect(formatLocal(occurrenceAt(first, "daily", 2, NY), NY)).toBe("2026-03-09 09:00");
  });

  it("monthly clamps and restores the day", () => {
    const first = parseLocalDateTime("2027-01-31 10:00", LIMA);
    expect(formatLocal(occurrenceAt(first, "monthly", 1, LIMA), LIMA)).toBe("2027-02-28 10:00");
    expect(formatLocal(occurrenceAt(first, "monthly", 2, LIMA), LIMA)).toBe("2027-03-31 10:00");
    expect(formatLocal(occurrenceAt(first, "monthly", 12, LIMA), LIMA)).toBe("2028-01-31 10:00");
  });

  it("yearly Feb 29", () => {
    const first = parseLocalDateTime("2028-02-29 08:00", LIMA);
    expect(formatLocal(occurrenceAt(first, "yearly", 1, LIMA), LIMA)).toBe("2029-02-28 08:00");
    expect(formatLocal(occurrenceAt(first, "yearly", 4, LIMA), LIMA)).toBe("2032-02-29 08:00");
  });

  it("weekly adds 7 days", () => {
    const first = parseLocalDateTime("2026-12-05 09:30", LIMA);
    expect(formatLocal(occurrenceAt(first, "weekly", 2, LIMA), LIMA)).toBe("2026-12-19 09:30");
  });

  it("none returns first for index 0", () => {
    const first = parseLocalDateTime("2026-12-05 09:00", LIMA);
    expect(occurrenceAt(first, "none", 0, LIMA).getTime()).toBe(first.getTime());
  });
});
