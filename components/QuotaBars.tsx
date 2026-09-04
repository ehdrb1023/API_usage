/**
 * 구독 사용량 한도 — **"이번 주 얼마나 썼고 언제 막히나".**
 *
 * ── 이게 종량제 지표와 다른 점 ─────────────────────────────────────────────
 * 대시보드 본문의 숫자는 **종량제 API 사용분**이다. Claude Code 를 구독(Max·Pro)으로
 * 쓰면 그쪽 장부에는 한 줄도 안 올라간다 — 정액제라 토큰당 과금을 하지 않으니
 * 기록할 이유가 없다. 실측으로 하루를 비교하면 Admin API $2.46 / 구독 사용분
 * 320M 토큰으로 두 자릿수 배가 갈렸다.
 *
 * 그래서 "얼마 남았나" 는 여기서만 답할 수 있다. Claude Code 의 `/usage` 가 주는
 * **계정 단위 공식 퍼센트**이고, 실제로 막히는 기준도 이 값이다
 * (출처·한계는 `lib/quota.ts` 주석).
 *
 * ── 왜 토큰 개수가 아니라 퍼센트인가 ───────────────────────────────────────
 * 응답의 `limit_dollars`·`used_dollars` 가 전부 null 로 온다. 정액제라 상한을
 * 공개하지 않는 구조다. 그리고 한도 자체가 고정도 아니다 — 프로모션으로
 * "이번 주 한도 50% 상향" 같은 게 붙는다. 토큰으로 환산해 두면 그때 틀린 숫자가
 * 된다. **퍼센트가 벤더가 주는 그대로이고 흔들리지 않는 유일한 값이다.**
 *
 * 서버 컴포넌트다. 상태가 없고 받은 데이터를 그대로 그린다.
 */

import UsageBar from "@/components/UsageBar";
import type { QuotaSnapshot } from "@/lib/live-types";

type Props = {
  quota: QuotaSnapshot;
  /**
   * 이 값이 어느 계정 것인지. 자격증명이 있는 기기의 계정이라 대시보드가 보는
   * Admin 키와 **다를 수 있다** — 안 적으면 남의 계정 한도를 자기 것으로 읽는다.
   */
  accountHint?: string;
};

/** 2026-09-04T09:30:00Z → 9/4 (금) 18:30. 리셋 시각은 한국시간으로 읽어야 쓸모 있다. */
function formatReset(iso: string | null): string | null {
  const ms = Date.parse(iso ?? "");
  if (!Number.isFinite(ms)) return null;

  // KST 는 UTC+9 고정이라 오프셋만 더하면 된다 (`lib/kst.ts` 와 같은 전제).
  const kst = new Date(ms + 9 * 60 * 60 * 1000);
  const w = ["일", "월", "화", "수", "목", "금", "토"][kst.getUTCDay()];
  const hh = String(kst.getUTCHours()).padStart(2, "0");
  const mm = String(kst.getUTCMinutes()).padStart(2, "0");
  return `${kst.getUTCMonth() + 1}/${kst.getUTCDate()} (${w}) ${hh}:${mm} 재설정`;
}

export default function QuotaBars({ quota, accountHint }: Props) {
  // 조회 실패 — 사유를 그대로 보여 준다. 대개 "토큰 만료" 라 사람이 조치할 수 있다.
  if (quota.error || quota.windows.length === 0) {
    return (
      <div className="card p-4">
        <p className="text-xs font-medium" style={{ color: "var(--text-secondary)" }}>
          구독 사용량 한도
        </p>
        <p className="mt-1.5 text-sm" style={{ color: "var(--text-muted)" }}>
          {quota.error ?? "한도 항목이 비어 있습니다"}
        </p>
      </div>
    );
  }

  return (
    <div className="card p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-xs font-medium" style={{ color: "var(--text-secondary)" }}>
          구독 사용량 한도
          {accountHint && (
            <span className="ml-2 font-normal" style={{ color: "var(--text-muted)" }}>
              {accountHint}
            </span>
          )}
        </p>
        <p className="text-xs" style={{ color: "var(--text-muted)" }}>
          {/**
           * 이 한 줄이 "넘기면 돈이 더 나가나 / 막히나" 를 가른다.
           * 둘은 대응이 완전히 다르므로 반드시 띄운다.
           */}
          {quota.extraUsageEnabled ? "초과 시 추가 과금" : "초과 시 사용 중단"}
        </p>
      </div>

      <div className="mt-3 space-y-4">
        {quota.windows.map((w) => (
          <UsageBar
            key={w.key}
            usedPercent={w.usedPercent}
            label={w.label}
            detail={formatReset(w.resetsAt) ?? "재설정 시각 미제공"}
          />
        ))}
      </div>

      <p className="mt-3 text-xs leading-relaxed" style={{ color: "var(--text-muted)" }}>
        정액제라 벤더가 상한을 공개하지 않습니다. 토큰 개수 대신 퍼센트로 옵니다 —
        한도 자체도 프로모션으로 바뀌므로 토큰으로 환산해 두면 그때 틀립니다.
      </p>
    </div>
  );
}
