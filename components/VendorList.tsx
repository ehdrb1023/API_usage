/**
 * "그 외 API" 탭 — Claude·GPT 를 뺀 나머지 벤더의 **키 목록**.
 *
 * ── 이 표가 답하려는 질문 ──────────────────────────────────────────────────
 * **"어디서 모르게 돈이 새고 있나."**
 *
 * 그래서 열이 금액이 아니라 **비용이 보이느냐** 중심이다. 지금 대부분 금액이
 * 비어 있는데 그게 요점이다 — "안 썼다" 가 아니라 **"안 보인다"** 는 뜻이고,
 * 결제 메일이 들어오는 대로 채워진다.
 *
 * ── 왜 키마다 한 줄인가 ────────────────────────────────────────────────────
 * 벤더로 묶으면 "Supabase · 유료" 한 줄로 끝나서 **키가 몇 개고 어느 게 위험한지**
 * 안 보인다. Supabase 만 해도 계정 전체 권한 PAT 이 2개다. 그래서 키를 펼치고,
 * 대신 로고를 붙여 어느 벤더 줄인지 눈으로 훑을 수 있게 했다.
 *
 * 서버 컴포넌트다. 상태가 없고 데이터를 그대로 그린다.
 */

import LOGOS from "@/config/vendor-logos.json";
import { totalSpend, type VendorSpend } from "@/lib/billing/vendor-spend";
import { toKeyRows, type Vendor } from "@/lib/vendors";

type Props = {
  vendors: Vendor[];
  /**
   * 이번 달 지출. 영수증(실제 청구액)과 수기 장부를 합친 것이다
   * (`lib/billing/vendor-spend.ts`). 없으면 표의 금액 열이 전부 "모름" 이 된다.
   */
  spend?: VendorSpend;
};

const EMPTY_SPEND: VendorSpend = {
  month: "",
  byVendorId: {},
  manualIds: [],
  overridden: [],
  unregistered: [],
};

const PAID_LABEL = { yes: "유료", no: "무료", unknown: "미확인" } as const;
const PAID_COLOR = {
  yes: "var(--status-critical)",
  no: "var(--text-muted)",
  unknown: "var(--status-warning)",
} as const;

const logoOf = (id: string): string | undefined => (LOGOS as Record<string, string>)[id];

export default function VendorList({ vendors, spend = EMPTY_SPEND }: Props) {
  const spendByVendor = spend.byVendorId;
  const manual = new Set(spend.manualIds);
  const others = vendors.filter((v) => v.tier !== "primary");
  if (others.length === 0) return null;

  // 유료 → 미확인 → 무료. **돈 나갈 수 있는 것부터.**
  const order = { yes: 0, unknown: 1, no: 2 } as const;
  const sorted = [...others].sort(
    (a, b) => order[a.paid] - order[b.paid] || a.label.localeCompare(b.label, "ko"),
  );
  const rows = toKeyRows(sorted);

  const leaky = sorted.filter((v) => v.paid !== "no" && !(v.id in spendByVendor));
  const leakyKeys = rows.filter(
    (r) => r.vendor.paid !== "no" && !(r.vendor.id in spendByVendor),
  ).length;

  return (
    <section>
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 className="text-sm font-semibold">
          그 외 API — 벤더 {sorted.length}종 · 키 {rows.length}개
        </h2>
        <p className="text-xs" style={{ color: "var(--text-muted)" }}>
          키가 하나뿐이거나 벤더가 키별 사용량을 주지 않아 쪼갤 게 없는 것들
        </p>
      </div>

      {leaky.length > 0 && (
        <p
          role="note"
          className="mb-4 rounded-lg border px-3.5 py-2.5 text-xs"
          style={{
            borderColor: "var(--status-warning)",
            background: "color-mix(in srgb, var(--status-warning) 8%, transparent)",
            color: "var(--text-secondary)",
          }}
        >
          <strong style={{ color: "var(--text-primary)" }}>
            {leaky.length}종 · 키 {leakyKeys}개
          </strong>
          는 돈이 나갈 수 있는데 <strong>아직 금액이 안 잡힙니다.</strong> 결제 메일이
          들어오면 채워집니다 — 비어 있다는 건 &ldquo;안 썼다&rdquo;가 아니라{" "}
          <strong>&ldquo;안 보인다&rdquo;</strong>는 뜻입니다.
        </p>
      )}

      <div className="card overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr style={{ color: "var(--text-secondary)" }}>
              <th className="px-3.5 py-2.5 text-left font-medium">벤더</th>
              <th className="px-3.5 py-2.5 text-left font-medium">키</th>
              <th className="px-3.5 py-2.5 text-left font-medium">과금</th>
              <th className="px-3.5 py-2.5 text-right font-medium">이번 달</th>
              <th className="px-3.5 py-2.5 text-left font-medium">비고</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ vendor: v, key }, i) => {
              const amount = spendByVendor[v.id];
              // 같은 벤더가 이어지면 벤더 칸을 비워 눈이 덜 어지럽다.
              const firstOfVendor = i === 0 || rows[i - 1].vendor.id !== v.id;
              const logo = logoOf(v.id);

              return (
                <tr
                  key={`${v.id}:${key || i}`}
                  style={{
                    borderTop: firstOfVendor ? "1px solid var(--border)" : "none",
                  }}
                >
                  <td className="px-3.5 py-2 whitespace-nowrap">
                    {firstOfVendor && (
                      <span className="flex items-center gap-2">
                        {logo ? (
                          // 16px 정적 파비콘이라 next/image 의 최적화 파이프라인이 얻는 게
                          // 없다. .ico 는 next/image 가 지원하지도 않는다.
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={logo}
                            alt=""
                            width={16}
                            height={16}
                            className="shrink-0 rounded-sm"
                            style={{ objectFit: "contain" }}
                          />
                        ) : (
                          // 로고를 못 받은 벤더는 이니셜로 떨어진다. 자리를 비우면 줄이 밀린다.
                          <span
                            aria-hidden="true"
                            className="flex size-4 shrink-0 items-center justify-center rounded-sm text-[9px] font-semibold"
                            style={{ background: "var(--surface-2)", color: "var(--text-muted)" }}
                          >
                            {v.label.slice(0, 1)}
                          </span>
                        )}
                        <span className="font-medium">{v.label}</span>
                        {v.tier === "candidate" && (
                          <em
                            className="text-xs not-italic"
                            style={{ color: "var(--status-warning)" }}
                            title="키가 여럿일 수 있어 독립 탭으로 올릴지 검토 중"
                          >
                            검토중
                          </em>
                        )}
                      </span>
                    )}
                  </td>

                  <td
                    className="px-3.5 py-2 font-mono text-xs"
                    style={{ color: "var(--text-secondary)" }}
                  >
                    {key || "—"}
                  </td>

                  <td className="px-3.5 py-2 text-xs" style={{ color: PAID_COLOR[v.paid] }}>
                    {firstOfVendor ? PAID_LABEL[v.paid] : ""}
                  </td>

                  <td className="px-3.5 py-2 text-right tabular-nums">
                    {!firstOfVendor ? null : amount !== undefined ? (
                      <span
                        title={
                          manual.has(v.id)
                            ? "config/vendor-costs.json 에 손으로 적은 값입니다"
                            : "결제 메일에서 파싱된 실제 청구액입니다"
                        }
                      >
                        ${amount.toFixed(2)}
                        {manual.has(v.id) && (
                          // 실제 청구액과 사람이 적은 값을 눈으로 구분할 수 있어야 한다.
                          <em
                            className="ml-1 text-[10px] not-italic"
                            style={{ color: "var(--text-muted)" }}
                          >
                            수기
                          </em>
                        )}
                      </span>
                    ) : v.paid === "no" ? (
                      <span style={{ color: "var(--text-muted)" }}>—</span>
                    ) : (
                      // ⚠️ 0 이라고 쓰면 안 된다. 모르는 것과 안 쓴 것은 다르다.
                      <span
                        style={{ color: "var(--status-warning)" }}
                        title="영수증이 아직 수집되지 않았습니다"
                      >
                        ?
                      </span>
                    )}
                  </td>

                  <td className="px-3.5 py-2 text-xs" style={{ color: "var(--text-muted)" }}>
                    {firstOfVendor ? (v.note ?? "") : ""}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {(Object.keys(spendByVendor).length > 0 || spend.unregistered.length > 0) && (
        <p className="mt-2 flex flex-wrap items-baseline justify-between gap-x-4 text-sm">
          <span style={{ color: "var(--text-secondary)" }}>
            이번 달 합계{spend.month && ` (${spend.month})`}
          </span>
          <strong className="tabular-nums">${totalSpend(spend).toFixed(2)}</strong>
        </p>
      )}

      {spend.unregistered.length > 0 && (
        /*
          영수증에는 있는데 목록에 없는 벤더. **이 표가 찾으려던 게 정확히 이것이다** —
          아무도 등록하지 않은 채 돈만 나가고 있는 곳이라, 눈에 띄게 띄운다.
        */
        <p
          role="note"
          className="mt-2 rounded-lg border px-3.5 py-2.5 text-xs"
          style={{
            borderColor: "var(--status-critical)",
            background: "color-mix(in srgb, var(--status-critical) 8%, transparent)",
            color: "var(--text-secondary)",
          }}
        >
          <strong style={{ color: "var(--text-primary)" }}>목록에 없는 벤더</strong>
          에서 결제가 나갔습니다 —{" "}
          {spend.unregistered.map((u) => `${u.name} $${u.amount.toFixed(2)}`).join(", ")}.{" "}
          <code>config/vendors.json</code> 에 추가하세요.
        </p>
      )}

      {spend.overridden.length > 0 && (
        <p className="mt-2 text-xs" style={{ color: "var(--text-muted)" }}>
          {spend.overridden.join(", ")} 는 영수증이 들어와 수기 값을 쓰지 않았습니다.
          <code>config/vendor-costs.json</code> 에서 지워도 됩니다.
        </p>
      )}

      <p className="mt-2 text-xs" style={{ color: "var(--text-muted)" }}>
        목록은 <code>config/vendors.json</code> 에서 옵니다. 새 API 를 쓰기 시작하면 거기
        한 줄을 추가하고 <code>node scripts/fetch_vendor_logos.mjs</code> 로 로고를 받으세요.{" "}
        <strong>&ldquo;미확인&rdquo;은 무료라는 뜻이 아닙니다</strong> — 유료인지 확인을 안 한 것입니다.
        사용량 API 도 결제 메일도 없는 벤더는 <code>config/vendor-costs.json</code> 에
        월 금액을 직접 적으면 이 표에 잡힙니다.
      </p>
    </section>
  );
}
