/**
 * 화면용 조립 — 창 하나를 "보여줄 수 있는 형태" 로 만든다.
 *
 * 계기판(CLI)과 웹 페이지가 **같은 규칙**을 쓰게 하려고 여기 모았다. 두 곳에서
 * 따로 계산하면 언젠가 갈리고, 갈린 걸 아무도 눈치채지 못한다.
 *
 * 순수 함수다.
 */

import { burnRate, type Burn } from "@/lib/quota-meter";
import type { Calibration } from "@/lib/quota-calibration";

export type WindowView = {
  key: string;
  label: string;
  usedPercent: number;
  remainingPercent: number;
  resetsAt: string | null;
  /** 속도. 계산 불가면 null — 0 을 채우지 않는다. */
  burn: Burn | null;
  /** 남은 양 추정(토큰). 보정이 없으면 null. 두 값의 폭이 곧 불확실성이다. */
  estimate: { withCacheRead: number; withoutCacheRead: number } | null;
};

export function windowView(
  window: { key: string; label: string; usedPercent: number; resetsAt: string | null },
  calibrations: Calibration[],
  now: Date = new Date(),
): WindowView {
  const remainingPercent = 100 - window.usedPercent;
  const c = calibrations.find((x) => x.windowKey === window.key);

  // 보정값이 둘 다 있어야 폭을 그린다. 한쪽만 있으면 폭이 아니라 점이 되고,
  // 점 하나를 보여주면 그게 확정값처럼 읽힌다.
  const estimate =
    c?.perPercentWithCacheRead != null && c.perPercentWithoutCacheRead != null
      ? {
          withCacheRead: remainingPercent * c.perPercentWithCacheRead,
          withoutCacheRead: remainingPercent * c.perPercentWithoutCacheRead,
        }
      : null;

  return {
    key: window.key,
    label: window.label,
    usedPercent: window.usedPercent,
    remainingPercent,
    resetsAt: window.resetsAt,
    burn: burnRate(window.key, window.usedPercent, window.resetsAt, now),
    estimate,
  };
}
