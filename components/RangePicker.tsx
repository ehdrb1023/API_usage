"use client";

import { RANGES } from "@/lib/analytics";
import type { RangeId } from "@/lib/types";

type Props = {
  value: RangeId;
  onChange: (next: RangeId) => void;
};

export default function RangePicker({ value, onChange }: Props) {
  return (
    <div
      role="group"
      aria-label="기간 선택"
      className="inline-flex overflow-hidden rounded-lg"
      style={{ background: "var(--surface-1)", border: "1px solid var(--border)" }}
    >
      {RANGES.map((r, i) => {
        const selected = r.id === value;
        return (
          <button
            key={r.id}
            type="button"
            aria-pressed={selected}
            onClick={() => onChange(r.id)}
            className="cursor-pointer px-3.5 py-1.5 text-sm transition-colors"
            style={{
              borderLeft: i > 0 ? "1px solid var(--border)" : undefined,
              background: selected ? "var(--hover)" : "transparent",
              color: selected ? "var(--text-primary)" : "var(--text-secondary)",
              fontWeight: selected ? 600 : 400,
            }}
          >
            {selected && <span aria-hidden="true">✓ </span>}
            {r.label}
          </button>
        );
      })}
    </div>
  );
}
