import { db } from "@/lib/db";
import { errorResponse } from "@/lib/errors";
import { serviceDateFloorForToday, slotStartInstant } from "@/lib/timezone";
import { listPickupWindows, pickupWindowId } from "@/lib/pickup-windows";
import { listTestWindows } from "@/lib/pickup-windows-test";

export const runtime = "nodejs";

// This handler takes no request input, so without this Next is entitled to
// prerender it at build time — which would freeze both "today" and every
// booked_count into the deployment. Nothing about this response is static.
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    // FIXED IN P3 (docs/HANDOFF.md §3, §13). This used to be `new Date()` with
    // `setHours(0,0,0,0)` — server-local midnight, i.e. UTC on Vercel, so
    // between 00:00 and 07:00 UTC the server's "today" was already the school's
    // tomorrow and that evening's windows dropped off the list early.
    //
    // `serviceDateFloorForToday` returns the school's current calendar day as
    // midnight UTC, which is the convention `serviceDate` is stored in — a date
    // key compared against a date key. Note it is deliberately NOT the real
    // instant of Vancouver midnight (07:00Z); comparing that against a
    // `2026-09-03T00:00:00.000Z` service date would hide the current day's slots
    // every morning.
    const now = new Date();
    const today = serviceDateFloorForToday(now);

    // The windows themselves are computed live from the template
    // (lib/pickup-windows.ts), never read from a pre-seeded row — there is
    // no PickupSlot table to run dry anymore. `listPickupWindows` only drops
    // past DAYS — a today-dated window whose own startTime has already gone
    // by (it's 2pm and there was a 7:50am window) survives that, same as a
    // row used to. `POST /api/checkout` would refuse it with PAST_CUTOFF the
    // moment it was picked (`slotStartInstant(...) <= now`), so leaving it in
    // this list is not a softer rule, just a confusing one. Filter here with
    // the exact same instant check checkout uses, so a window never appears
    // choosable here and then isn't.
    // listTestWindows() is a no-op in production (see
    // lib/pickup-windows-test.ts) — it only ever returns anything when the
    // test harness's own server env opted in.
    const windows = [...(await listTestWindows()), ...listPickupWindows(now)].filter(
      (w) => slotStartInstant(w.serviceDate, w.startTime).getTime() > now.getTime(),
    );

    // One grouped count over live orders, replacing a row scan: "booked" is
    // never a stored counter, it's how many non-released orders exist for a
    // given (date, time, location) right now.
    const counts = await db.order.groupBy({
      by: ["pickupServiceDate", "pickupStartTime", "pickupLocation"],
      _count: { _all: true },
      where: { seatReleasedAt: null, pickupServiceDate: { gte: today } },
    });
    const bookedByWindow = new Map(
      counts.map((c) => [
        pickupWindowId(c.pickupServiceDate, c.pickupStartTime, c.pickupLocation),
        c._count._all,
      ]),
    );

    return Response.json(
      {
        slots: windows.map((w) => {
          const booked = bookedByWindow.get(w.id) ?? 0;
          return {
            id: w.id,
            label: w.label,
            startTime: w.startTime,
            location: w.location,
            serviceDate: w.serviceDate,
            // `capacity` and the live booked count never leave the server.
            // The client gets the derived numbers only, so nothing downstream
            // can be tempted to do its own `booked < capacity` check — that
            // read-then-write is exactly what book_pickup_window() exists to
            // prevent (CLAUDE.md §2.4).
            remaining: Math.max(w.capacity - booked, 0),
            full: booked >= w.capacity,
          };
        }),
      },
      // Deliberate, and not a performance trade-off. A cached slot list sends a
      // student into a window that filled up thirty seconds ago and turns into
      // a SLOT_FULL 409 at the worst possible moment — mid-checkout, at lunch.
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    return errorResponse(e);
  }
}
