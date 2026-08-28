"use client";

import type { ServiceId, ServiceSeries } from "@/lib/types";

/**
 * "그 외 API" 는 서비스가 아니라 **목록 화면**이라 ServiceId 가 아니다.
 * 탭 값은 서비스 id 이거나 이 문자열이다.
 */
export const VENDORS_TAB = "vendors" as const;
export type TabValue = ServiceId | typeof VENDORS_TAB;

type Props = {
  services: ServiceSeries[];
  value: TabValue;
  onChange: (next: TabValue) => void;
  /** 그 외 API 탭에 띄울 개수. 0 이면 탭 자체를 안 그린다. */
  vendorCount?: number;
};

export default function ServiceTabs({ services, value, onChange, vendorCount = 0 }: Props) {
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

      {vendorCount > 0 && (
        <button
          role="tab"
          type="button"
          aria-selected={value === VENDORS_TAB}
          onClick={() => onChange(VENDORS_TAB)}
          className="cursor-pointer rounded-md px-4 py-1.5 text-sm font-medium transition-colors"
          style={{
            background: value === VENDORS_TAB ? "var(--text-primary)" : "transparent",
            color: value === VENDORS_TAB ? "var(--surface-1)" : "var(--text-secondary)",
          }}
        >
          그 외 API
          <em
            className="ml-1.5 text-xs not-italic"
            style={{ opacity: 0.7 }}
          >
            {vendorCount}
          </em>
        </button>
      )}
    </div>
  );
}
