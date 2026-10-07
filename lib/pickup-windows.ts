import { schoolParts } from "./timezone";

export type PickupWindowTemplateEntry = {
  label: string;
  startTime: string;
  location: string;
  capacity: number;
};

/**
 * Placeholder bell schedule. The real one, and the real per-slot handout
 * throughput, are school sign-off items (CLAUDE.md §7).
 *
 * Moved byte-for-byte from the old prisma/seed.ts `SLOT_TEMPLATE` — this
 * file changes WHERE the template lives and how availability is served,
 * never what it says. There is deliberately no PickupSlot database table
 * anymore: these four windows are generated live for "today" and the next
 * few school days, never pre-seeded, so there is no rolling window that can
 * run dry (docs/HANDOFF.md — the empty-slot-list production incident this
 * file exists to fix permanently).
 */
export const PICKUP_WINDOW_TEMPLATE: PickupWindowTemplateEntry[] = [
  { label: "Pickup 1", startTime: "07:50", location: "Locker B449", capacity: 24 },
  { label: "Pickup 2", startTime: "10:50", location: "Hub", capacity: 24 },
  { label: "Pickup 3", startTime: "11:20", location: "Hub", capacity: 18 },
  { label: "Pickup 4", startTime: "14:30", location: "Locker B449", capacity: 18 },
];

/** How many school days ahead (today inclusive) the picker offers. Was
 * `SLOT_DAYS` in prisma/seed.ts — now the live window size, not a seed
 * horizon. */
export const PICKUP_WINDOW_DAYS = 7;

export type PickupWindow = {
  /** Composite, stable, readable. Nothing about a window's date/time/
   * location is sensitive — GET /api/slots already echoes all three in
   * plaintext — so there is no reason to obscure it. */
  id: string;
  label: string;
  startTime: string;
  location: string;
  /** Midnight UTC of the service day — the same storage convention the old
   * PickupSlot.serviceDate used (lib/timezone.ts's serviceDateFloorForToday). */
  serviceDate: Date;
  capacity: number;
};

/** UTC-midnight date key for the school's calendar day plus offset. Matches
 * prisma/seed.ts's old `serviceDay()` exactly — moved here, not changed. */
function serviceDay(offset: number, now: Date): Date {
  const p = schoolParts(now);
  return new Date(Date.UTC(p.year, p.month - 1, p.day + offset));
}

export function pickupWindowId(serviceDate: Date, startTime: string, location: string): string {
  return `${serviceDate.toISOString().slice(0, 10)}|${startTime}|${location}`;
}

/** Today..+(PICKUP_WINDOW_DAYS-1) school days, each crossed with the fixed
 * template. Does NOT filter by cutoff time — callers that need "is this
 * actually still bookable right now" apply `slotStartInstant()` themselves,
 * exactly as when these were database rows. */
export function listPickupWindows(now: Date = new Date()): PickupWindow[] {
  const windows: PickupWindow[] = [];
  for (let day = 0; day < PICKUP_WINDOW_DAYS; day++) {
    const serviceDate = serviceDay(day, now);
    for (const t of PICKUP_WINDOW_TEMPLATE) {
      windows.push({
        id: pickupWindowId(serviceDate, t.startTime, t.location),
        label: t.label,
        startTime: t.startTime,
        location: t.location,
        serviceDate,
        capacity: t.capacity,
      });
    }
  }
  return windows;
}

/** Resolves a composite window id back to one window, the same way
 * `db.pickupSlot.findUnique` used to. Returns null for a garbage id or one
 * outside today..+(PICKUP_WINDOW_DAYS-1) — the same "missing" signal a
 * deleted/out-of-range PickupSlot row used to produce, which callers (e.g.
 * checkout) already treat as SLOT_FULL rather than as an existence oracle. */
export function findPickupWindow(id: string, now: Date = new Date()): PickupWindow | null {
  return listPickupWindows(now).find((w) => w.id === id) ?? null;
}

/** The fixed template applied to one SPECIFIC calendar day, regardless of
 * whether that day is in the past, today, or far in the future — unlike
 * `listPickupWindows()`, which only covers the live rolling range a student
 * can actually book into. The admin pick list needs this: staff must be able
 * to pull up (and reconcile) a day that has already happened. */
export function windowsForDay(serviceDate: Date): PickupWindow[] {
  return PICKUP_WINDOW_TEMPLATE.map((t) => ({
    id: pickupWindowId(serviceDate, t.startTime, t.location),
    label: t.label,
    startTime: t.startTime,
    location: t.location,
    serviceDate,
    capacity: t.capacity,
  }));
}

export type PickupWindowKey = { serviceDate: Date; startTime: string; location: string };

/** Splits a composite window id back into its three parts, with no check
 * that it falls within the current bookable range — unlike
 * `findPickupWindow()`, this resolves an id for ANY date, including a past
 * one, which the admin pick list's `?slotId=` filter needs. Returns null
 * only for a malformed id (wrong shape, or an unparseable date). */
export function parsePickupWindowId(id: string): PickupWindowKey | null {
  const parts = id.split("|");
  if (parts.length !== 3) return null;
  const [dateStr, startTime, location] = parts;
  if (!startTime || !location) return null;
  const serviceDate = new Date(`${dateStr}T00:00:00.000Z`);
  if (Number.isNaN(serviceDate.getTime()) || serviceDate.toISOString().slice(0, 10) !== dateStr) {
    return null;
  }
  return { serviceDate, startTime, location };
}

/** Capacity for a (startTime, location) pair from the CURRENT template, or
 * null if that pair no longer appears in it (the schedule changed since an
 * old order was placed). Display-only, for the admin pick list — never used
 * for booking enforcement, which always re-resolves a window by id. */
export function capacityFor(startTime: string, location: string): number | null {
  const entry = PICKUP_WINDOW_TEMPLATE.find(
    (t) => t.startTime === startTime && t.location === location,
  );
  return entry?.capacity ?? null;
}
