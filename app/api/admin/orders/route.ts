import type { NextRequest } from "next/server";
import type { Allergen, OrderStatus } from "@prisma/client";
import { db } from "@/lib/db";
import { AppError, errorResponse } from "@/lib/errors";
import { requireAdminSession } from "@/lib/admin-session";
import { adminOrdersQuerySchema } from "@/lib/validation";
import { serviceDateFloorForToday } from "@/lib/timezone";
import { cashDueCents, unionAllergens } from "@/lib/db/admin";
import { capacityFor, parsePickupWindowId, windowsForDay } from "@/lib/pickup-windows";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// THE PICK LIST. One service day, grouped by pickup window, in the order staff
// physically work: window by window, student by student, allergens on every
// line.
//
// This is the screen someone is holding at 12:15 with a queue forming, and the
// P4 gate is "a staff member can run a full lunch service from it" — including
// the offline fallback of printing it before service starts. So it returns
// everything needed to pack and hand out bags in ONE request: no per-order
// round trip, no lazy loading, nothing that needs a network at the locker.
//
// PII: `studentName` and `homeroom` only. No email and no phone appear in this
// response at any nesting level (lib/db/admin.ts holds the projection). Staff
// need to identify a person standing in front of them, not contact them; a
// printed sheet of children's phone numbers left on a cafeteria table is a
// worse failure than an unclaimed bag (CLAUDE.md §2.6).

/// What staff are working on. Deliberately EXCLUDES `PENDING`.
///
/// A `PENDING` card order is holding a seat and stock but nobody has paid for
/// it and it may evaporate when the sweep runs. This response is what gets
/// printed, and a printed pick list containing unpaid orders is a bag packed
/// and handed to a student who never paid. It is still visible on request
/// (`?status=PENDING`) — hidden by default, not unreachable — and the seat
/// arithmetic below explains where it went.
///
/// `CANCELLED` and `EXPIRED` are excluded because they released everything they
/// held and are pure noise on a working screen. `REFUNDED` IS included: it
/// still holds its stock and its seat (see the refund route) and staff need to
/// see it to reconcile the shelf.
const DEFAULT_STATUSES: readonly OrderStatus[] = [
  "RESERVED",
  "PAID",
  "PACKED",
  "PICKED_UP",
  "REFUNDED",
];

/// Which orders are counted into the "pull this off the shelf" totals: money is
/// committed and a bag either exists or has to. `PICKED_UP` is out (already
/// gone) and so is `REFUNDED` (not being handed to anyone).
const PACKABLE: ReadonlySet<OrderStatus> = new Set<OrderStatus>([
  "RESERVED",
  "PAID",
  "PACKED",
]);

/// `YYYY-MM-DD` -> the midnight-UTC date key `Order.pickupServiceDate` is
/// stored as. The round-trip check rejects `2026-02-31`, which `new Date` would
/// silently roll forward to March — a staff member typing a date that does not
/// exist should be told, not shown the wrong day's orders.
function parseServiceDate(ymd: string): Date {
  const d = new Date(`${ymd}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== ymd) {
    throw new AppError("INVALID_INPUT", {
      fields: { date: ["Not a real calendar date."] },
    });
  }
  return d;
}

export async function GET(req: NextRequest) {
  try {
    requireAdminSession(req);

    const parsed = adminOrdersQuerySchema.safeParse(
      Object.fromEntries(req.nextUrl.searchParams),
    );
    if (!parsed.success) {
      throw new AppError("INVALID_INPUT", {
        fields: parsed.error.flatten().fieldErrors,
      });
    }
    const q = parsed.data;

    const visible = new Set<OrderStatus>(
      q.status.length > 0 ? q.status : DEFAULT_STATUSES,
    );

    // "Today" is the school's calendar day, not the server's (lib/timezone.ts).
    // On a UTC host, server-local midnight is 17:00 the previous afternoon in
    // Vancouver, so a naive default would hand staff yesterday's list for the
    // first seven hours of every UTC day.
    const serviceDate = q.date
      ? parseServiceDate(q.date)
      : serviceDateFloorForToday();

    // When a specific window is named, the date filter is dropped rather than
    // intersected. Staff at a locker have one window id and no reason to also
    // know its calendar day; intersecting would answer a mistyped date with an
    // empty screen mid-service. The `serviceDate` in the response says which
    // day was actually returned.
    const windowKey = q.slotId ? parsePickupWindowId(q.slotId) : null;
    if (q.slotId && !windowKey) {
      throw new AppError("INVALID_INPUT", {
        fields: { slotId: ["Not a valid pickup window id."] },
      });
    }
    const day = windowKey ? windowKey.serviceDate : serviceDate;

    // There is no pickup-slot row to enumerate anymore, so the day's windows
    // come from the template directly (windowsForDay, NOT listPickupWindows —
    // that one only covers the live bookable range, and staff must be able to
    // pull up a day that has already happened). A window is included even
    // with zero orders, same as an empty-but-seeded row used to be, so staff
    // see "nothing booked here" rather than the window vanishing.
    const templateWindows = windowKey
      ? windowsForDay(day).filter(
          (w) => w.startTime === windowKey.startTime && w.location === windowKey.location,
        )
      : windowsForDay(day);

    const orders = await db.order.findMany({
      where: windowKey
        ? {
            pickupServiceDate: day,
            pickupStartTime: windowKey.startTime,
            pickupLocation: windowKey.location,
          }
        : { pickupServiceDate: day },
      // Every order in the day is fetched, including the statuses that will
      // not be listed, so the per-status counts below can explain the seat
      // arithmetic. One lunch service is tens of rows.
      orderBy: [
        { pickupStartTime: "asc" },
        { pickupLocation: "asc" },
        { studentName: "asc" },
        { pickupCode: "asc" },
      ],
      select: {
        pickupLabel: true,
        pickupStartTime: true,
        pickupLocation: true,
        pickupServiceDate: true,
        seatReleasedAt: true,
        orderNumber: true,
        pickupCode: true,
        studentName: true,
        homeroom: true,
        status: true,
        paymentMethod: true,
        subtotalCents: true,
        taxCents: true,
        totalCents: true,
        paidAt: true,
        expiresAt: true,
        createdAt: true,
        items: {
          orderBy: { nameSnapshot: "asc" },
          select: {
            productId: true,
            qty: true,
            nameSnapshot: true,
            unitPriceCents: true,
            raritySnapshot: true,
            allergensSnapshot: true,
          },
        },
      },
    });

    // A window whose (startTime, location) no longer appears in the CURRENT
    // template (the schedule changed since these orders were placed) has no
    // entry in templateWindows at all — add one, capacity-less, so its
    // orders are never silently dropped from a historical day's pick list.
    const windowsByKey = new Map<
      string,
      { label: string; startTime: string; location: string; serviceDate: Date; capacity: number | null }
    >();
    for (const w of templateWindows) {
      windowsByKey.set(`${w.startTime}|${w.location}`, w);
    }
    for (const o of orders) {
      const key = `${o.pickupStartTime}|${o.pickupLocation}`;
      if (!windowsByKey.has(key)) {
        windowsByKey.set(key, {
          label: o.pickupLabel,
          startTime: o.pickupStartTime,
          location: o.pickupLocation,
          serviceDate: o.pickupServiceDate,
          capacity: capacityFor(o.pickupStartTime, o.pickupLocation),
        });
      }
    }

    const ordersByWindow = new Map<string, typeof orders>();
    for (const o of orders) {
      const key = `${o.pickupStartTime}|${o.pickupLocation}`;
      const bucket = ordersByWindow.get(key);
      if (bucket) bucket.push(o);
      else ordersByWindow.set(key, [o]);
    }

    const payload = [...windowsByKey.values()]
      .sort((a, b) => a.startTime.localeCompare(b.startTime) || a.location.localeCompare(b.location))
      .map((w) => {
        const windowOrders = ordersByWindow.get(`${w.startTime}|${w.location}`) ?? [];

        const byStatus: Partial<Record<OrderStatus, number>> = {};
        for (const o of windowOrders) {
          byStatus[o.status] = (byStatus[o.status] ?? 0) + 1;
        }

        const listed = windowOrders.filter((o) => visible.has(o.status));

        // Everything that must physically exist in this window, summed across
        // the orders that still need a bag. Built from the LINE SNAPSHOTS,
        // never from the live product (CLAUDE.md §2.5) — a product renamed or
        // re-priced this morning must not change what a bag packed against
        // yesterday's order says it contains.
        const totals = new Map<
          string,
          { productId: string; nameSnapshot: string; qty: number; allergens: Set<Allergen> }
        >();
        for (const o of windowOrders) {
          if (!PACKABLE.has(o.status)) continue;
          for (const line of o.items) {
            const t = totals.get(line.productId) ?? {
              productId: line.productId,
              nameSnapshot: line.nameSnapshot,
              qty: 0,
              allergens: new Set<Allergen>(),
            };
            t.qty += line.qty;
            for (const a of line.allergensSnapshot) t.allergens.add(a);
            totals.set(line.productId, t);
          }
        }

        const ordersOut = listed.map((o) => ({
          orderNumber: o.orderNumber,
          // Staff read this aloud and type it back into the pickup route. It
          // is present for every listed order regardless of status — unlike
          // the student-facing receipt, which withholds it until the order is
          // claimable, because staff are the ones who verify it.
          pickupCode: o.pickupCode,
          studentName: o.studentName,
          homeroom: o.homeroom,
          status: o.status,
          paymentMethod: o.paymentMethod,
          subtotalCents: o.subtotalCents,
          taxCents: o.taxCents,
          totalCents: o.totalCents,
          /// Integer cents still to collect at the locker. 0 for every card
          /// order and for any cash order already recorded as paid.
          cashDueCents: cashDueCents(o),
          paidAt: o.paidAt,
          expiresAt: o.expiresAt,
          placedAt: o.createdAt,
          /// The union across this order's lines, in canonical enum order. A
          /// bag-label warning, NOT a replacement for the per-line lists below
          /// — it cannot say which item carries the peanuts. Render both, in
          /// full (CLAUDE.md §2.8).
          allergens: unionAllergens(o.items),
          items: o.items,
        }));

        // Replaces PickupSlot.bookedCount: how many orders in this window
        // currently hold a seat (seatReleasedAt still null), over EVERY order
        // regardless of listed visibility — the same "booked" book_pickup_
        // window() counts, computed here instead of re-queried.
        const bookedCount = windowOrders.filter((o) => o.seatReleasedAt === null).length;

        return {
          id: `${w.serviceDate.toISOString().slice(0, 10)}|${w.startTime}|${w.location}`,
          label: w.label,
          startTime: w.startTime,
          location: w.location,
          serviceDate: w.serviceDate,
          // Staff get the raw numbers students do not (GET /api/slots projects
          // these away). This is the screen where "why is the window full when
          // I only see 22 bags" has to be answerable. null only for a window
          // whose (startTime, location) no longer exists in the current
          // template — a historical day the schedule has since changed under.
          capacity: w.capacity,
          bookedCount,
          remaining: w.capacity === null ? null : Math.max(w.capacity - bookedCount, 0),
          counts: {
            /// Over EVERY order in the window, including statuses excluded
            /// from `orders` below. This is what reconciles `bookedCount`
            /// against a list that is shorter than it.
            total: windowOrders.length,
            listed: ordersOut.length,
            byStatus,
          },
          /// Total cash to collect in this window, integer cents.
          cashDueCents: ordersOut.reduce((a, o) => a + o.cashDueCents, 0),
          productTotals: [...totals.values()]
            .map((t) => ({
              productId: t.productId,
              nameSnapshot: t.nameSnapshot,
              qty: t.qty,
              allergens: unionAllergens([
                { allergensSnapshot: [...t.allergens] },
              ]),
            }))
            .sort((a, b) => a.nameSnapshot.localeCompare(b.nameSnapshot)),
          orders: ordersOut,
        };
      });

    return Response.json(
      {
        serviceDate: day,
        statuses: [...visible],
        slots: payload,
      },
      // Never cached. This is live operational state behind a staff cookie:
      // a shared cache keyed on the URL would serve one school's pick list —
      // children's names and live pickup codes — to whoever asked next.
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    return errorResponse(e);
  }
}
