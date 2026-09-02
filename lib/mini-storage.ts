/**
 * 미니 창에 띄울 줄 목록의 저장소.
 *
 * **브라우저 localStorage 가 원본이다.** React state 로 들고 있지 않는 이유는
 * 읽는 곳이 둘이기 때문이다 — 미니 창(/mini)과 대시보드의 선택창. 둘은 서로 다른
 * 탭·창에서 열리므로 state 로는 동기화가 안 된다. `storage` 이벤트를 타면 대시보드에서
 * 체크하는 순간 미니 창이 바뀐다.
 *
 * 서버에는 저장하지 않는다. 이건 "이 컴퓨터의 이 창" 설정이라, 노트북과 데스크톱에서
 * 다른 걸 띄우고 싶은 게 정상이다.
 *
 * ⚠️ 클라이언트 전용. 서버 컴포넌트에서 부르면 localStorage 가 없어서 터진다 —
 *    `subscribe`/`read` 는 `useSyncExternalStore` 를 통해서만 부를 것.
 */

import { isLiveRange, type LiveRange } from "@/lib/live-range";
import { DEFAULT_LINES, type LiveLine } from "@/lib/live-types";

const STORAGE_KEY = "api-usage-mini-lines-v1";
/** 같은 탭 안에서의 변경 알림. `storage` 이벤트는 **다른** 탭에만 간다. */
const CHANGE_EVENT = "api-usage-mini-lines-changed";

/** 시크릿 모드처럼 localStorage 가 막힌 환경용 거울. 이번 세션에서만 유지된다. */
let memory: string | null = null;

export function subscribeLines(onChange: () => void): () => void {
  window.addEventListener(CHANGE_EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(CHANGE_EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}

/** `useSyncExternalStore` 의 getSnapshot. 문자열이라 값 비교가 그대로 먹는다. */
export function readLines(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY) ?? memory;
  } catch {
    return memory;
  }
}

/** 서버에는 저장값이 없다 → 기본값으로 그려야 hydration 이 어긋나지 않는다. */
export function readLinesOnServer(): string | null {
  return null;
}

export function writeLines(lines: LiveLine[]): void {
  const json = JSON.stringify(lines);
  memory = json;
  try {
    localStorage.setItem(STORAGE_KEY, json);
  } catch {
    /* 저장은 못 해도 이번 세션은 memory 로 굴러간다. */
  }
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

export function parseLines(raw: string | null): LiveLine[] {
  if (!raw) return DEFAULT_LINES;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as LiveLine[]) : DEFAULT_LINES;
  } catch {
    return DEFAULT_LINES; // 저장값이 깨졌으면 조용히 기본값으로 간다.
  }
}

// ---------------------------------------------------------------- 조회 구간

/**
 * 고른 구간(오늘·7일·이번 달)도 같은 방식으로 둔다.
 *
 * 줄 목록과 **같은 저장소를 쓰되 키는 따로다.** 구간은 창마다 다른 게 자연스럽지만
 * (미니 창은 오늘, 대시보드는 이번 달) 창을 닫았다 열면 남아 있어야 한다 —
 * 미니 창은 띄워 두고 쓰는 물건이라 매번 다시 고르게 하면 성가시다.
 */
const RANGE_KEY = "api-usage-mini-range-v1";
const RANGE_EVENT = "api-usage-mini-range-changed";

let rangeMemory: LiveRange | null = null;

export function subscribeRange(onChange: () => void): () => void {
  window.addEventListener(RANGE_EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(RANGE_EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}

/** getSnapshot. 유니온 문자열이라 값 비교가 그대로 먹는다. */
export function readRange(): LiveRange {
  try {
    const raw = localStorage.getItem(RANGE_KEY);
    if (isLiveRange(raw)) return raw;
  } catch {
    /* 막힌 환경 — 아래 거울로 떨어진다. */
  }
  return rangeMemory ?? "today";
}

/** 서버에는 저장값이 없다 → 기본 구간으로 그려야 hydration 이 어긋나지 않는다. */
export function readRangeOnServer(): LiveRange {
  return "today";
}

export function writeRange(range: LiveRange): void {
  rangeMemory = range;
  try {
    localStorage.setItem(RANGE_KEY, range);
  } catch {
    /* 저장은 못 해도 이번 세션은 rangeMemory 로 굴러간다. */
  }
  window.dispatchEvent(new Event(RANGE_EVENT));
}
