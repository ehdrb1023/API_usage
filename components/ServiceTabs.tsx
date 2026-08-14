"use client";

import type { ServiceId, ServiceSeries } from "@/lib/types";

type Props = {
  services: ServiceSeries[];
  value: ServiceId;
  onChange: (next: ServiceId) => void;
};

export default function ServiceTabs({ services, value, onChange }: Props) {
  return (
    <div
      role="tablist"
      aria-label="서비스"
      className="inline-flex rounded-lg p-1"
      style={{ background: "var(--surface-1)", border: "1px solid var(--border)" }}
    >
      {services.map((s) => {
        const selected = s.service === value;
        return (
          <button
            key={s.service}
            role="tab"
            type="button"
            aria-selected={selected}
            onClick={() => onChange(s.service)}
            className="cursor-pointer rounded-md px-4 py-1.5 text-sm font-medium transition-colors"
            style={{
              background: selected ? "var(--text-primary)" : "transparent",
              color: selected ? "var(--surface-1)" : "var(--text-secondary)",
            }}
          >
            {s.label}
          </button>
        );
      })}
    </div>
  );
}
