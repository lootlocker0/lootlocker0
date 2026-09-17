import { formatSlotTime } from "@/lib/timezone";

/**
 * Radio-group semantics so keyboard arrows move between slots. Full slots
 * render disabled with a reason, never hidden - a disappearing option reads
 * as a bug, not as "sold out". Matches the time-chip row on the
 * extraction_point (checkout) screen export, restyled as a real fieldset.
 */
export function SlotPicker({
  slots, value, onChange,
}: {
  slots: {
    id: string;
    label: string;
    startTime: string;
    remaining: number;
    full: boolean;
  }[];
  value: string | null;
  onChange: (id: string) => void;
}) {
  return (
    <fieldset>
      <legend className="font-display text-headline-md uppercase text-text">
        Pickup window
      </legend>
      <div role="radiogroup" className="mt-3 flex flex-wrap gap-2">
        {slots.map((s) => {
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
    </fieldset>
  );
}
