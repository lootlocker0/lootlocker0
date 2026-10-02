import { describe, expect, it } from "vitest";
import { groupSlotsByDate, type SlotSummary } from "@/lib/slot-groups";

describe("pickup slot grouping", () => {
  it("orders future dates and keeps all time slots under their matching day", () => {
    const slots: SlotSummary[] = [
      {
        id: "s-2",
        serviceDate: "2026-09-18T00:00:00.000Z",
        startTime: "12:20",
        label: "Lunch B",
        location: "Cafeteria",
        remaining: 10,
        full: false,
      },
      {
        id: "s-1",
        serviceDate: "2026-09-17T00:00:00.000Z",
        startTime: "11:30",
        label: "Lunch A",
        location: "Cafeteria",
        remaining: 10,
        full: false,
      },
      {
        id: "s-3",
        serviceDate: "2026-09-17T00:00:00.000Z",
        startTime: "14:00",
        label: "Lunch C",
        location: "Cafeteria",
        remaining: 10,
        full: false,
      },
    ];

    const groups = groupSlotsByDate(slots);

    expect(groups.map((group) => group.dateKey)).toEqual([
      "2026-09-17T00:00:00.000Z",
      "2026-09-18T00:00:00.000Z",
    ]);
    expect(groups[0].slots.map((slot) => slot.startTime)).toEqual(["11:30", "14:00"]);
    expect(groups[0].heading).toMatch(/Sep 17|Thu/);
  });
});
