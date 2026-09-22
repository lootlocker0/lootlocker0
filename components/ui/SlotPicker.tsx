"use client";

import { useMemo, useState } from "react";
import { formatSlotTime } from "@/lib/timezone";
import { groupSlotsByDate, type SlotSummary } from "@/lib/slot-groups";

/**
 * Explicit date-first picker: the student chooses a service date and then picks
 * one of that day's windows. This makes future dates visible and prevents the
 * empty, ambiguous "pickup window" state that happened when only a flat list was
 * rendered without a date control.
 */
export function SlotPicker({
  slots, value, onChange,
}: {
  slots: SlotSummary[];
  value: string | null;
  onChange: (id: string) => void;
}) {
  const groups = useMemo(
    () =>
      groupSlotsByDate(slots).filter((group) => {
        const day = new Date(group.dateKey).getUTCDay();
        return day !== 0 && day !== 6;
      }),
    [slots],
  );
  const [selectedDate, setSelectedDate] = useState<string | null>(groups[0]?.dateKey ?? null);
  const [selectedManualTime, setSelectedManualTime] = useState<string | null>(null);
  const [fulfillment, setFulfillment] = useState<"delivery" | "pickup">("pickup");
  const [pickupLocation, setPickupLocation] = useState("Locker A157");

  const pickupLocations = ["Locker A157", "The Hub", "E-wing stairs"];

  const effectiveSelectedDate =
    selectedDate && groups.some((group) => group.dateKey === selectedDate)
      ? selectedDate
      : groups[0]?.dateKey ?? null;

  const visibleSlots = effectiveSelectedDate
    ? groups.find((group) => group.dateKey === effectiveSelectedDate)?.slots ?? []
    : [];

  const upcomingDates = useMemo(() => {
    const today = new Date();
    return Array.from({ length: 7 }, (_, index) => {
      const date = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + index));
      return {
        key: date.toISOString().slice(0, 10),
        day: date.getUTCDay(),
        label: new Intl.DateTimeFormat("en-CA", {
          timeZone: "UTC",
          weekday: "short",
          month: "short",
          day: "numeric",
        }).format(date),
      };
    }).filter((date) => date.day !== 0 && date.day !== 6);
  }, []);

  return (
    <fieldset>
      <legend className="font-display text-headline-md uppercase text-text">
        Collection point
      </legend>

      <div className="mt-4 grid grid-cols-2 gap-2" role="radiogroup" aria-label="Collection method">
        {(["delivery", "pickup"] as const).map((method) => (
          <label
            key={method}
            className={`clip-panel cursor-pointer border-2 p-3 transition-colors focus-within:outline focus-within:outline-[3px] focus-within:outline-gold ${
              fulfillment === method
                ? "border-gold bg-gold/10"
                : "border-white/10 bg-surface-2 hover:border-brand/50"
            }`}
          >
            <input
              type="radio"
              name="fulfillment"
              value={method}
              checked={fulfillment === method}
              onChange={() => setFulfillment(method)}
              className="sr-only"
            />
            <span className="font-display uppercase text-text">
              {method === "delivery" ? "Delivery" : "Pickup"}
            </span>
          </label>
        ))}
      </div>

      {fulfillment === "pickup" && (
        <fieldset className="mt-4 border-t border-white/10 pt-4">
          <legend className="font-mono text-[11px] uppercase tracking-[0.2em] text-text-faint">
            Pickup location
          </legend>
          <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-3">
            {pickupLocations.map((location) => (
              <label
                key={location}
                className={`clip-shard-tight cursor-pointer border-2 px-3 py-2 text-center font-mono text-xs transition-colors focus-within:outline focus-within:outline-[3px] focus-within:outline-gold ${
                  pickupLocation === location
                    ? "border-gold bg-gold text-void"
                    : "border-white/10 text-text-faint hover:border-brand hover:text-text"
                }`}
              >
                <input
                  type="radio"
                  name="pickupLocation"
                  value={location}
                  checked={pickupLocation === location}
                  onChange={() => setPickupLocation(location)}
                  className="sr-only"
                />
                {location}
              </label>
            ))}
          </div>
        </fieldset>
      )}

      <p className="mt-4 font-mono text-[11px] uppercase tracking-[0.2em] text-text-faint">
        {fulfillment === "delivery" ? "Delivery details coming soon" : "Choose your pickup window"}
      </p>

      {groups.length === 0 ? (
        <div className="mt-3 border-2 border-warning/60 bg-surface-2 p-4">
          <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-gold">
            Select your extraction date and time
          </p>
          <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
              {upcomingDates.map((date) => (
              <button
                key={date.key}
                type="button"
                onClick={() => setSelectedDate(date.key)}
                  aria-pressed={selectedDate === date.key}
                  className={`border-2 px-3 py-2 text-left font-mono text-xs transition-colors ${
                    selectedDate === date.key
                      ? "border-gold bg-gold text-void"
                      : "border-white/10 text-text-faint hover:border-brand hover:text-text"
                  }`}
              >
                {date.label}
              </button>
            ))}
          </div>
          <div className="mt-4">
            <span className="font-mono text-[11px] uppercase tracking-[0.2em] text-text-faint">Time chart</span>
            <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4" role="list" aria-label="Pickup times">
              {["7:50 AM", "10:50 AM", "11:20 AM", "2:30 PM"].map((time) => (
                <button
                  key={time}
                  type="button"
                  onClick={() => setSelectedManualTime(time)}
                  aria-pressed={selectedManualTime === time}
                  className={`border px-3 py-2 text-center font-mono text-xs transition-colors ${
                    selectedManualTime === time
                      ? "border-gold bg-gold text-void"
                      : "border-white/10 text-text-faint hover:border-brand hover:text-text"
                  }`}
                >
                  {time}
                </button>
              ))}
            </div>
          </div>
          <p className="mt-4 text-sm text-text-dim">
            Choose a date and time above. Pickup windows become selectable here as soon as the service schedule is published.
          </p>
        </div>
      ) : (
        <div className="mt-3 flex flex-col gap-4">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {groups.map((group) => (
              <button
                key={group.dateKey}
                type="button"
                onClick={() => setSelectedDate(group.dateKey)}
                className={`border-2 px-3 py-2 text-left font-mono text-xs transition-colors ${
                  effectiveSelectedDate === group.dateKey
                    ? "border-gold bg-gold text-void"
                    : "border-white/10 text-text-faint hover:border-brand hover:text-text"
                }`}
              >
                {group.heading}
              </button>
            ))}
          </div>

          <div role="radiogroup" className="flex flex-wrap gap-2">
            {visibleSlots.map((s) => {
              const selected = value === s.id;
              return (
                <label
                  key={s.id}
                  className={`clip-shard-tight cursor-pointer border-2 px-4 py-2 font-mono text-[13px] transition-colors focus-within:outline focus-within:outline-[3px] focus-within:outline-gold ${
                    s.full
                      ? "cursor-not-allowed border-white/10 text-text-faint opacity-50"
                      : selected
                        ? "border-gold bg-gold text-void"
                        : "border-brand text-text hover:bg-brand/15"
                  }`}
                >
                  <input
                    type="radio"
                    name="slot"
                    value={s.id}
                    className="sr-only"
                    checked={selected}
                    disabled={s.full}
                    onChange={() => onChange(s.id)}
                  />
                  {formatSlotTime(s.startTime)} · {s.label}
                  {s.full ? " — Full" : s.remaining <= 5 ? ` — ${s.remaining} left` : ""}
                </label>
              );
            })}
          </div>
        </div>
      )}
    </fieldset>
  );
}
