/**
 * "선불 잔액" 탭 — **충전한 돈이 얼마 남았고 며칠치인가.**
 *
 * ── 이 화면이 답하려는 질문 ────────────────────────────────────────────────
 * 선불은 **나간 시점과 쓰는 시점이 다르다.** 7월에 $500 을 넣고 8월에 태우면
 * 8월 지출은 $0 인데 잔액은 줄고 있다. 월 지출표만 보면 바닥나는 걸 못 보고,
 * 실제로 이 계정은 2026-07 에 결제 실패로 구독이 정지된 적이 있다.
 *
 * ── 왜 "모름" 을 크게 쓰는가 ───────────────────────────────────────────────
 * 잔액을 못 셀 이유가 넷 있다 — 구독 초과분·조회 API 없는 벤더·조회 구간 밖,
 * 그리고 **잔액이 음수로 나온 경우**(첫 충전 이전 잔액으로 쓴 것). 그때 0 이나
 * 빈칸을 보여 주면 **"여유 있다" 로 읽힌다.** 그게 이 화면에서 제일 위험한
 * 오작동이라 `balanceUnknownReason` 을 문장 그대로 띄운다.
 *
 * `≥` 기호는 장식이 아니다 — 첫 충전 이전 잔액을 볼 수 없으므로 실제 잔액은
 * 표시값 **이상**이다 (`lib/billing/balance.ts` 의 `openingUnknown`).
 *
 * 서버 컴포넌트다. 상태가 없고 받은 데이터를 그대로 그린다.
 */

/**
 * 주머니 판정은 `pocketOf` 한 곳만 쓴다 — 표에서 정규식을 다시 쓰면 카드와 표가
 * 서로 다른 주머니를 말하게 된다.
 */
import { pocketOf, type Pocket } from "@/lib/billing/balance";
import type { PrepaidView } from "@/lib/billing/prepaid";
import UsageBar from "@/components/UsageBar";
import { formatUsd } from "@/lib/format";

type Props = { view: PrepaidView };

const POCKET_LABEL: Record<Pocket, string> = {
  api: "API 크레딧",
  plan: "구독 초과분",
  unknown: "미분류",
};

/** 남은 일수 색 — 2주 미만이면 눈에 걸려야 한다. */
function daysColor(days: number | null): string {
  if (days === null) return "var(--text-muted)";
  if (days <= 7) return "var(--status-critical)";
  if (days <= 14) return "var(--series-4)";
  return "var(--text-primary)";
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-xs" style={{ color: "var(--text-muted)" }}>
        {label}
      </span>
      <span className="text-xs tabular-nums" style={{ color: "var(--text-secondary)" }}>
        {value}
      </span>
    </div>
  );
}

export default function PrepaidBalance({ view }: Props) {
  const { rows, topups, asOf } = view;

  // 빈 상태 — 충전 영수증이 아직 안 들어온 경우. 다음 행동을 적어 준다.
  if (rows.length === 0) {
    return (
      <section className="card p-6">
        <h2 className="text-sm font-semibold">선불 잔액</h2>
        <p className="mt-2 text-sm" style={{ color: "var(--text-secondary)" }}>
          충전 영수증이 없습니다.
        </p>
        <p className="mt-3 text-xs leading-relaxed" style={{ color: "var(--text-muted)" }}>
          결제 메일을 수집하면 채워집니다. 수집 절차는{" "}
          <code>docs/billing-receipts.md</code> 를 보세요. 지금 저장된 영수증은{" "}
          <code>data/billing/receipts.json</code> 에 있습니다.
        </p>
      </section>
    );
  }

  return (
    <section className="space-y-4">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold">선불 잔액</h2>
        <p className="text-xs" style={{ color: "var(--text-muted)" }}>
          {asOf} 기준 · 잔액은 표시값 이상입니다 (첫 충전 이전 잔액을 볼 수 없음)
        </p>
      </header>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {rows.map((r) => {
          // 잔액을 숫자로 내놓을 수 있는가. 음수로 나온 경우도 여기서 걸린다
          // (`openingImplied` — 첫 충전 이전 잔액으로 쓴 것이라 지금 잔액은 모른다).
          const known = r.balanceUnknownReason === null && r.balance !== null;
          const partial = !known && r.spentInCoverage !== null;

          return (
            <div key={`${r.vendor}\t${r.pocket}`} className="card p-4">
              <div className="flex items-baseline justify-between gap-2">
                <p className="text-sm font-semibold">{r.vendor}</p>
                <span
                  className="rounded px-1.5 py-0.5 text-xs"
                  style={{
                    background: "var(--hover)",
                    color: "var(--text-secondary)",
                  }}
                >
                  {POCKET_LABEL[r.pocket]}
                </span>
              </div>

              <p
                className="mt-2 text-2xl font-semibold tracking-tight tabular-nums"
                style={{ color: known ? "var(--text-primary)" : "var(--text-muted)" }}
              >
                {known ? `≥ ${formatUsd(r.balance as number)}` : "잔액 모름"}
              </p>

              {/**
               * 소진 막대. 분모는 **넣은 돈**이라 지어낸 값이 아니다.
               * 100% 를 넘으면 첫 충전 이전 잔액으로 쓴 것이다 (`openingImplied`).
               */}
              {r.spent !== null && (
                <div className="mt-3">
                  <UsageBar
                    usedPercent={(r.spent / r.toppedUp) * 100}
                    label="충전액 소진"
                    detail={`${formatUsd(r.spent)} / ${formatUsd(r.toppedUp)}`}
                  />
                </div>
              )}

              <div className="mt-3 space-y-1">
                <Row
                  label="넣은 돈"
                  value={`${formatUsd(r.toppedUp)} · ${r.count}건`}
                />
                <Row label="첫 충전" value={r.since} />
                {known && (
                  <>
                    <Row label="쓴 돈" value={formatUsd(r.spent as number)} />
                    <Row
                      label="남은 기간"
                      value={
                        <span style={{ color: daysColor(r.daysLeft) }}>
                          {r.daysLeft === null ? "모름" : `약 ${r.daysLeft}일`}
                        </span>
                      }
                    />
                  </>
                )}
                {/**
                 * 창 전체를 못 덮었어도 부분 지출은 보여 준다 — "모름" 한 마디보다
                 * "8/1부터 $12 썼고 그 앞은 모름" 이 판단에 쓸모 있다.
                 */}
                {partial && (
                  <Row
                    label={`${r.coverageFrom} 이후 쓴 돈`}
                    value={formatUsd(r.spentInCoverage as number)}
                  />
                )}
              </div>

              {r.balanceUnknownReason && (
                <p
                  className="mt-3 text-xs leading-relaxed"
                  style={{ color: "var(--text-muted)" }}
                >
                  {r.balanceUnknownReason}
                </p>
              )}
            </div>
          );
        })}
      </div>

      <div className="card overflow-x-auto">
        <table className="w-full text-sm">
          <caption className="px-4 pt-4 text-left text-sm font-semibold">
            충전 이력
            <span
              className="ml-2 text-xs font-normal"
              style={{ color: "var(--text-muted)" }}
            >
              영수증 {topups.length}건 · 실제 청구된 금액입니다
            </span>
          </caption>
          <thead>
            <tr style={{ color: "var(--text-muted)" }}>
              <th className="px-4 py-2 text-left text-xs font-medium">결제일</th>
              <th className="px-4 py-2 text-left text-xs font-medium">벤더</th>
              <th className="px-4 py-2 text-left text-xs font-medium">주머니</th>
              <th className="px-4 py-2 text-left text-xs font-medium">품목</th>
              <th className="px-4 py-2 text-right text-xs font-medium">금액</th>
              <th className="px-4 py-2 text-left text-xs font-medium">수단</th>
            </tr>
          </thead>
          <tbody>
            {topups.map((t) => (
              <tr key={t.sourceMessageId} style={{ borderTop: "1px solid var(--border)" }}>
                <td className="px-4 py-2 tabular-nums">{t.paidOn}</td>
                <td className="px-4 py-2">{t.vendor}</td>
                <td className="px-4 py-2" style={{ color: "var(--text-secondary)" }}>
                  {POCKET_LABEL[pocketOf(t.lineItem)]}
                </td>
                <td className="px-4 py-2" style={{ color: "var(--text-secondary)" }}>
                  {t.lineItem ?? "—"}
                </td>
                <td className="px-4 py-2 text-right tabular-nums">
                  {formatUsd(t.amount)}
                </td>
                <td className="px-4 py-2" style={{ color: "var(--text-secondary)" }}>
                  {t.cardLast4 ? `•••• ${t.cardLast4}` : (t.paymentMethod ?? "—")}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
