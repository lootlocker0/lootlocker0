// The school's clock. Pinned, not inherited from the server.
//
// docs/HANDOFF.md §3: `new Date(slot.serviceDate).setHours(h, m)` is
// server-local arithmetic. Vercel runs UTC, the school does not, and the
// difference lands the cutoff on the wrong calendar day — ordering either
// closes an hour early or stays open past the bell. Confirmed by the manager:
// the school is in America/Vancouver. Nothing in this project may read a wall
// clock from `TZ`, `setHours`, `getHours`, `getFullYear` or friends; it comes
// from here.
//
// No dependency is added for this. `Intl.DateTimeFormat` already ships the IANA
// database in Node, and it tracks DST correctly (Vancouver is UTC-8 in winter,
// UTC-7 in summer), which is the entire reason a fixed offset constant would be
// wrong.

export const SCHOOL_TZ = "America/Vancouver";

/// `HH:MM`, 24h, zero-padded. `PickupSlot.startTime` must match this exactly —
/// `"9:5"` or `"24:00"` are rejected rather than coerced, because coercing a
/// malformed bell time silently moves when ordering closes.
const HH_MM = /^([01]\d|2[0-3]):([0-5]\d)$/;

const SCHOOL_PARTS = new Intl.DateTimeFormat("en-CA", {
  timeZone: SCHOOL_TZ,
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

export interface SchoolClockParts {
  year: number;
  month: number; // 1-12, not the 0-11 that Date uses
  day: number;
  hour: number;
  minute: number;
  second: number;
}

export function formatSlotTime(startTime: string): string {
  const match = HH_MM.exec(startTime);
  if (!match) return startTime;

  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const hour12 = hour % 12 || 12;
  const suffix = hour < 12 ? "am" : "pm";

  return `${hour12}:${String(minute).padStart(2, "0")} ${suffix}`;
}

/// What the clock on the cafeteria wall reads at a given instant.
export function schoolParts(instant: Date = new Date()): SchoolClockParts {
  const map: Record<string, string> = {};
  for (const p of SCHOOL_PARTS.formatToParts(instant)) {
    if (p.type !== "literal") map[p.type] = p.value;
  }
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: Number(map.hour),
    minute: Number(map.minute),
    second: Number(map.second),
  };
}

/// The school zone's UTC offset at a given instant, in milliseconds
/// (negative west of Greenwich: -8h in PST, -7h in PDT).
function schoolOffsetMs(instant: Date): number {
  const p = schoolParts(instant);
  const asIfUtc = Date.UTC(
    p.year,
    p.month - 1,
    p.day,
    p.hour,
    p.minute,
    p.second,
    instant.getUTCMilliseconds(),
  );
  return asIfUtc - instant.getTime();
}

/// A wall-clock reading in the school's zone -> the real UTC instant.
///
/// Two passes: guess the offset by pretending the wall clock is UTC, then
/// re-derive it at the corrected instant. One correction is enough for every
/// real zone — the second pass only differs within an hour of a DST boundary.
///
/// DST edge cases, stated rather than hidden: on the spring-forward morning
/// 02:00-02:59 does not exist locally and resolves to 03:00; on the
/// fall-back morning 01:00-01:59 happens twice and resolves to the first
/// (still-daylight-time) occurrence. Neither window can contain a lunch
/// service, so this is documented, not defended against.
export function schoolWallClockToInstant(
  year: number,
  month: number, // 1-12
  day: number,
  hour: number,
  minute: number,
): Date {
  const asIfUtc = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  const firstGuess = new Date(asIfUtc - schoolOffsetMs(new Date(asIfUtc)));
  const corrected = asIfUtc - schoolOffsetMs(firstGuess);
  return new Date(corrected);
}

/// The instant at which the school's current calendar day began.
///
/// This is a real point in time, so it is the right boundary for filtering a
/// real timestamp column — `Order.createdAt` in the daily spend cap. "Today"
/// means the school's today, so a student's cap resets at local midnight and
/// not at 16:00 the previous afternoon.
export function schoolDayStartInstant(now: Date = new Date()): Date {
  const p = schoolParts(now);
  return schoolWallClockToInstant(p.year, p.month, p.day, 0, 0);
}

/// The school's current calendar day, expressed the way `PickupSlot.serviceDate`
/// is *stored*: midnight UTC of that date.
///
/// This is deliberately NOT `schoolDayStartInstant`. `serviceDate` is a date
/// key wearing a timestamp's clothes (schema.prisma says so), written as
/// `2026-09-03T00:00:00.000Z` for the 3rd of September. Comparing it against
/// the real instant of Vancouver midnight (`2026-09-03T07:00:00.000Z`) would
/// drop the current day's slots every morning. Compare a date key to a date key.
export function serviceDateFloorForToday(now: Date = new Date()): Date {
  const p = schoolParts(now);
  return new Date(Date.UTC(p.year, p.month - 1, p.day, 0, 0, 0, 0));
}

/// The real instant a pickup window starts, from the two halves the database
/// stores: a service-day key and a local wall-clock `"HH:MM"`.
///
/// The calendar day is read with UTC getters on purpose. `serviceDate` is a
/// date key stored at midnight UTC; reading it with local getters would shift
/// it to the previous day on any server west of Greenwich, which is the exact
/// bug this module exists to remove. (It also stays correct if a future writer
/// stores Vancouver-local midnight instead, since 07:00/08:00Z is still the
/// same UTC calendar day.)
///
/// Throws on a malformed `startTime`. That is bad seed data, not bad user
/// input: it surfaces as a 500, which is the correct loudness for "the bell
/// schedule in the database is not a time".
export function slotStartInstant(serviceDate: Date, startTime: string): Date {
  const m = HH_MM.exec(startTime);
  if (!m) {
    throw new Error(
      `PickupSlot.startTime must be zero-padded 24h "HH:MM"; got ${JSON.stringify(startTime)}`,
    );
  }
  return schoolWallClockToInstant(
    serviceDate.getUTCFullYear(),
    serviceDate.getUTCMonth() + 1,
    serviceDate.getUTCDate(),
    Number(m[1]),
    Number(m[2]),
  );
}
