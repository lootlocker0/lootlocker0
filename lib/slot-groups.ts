export type SlotSummary = {
  id: string;
  label: string;
  startTime: string;
  location: string;
  serviceDate: string;
  remaining: number;
  full: boolean;
};

export type SlotDayGroup = {
  dateKey: string;
  heading: string;
  slots: SlotSummary[];
};

function formatDateKeyHeading(dateKey: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "UTC",
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(new Date(dateKey));
}

export function groupSlotsByDate(slots: SlotSummary[]): SlotDayGroup[] {
  const byDate = new Map<string, SlotSummary[]>();

  for (const slot of [...slots].sort((a, b) => {
    const dateOrder = a.serviceDate.localeCompare(b.serviceDate);
    if (dateOrder !== 0) return dateOrder;
    return a.startTime.localeCompare(b.startTime);
  })) {
    const bucket = byDate.get(slot.serviceDate) ?? [];
    bucket.push(slot);
    byDate.set(slot.serviceDate, bucket);
  }

  return Array.from(byDate.entries()).map(([dateKey, daySlots]) => ({
    dateKey,
    heading: formatDateKeyHeading(dateKey),
    slots: daySlots,
  }));
}
