/**
 * 사용량 막대 — **"얼마나 찼나"** 한 줄.
 *
 * ── 막대에는 분모가 반드시 있어야 한다 ─────────────────────────────────────
 * 퍼센트는 분자만으로 못 만든다. 이 프로젝트에서 쓰는 분모는 둘뿐이다.
 *
 *   선불  넣은 돈 (`data/billing/receipts.json` 의 충전 합계) — 벤더가 준 사실
 *   후불  월 예산 (`config/budgets.json`)                    — 사람이 정한 값
 *
 * 분모가 없으면 **막대를 그리지 않는다.** 0 을 분모로 넣거나 임의의 상한을
 * 지어내면 "여유 있다" 로 읽히는데, 그게 이 화면에서 제일 위험한 오작동이다.
 * 대신 `emptyHint` 로 어디를 고치면 되는지 적는다.
 *
 * 색은 남은 양이 아니라 **찬 정도**로 정한다 — 80% 를 넘기면 눈에 걸려야 한다.
 * 색만으로 알리지 않으려고 퍼센트 숫자를 항상 같이 쓴다 (`~/.claude/rules/design.md`).
 */

type Props = {
  /** 0~100. 100 을 넘겨도 막대는 100 에서 멈추고 숫자는 실제 값을 쓴다. */
  usedPercent: number | null;
  /** 막대 왼쪽 이름. 예: "이번 달 예산" */
  label: string;
  /** 오른쪽에 붙일 실제 금액 등. 예: "$29.57 / $100.00" */
  detail?: string;
  /** `usedPercent` 가 null 일 때 대신 띄울 안내. 분모가 없다는 뜻이다. */
  emptyHint?: string;
};

/** 찬 정도에 따른 색. 100 을 넘으면 초과다. */
function toneOf(pct: number): string {
  if (pct >= 100) return "var(--status-critical)";
  if (pct >= 80) return "var(--series-4)";
  return "var(--series-1)";
}

export default function UsageBar({ usedPercent, label, detail, emptyHint }: Props) {
  // 분모가 없다 — 막대를 지어내지 않고 고칠 곳을 적는다.
  if (usedPercent === null) {
    return (
      <div>
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-xs font-medium" style={{ color: "var(--text-secondary)" }}>
            {label}
          </span>
          <span className="text-xs" style={{ color: "var(--text-muted)" }}>
            기준 없음
          </span>
        </div>
        {emptyHint && (
          <p className="mt-1 text-xs leading-relaxed" style={{ color: "var(--text-muted)" }}>
            {emptyHint}
          </p>
        )}
      </div>
    );
  }

  const shown = Math.max(0, Math.round(usedPercent));
  // 막대는 100 에서 멈춘다. 넘친 만큼 막대가 컨테이너를 뚫고 나가면 레이아웃이 깨진다.
  const filled = Math.min(100, shown);
  const tone = toneOf(shown);

  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-xs font-medium" style={{ color: "var(--text-secondary)" }}>
          {label}
        </span>
        <span className="text-xs tabular-nums" style={{ color: "var(--text-muted)" }}>
          {detail}
        </span>
      </div>

      <div
        className="mt-1.5 flex items-center gap-2"
        role="meter"
        aria-valuenow={shown}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`${label} ${shown}% 사용`}
      >
        <div
          className="h-2 flex-1 overflow-hidden rounded-full"
          style={{ background: "var(--hover)" }}
        >
          <div
            className="h-full rounded-full"
            style={{ width: `${filled}%`, background: tone }}
          />
        </div>
        {/* 색만으로 알리지 않는다 — 숫자를 항상 같이 쓴다. */}
        <span
          className="w-20 shrink-0 text-right text-xs tabular-nums"
          style={{ color: tone }}
        >
          {shown}% 사용
        </span>
      </div>

      <p className="mt-1 text-xs tabular-nums" style={{ color: "var(--text-muted)" }}>
        {shown >= 100 ? `${shown - 100}% 초과` : `${100 - shown}% 남음`}
      </p>
    </div>
  );
}
