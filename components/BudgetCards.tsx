import type { BudgetCard, BudgetUnit } from "@/lib/budget";
import type { KeyLevel } from "@/lib/key-levels";

/**
 * 서비스별 예산·잔액 카드. 기존 사용량 대시보드 위에 얹는 요약 줄이다.
 * 한 카드에 (a) 오늘·이번 달 사용액 (b) 남은 예산/잔액 (c) 소비율 (d) 러너웨이.
 * 자동·수기 구분은 뱃지로 명확히 한다.
 */

function money(v: number, unit: BudgetUnit): string {
  if (unit === "KRW") return `${Math.round(v).toLocaleString("ko-KR")}원`;
  return `$${v.toFixed(2)}`;
}

const LEVEL_COLOR: Record<KeyLevel, string> = {
  0: "var(--status-good)",
  1: "var(--series-4)",
  2: "var(--series-4)",
  3: "var(--status-critical)",
};

const LEVEL_TEXT: Record<KeyLevel, string> = {
  0: "정상",
  1: "알림",
  2: "주의",
  3: "위험",
};

function Badge({ children, color }: { children: React.ReactNode; color?: string }) {
  return (
    <span
      className="rounded px-1.5 py-0.5 text-[10px] font-medium"
      style={{
        border: "1px solid var(--border)",
        color: color ?? "var(--text-muted)",
      }}
    >
      {children}
    </span>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-xs" style={{ color: "var(--text-muted)" }}>
        {label}
      </span>
      <span className="text-sm font-medium tabular-nums" style={{ color: "var(--text-primary)" }}>
        {value}
      </span>
    </div>
  );
}

function CardView({ card }: { card: BudgetCard }) {
  const dash = "—";
  const pct = card.budgetPct != null ? `${Math.round(card.budgetPct * 100)}%` : dash;
  const pctColor =
    card.budgetPct == null
      ? "var(--text-primary)"
      : card.budgetPct >= 0.8
        ? "var(--status-critical)"
        : "var(--text-primary)";

  return (
    <div className="card flex flex-col gap-2.5 p-4">
      <div className="flex flex-wrap items-center justify-between gap-1.5">
        <p className="text-sm font-semibold">{card.label}</p>
        <div className="flex items-center gap-1.5">
          {card.mode === "manual" ? (
            <Badge>수기{card.manualAt ? ` (갱신 ${card.manualAt})` : ""}</Badge>
          ) : (
            <Badge>자동</Badge>
          )}
          {!card.unconfigured && (
            <Badge color={LEVEL_COLOR[card.level]}>{LEVEL_TEXT[card.level]}</Badge>
          )}
        </div>
      </div>

      {card.unconfigured ? (
        <p className="text-xs" style={{ color: "var(--text-secondary)" }}>
          미설정 — {card.unconfigured}
        </p>
      ) : (
        <div className="flex flex-col gap-1">
          <Row
            label="오늘"
            value={card.todaySpend != null ? money(card.todaySpend, card.unit) : dash}
          />
          <Row
            label="이번 달 누적"
            value={card.monthSpend != null ? money(card.monthSpend, card.unit) : dash}
          />
          <Row
            label={card.unit === "KRW" ? "잔액" : "남은 예산/잔액"}
            value={card.remaining != null ? money(card.remaining, card.unit) : dash}
          />
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-xs" style={{ color: "var(--text-muted)" }}>
              소비율
            </span>
            <span className="text-sm font-medium tabular-nums" style={{ color: pctColor }}>
              {pct}
            </span>
          </div>
          <Row
            label="러너웨이"
            value={card.runwayDays != null ? `${card.runwayDays}일 뒤 바닥` : dash}
          />
        </div>
      )}

      {card.note && (
        <p className="text-[11px] leading-snug" style={{ color: "var(--text-muted)" }}>
          {card.note}
        </p>
      )}
    </div>
  );
}

export default function BudgetCards({ cards }: { cards: BudgetCard[] }) {
  if (!cards.length) return null;
  return (
    <section className="mb-6">
      <div className="mb-2 flex items-baseline justify-between">
        <h2 className="text-sm font-semibold" style={{ color: "var(--text-secondary)" }}>
          예산·잔액
        </h2>
        <p className="text-[11px]" style={{ color: "var(--text-muted)" }}>
          소비율 80/95/100% · 러너웨이 14/7/3일에 디스코드 알림
        </p>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {cards.map((c) => (
          <CardView key={c.id} card={c} />
        ))}
      </div>
    </section>
  );
}
