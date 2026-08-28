/**
 * "그 외 API" — Claude·GPT 를 뺀 나머지 벤더 목록.
 *
 * ── 이 표가 답하려는 질문 ──────────────────────────────────────────────────
 * **"어디서 모르게 돈이 새고 있나."**
 *
 * 그래서 열은 금액이 아니라 **비용이 보이느냐**가 중심이다. 지금 대부분은 금액이
 * 비어 있는데, 그게 이 표의 요점이다 — "안 쓴다" 가 아니라 **"안 보인다"** 는 뜻이고,
 * 결제 메일이 들어오는 대로 채워진다.
 *
 * 서버 컴포넌트다. 상태가 없고 데이터를 그대로 그린다.
 */

import type { Vendor } from "@/lib/vendors";

type Props = {
  vendors: Vendor[];
  /** 벤더별 이번 달 실제 지출(USD). 영수증에서 온다. 없으면 "미확인". */
  spendByVendor?: Record<string, number>;
};

const PAID_LABEL: Record<Vendor["paid"], string> = {
  yes: "유료",
  no: "무료",
  unknown: "미확인",
};

const PAID_COLOR: Record<Vendor["paid"], string> = {
  yes: "var(--status-critical)",
  no: "var(--text-secondary)",
  unknown: "var(--status-warning)",
};

export default function VendorList({ vendors, spendByVendor = {} }: Props) {
  const grouped = vendors.filter((v) => v.tier !== "primary");
  if (grouped.length === 0) return null;

  // 유료 → 미확인 → 무료 순. **돈이 나갈 수 있는 것부터 보여준다.**
  const order: Record<Vendor["paid"], number> = { yes: 0, unknown: 1, no: 2 };
  const rows = [...grouped].sort(
    (a, b) => order[a.paid] - order[b.paid] || a.label.localeCompare(b.label, "ko"),
  );

  const leaky = rows.filter((v) => v.paid !== "no" && !(v.id in spendByVendor));

  return (
    <section className="mt-10">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 className="text-base font-semibold">그 외 API</h2>
        <p className="text-xs" style={{ color: "var(--text-secondary)" }}>
          키가 하나뿐이거나 벤더가 키별 사용량을 주지 않아 쪼갤 게 없는 것들입니다.
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
          <strong style={{ color: "var(--text-primary)" }}>{leaky.length}종</strong>은 돈이
          나갈 수 있는데 <strong>아직 금액이 안 잡힙니다.</strong> 결제 메일이 들어오면
          채워집니다 — 비어 있다는 건 &ldquo;안 썼다&rdquo;가 아니라{" "}
          <strong>&ldquo;안 보인다&rdquo;</strong>는 뜻입니다.
        </p>
      )}

      <div className="card overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr style={{ color: "var(--text-secondary)" }}>
              <th className="px-3.5 py-2.5 text-left font-medium">벤더</th>
              <th className="px-3.5 py-2.5 text-left font-medium">과금</th>
              <th className="px-3.5 py-2.5 text-right font-medium">이번 달</th>
              <th className="px-3.5 py-2.5 text-left font-medium">키</th>
              <th className="px-3.5 py-2.5 text-left font-medium">비고</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((v) => {
              const spend = spendByVendor[v.id];
              return (
                <tr key={v.id} style={{ borderTop: "1px solid var(--border)" }}>
                  <td className="px-3.5 py-2.5 font-medium">
                    {v.label}
                    {v.tier === "candidate" && (
                      <em
                        className="ml-1.5 text-xs not-italic"
                        style={{ color: "var(--status-warning)" }}
                        title="키가 여럿일 수 있어 독립 탭으로 올릴지 검토 중"
                      >
                        검토중
                      </em>
                    )}
                  </td>
                  <td className="px-3.5 py-2.5" style={{ color: PAID_COLOR[v.paid] }}>
                    {PAID_LABEL[v.paid]}
                  </td>
                  <td className="px-3.5 py-2.5 text-right tabular-nums">
                    {spend !== undefined ? (
                      `$${spend.toFixed(2)}`
                    ) : v.paid === "no" ? (
                      <span style={{ color: "var(--text-secondary)" }}>—</span>
                    ) : (
                      // ⚠️ 0 이라고 쓰면 안 된다. 모르는 것과 안 쓴 것은 다르다.
                      <span style={{ color: "var(--status-warning)" }} title="영수증 미수집">
                        ?
                      </span>
                    )}
                  </td>
                  <td
                    className="px-3.5 py-2.5 text-xs"
                    style={{ color: "var(--text-secondary)" }}
                  >
                    {v.keys.length > 2
                      ? `${v.keys.slice(0, 2).join(", ")} 외 ${v.keys.length - 2}`
                      : v.keys.join(", ") || "—"}
                  </td>
                  <td
                    className="px-3.5 py-2.5 text-xs"
                    style={{ color: "var(--text-secondary)" }}
                  >
                    {v.note ?? ""}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p className="mt-2 text-xs" style={{ color: "var(--text-secondary)" }}>
        목록은 <code>config/vendors.json</code> 에서 옵니다. 새 API 를 쓰기 시작하면 거기
        한 줄을 추가하세요. <strong>&ldquo;미확인&rdquo;은 무료라는 뜻이 아닙니다</strong> —
        유료인지 확인을 안 한 것입니다.
      </p>
    </section>
  );
}
