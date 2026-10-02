"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { href: "/", label: "API 사용량" },
  { href: "/receipts", label: "결제 내역" },
] as const;

/** 화면 맨 위 탭. 사용량(벤더 Admin API)과 결제 내역(결제 메일)은 출처가 달라 페이지를 나눴다. */
export default function TopNav() {
  const pathname = usePathname();
  return (
    <nav aria-label="화면" className="mx-auto max-w-6xl px-4 pt-6 sm:px-6 lg:px-8">
      <div
        className="inline-flex rounded-lg p-1"
        style={{ background: "var(--surface-1)", border: "1px solid var(--border)" }}
      >
        {TABS.map((t) => {
          const selected = t.href === "/" ? pathname === "/" : pathname.startsWith(t.href);
          return (
            <Link
              key={t.href}
              href={t.href}
              aria-current={selected ? "page" : undefined}
              className="rounded-md px-4 py-1.5 text-sm font-medium transition-colors"
              style={{
                background: selected ? "var(--text-primary)" : "transparent",
                color: selected ? "var(--surface-1)" : "var(--text-secondary)",
              }}
            >
              {t.label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
