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
  const groups = useMemo(() => groupSlotsByDate(slots), [slots]);
  const [selectedDate, setSelectedDate] = useState<string | null>(groups[0]?.dateKey ?? null);

  const effectiveSelectedDate =
    selectedDate && groups.some((group) => group.dateKey === selectedDate)
      ? selectedDate
      : groups[0]?.dateKey ?? null;

  const visibleSlots = effectiveSelectedDate
    ? groups.find((group) => group.dateKey === effectiveSelectedDate)?.slots ?? []
    : [];

  return (
    <fieldset>
      <legend className="font-display text-headline-md uppercase text-text">
        Pickup window
      </legend>

      {groups.length === 0 ? (
        <p className="mt-3 border-2 border-warning/60 bg-surface-2 p-3 text-sm text-text-dim">
          No pickup windows are available yet. Choose a future service date when the next slot opens.
        </p>
      ) : (
        <div className="mt-3 flex flex-col gap-4">
          <label className="flex flex-col gap-2">
            <span className="font-mono text-[11px] uppercase tracking-[0.2em] text-text-faint">
              Pickup date
            </span>
            <select
              value={effectiveSelectedDate ?? ""}
              onChange={(e) => setSelectedDate(e.target.value || null)}
              className="border-2 border-white/10 bg-surface-2 px-3 py-2 font-mono text-sm text-text focus:border-brand"
            >
              {groups.map((group) => (
                <option key={group.dateKey} value={group.dateKey}>
                  {group.heading}
                </option>
              ))}
            </select>
          </label>

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
