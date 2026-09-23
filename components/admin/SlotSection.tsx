import { AngledPanel } from "@/components/ui/AngledPanel";
import { formatCents } from "@/lib/money";
import { formatSlotTime } from "@/lib/timezone";
import { OrderRow } from "./OrderRow";
import type { AdminSlot } from "./types";

/**
 * One pickup window: the shelf-pull list (what to physically pull, summed
 * over RESERVED/PAID/PACKED per §6a) followed by every listed order for that
 * window. `counts.total` vs `counts.listed` is rendered explicitly — a staff
 * member who cannot explain why a window looks "full" against a shorter
 * printed list stops trusting the screen (§6a's own framing).
 */
export function SlotSection({
  slot,
  onOrderChanged,
  onUnauthorized,
}: {
  slot: AdminSlot;
  onOrderChanged: () => void;
  onUnauthorized: () => void;
}) {
  const notListed = slot.counts.total - slot.counts.listed;

  return (
    <div className="admin-page-break">
      <AngledPanel
        as="section"
        variant="panel"
        tone={3}
        border={slot.active ? "brand" : "none"}
        className="mb-4"
      >
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="font-display text-headline-md uppercase text-text">
            {formatSlotTime(slot.startTime)} · {slot.label}
            {!slot.active && (
              <span className="ml-3 border-2 border-danger px-2 py-0.5 align-middle font-mono text-[11px] text-danger">
                INACTIVE — orders still valid
              </span>
            )}
          </h3>
          <p className="font-mono text-xs text-text-dim">{slot.location}</p>
        </div>

        <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 font-mono text-xs text-text-dim sm:grid-cols-4">
          <div>
            <dt className="text-text-faint">Booked</dt>
            <dd className="text-text">
              {slot.bookedCount}/{slot.capacity} ({slot.remaining} left)
            </dd>
          </div>
          <div>
            <dt className="text-text-faint">Listed here</dt>
            <dd className="text-text">
              {slot.counts.listed} of {slot.counts.total}
            </dd>
          </div>
          <div>
            <dt className="text-text-faint">Cash still due</dt>
            <dd className="text-gold">{formatCents(slot.cashDueCents)}</dd>
          </div>
          <div>
            <dt className="text-text-faint">Not shown</dt>
            <dd className="text-text">
              {notListed > 0 ? `${notListed} (unpaid, cancelled, or expired)` : "0"}
            </dd>
          </div>
        </dl>

        {slot.productTotals.length > 0 && (
          <div className="mt-3 border-t border-white/10 pt-3">
            <p className="font-mono text-[11px] uppercase tracking-wide text-text-faint">
              Shelf pull for this window
            </p>
            <ul className="mt-1 flex flex-wrap gap-x-5 gap-y-1 font-mono text-xs text-text">
              {slot.productTotals.map((pt) => (
                <li key={pt.productId}>
                  {pt.qty}× {pt.nameSnapshot}
                  {pt.allergens.length > 0 && (
                    <span className="font-bold text-danger"> [{pt.allergens.join(", ")}]</span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
      </AngledPanel>

      {slot.orders.length === 0 ? (
        <p className="border border-white/10 bg-surface-2 p-4 text-sm text-text-dim">
          No orders to show for this window.
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          {slot.orders.map((order) => (
            <OrderRow
              key={order.orderNumber}
              order={order}
              onChanged={onOrderChanged}
              onUnauthorized={onUnauthorized}
            />
          ))}
        </div>
      )}
    </div>
  );
}
