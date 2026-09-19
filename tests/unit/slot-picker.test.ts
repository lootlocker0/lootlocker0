import { describe, expect, it } from "vitest";
import { groupSlotsByDate } from "@/lib/slot-groups";

describe("pickup slot grouping", () => {
  it("orders future dates and keeps all time slots under their matching day", () => {
    const slots = [
      { id: "s-2", serviceDate: "2026-09-18T00:00:00.000Z", startTime: "12:20", label: "Lunch B" },
      { id: "s-1", serviceDate: "2026-09-17T00:00:00.000Z", startTime: "11:30", label: "Lunch A" },
      { id: "s-3", serviceDate: "2026-09-17T00:00:00.000Z", startTime: "14:00", label: "Lunch C" },
    ] as const;

    const groups = groupSlotsByDate(slots as any);

    expect(groups.map((group) => group.dateKey)).toEqual([
      "2026-09-17T00:00:00.000Z",
      "2026-09-18T00:00:00.000Z",
    ]);
    expect(groups[0].slots.map((slot) => slot.startTime)).toEqual(["11:30", "14:00"]);
    expect(groups[0].heading).toMatch(/Sep 17|Thu/);
  });
});
