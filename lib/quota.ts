/**
 * 구독 한도 잔량 — **"앞으로 얼마나 더 쓸 수 있나".**
 *
 * ── 왜 벤더 사용량 API 로는 안 되는가 ──────────────────────────────────────
 * Admin API(`lib/services.ts`)가 보는 것은 **종량제 API 사용분**이다. Claude Code 를
 * 구독(Max)으로 쓰면 그쪽 장부에는 한 줄도 안 올라간다 — 정액제라 토큰당 과금을
 * 하지 않으니 기록할 이유가 없기 때문이다. 실측으로 오늘 하루를 비교하면
 * Admin API $2.46 / 구독 사용분 320M 토큰으로 두 자릿수 배 차이가 났다.
 *
 * 그래서 "얼마 남았나" 는 **다른 출처**가 필요하다. Claude Code 가 `/usage` 에
 * 쓰는 엔드포인트가 그것이고, 여기서 그걸 그대로 부른다.
 *
 * ── 이 값이 신뢰할 만한 이유 ───────────────────────────────────────────────
 * **계정 단위**로 집계된 Anthropic 의 공식 숫자다. 한 계정을 여럿이 나눠 쓰면
 * 남의 사용분까지 이미 합쳐져 있다 — 우리가 각 PC 의 로그를 긁어 더할 때 생기는
 * "내 PC 것만 보인다" 문제가 여기엔 없다. 실제로 막히는 기준도 이 퍼센트다.
 *
 * ── 두 가지 한계 ───────────────────────────────────────────────────────────
 * 1. **토큰 개수가 아니라 퍼센트다.** 응답의 `limit_dollars`·`used_dollars` 는
 *    전부 null 로 온다. 정액제라 상한을 공개하지 않는 구조라서, "3,200만 토큰
 *    남음" 은 만들 수 없고 "49% 남음" 이 최선이다.
 * 2. **공개 문서에 없는 내부 엔드포인트다.** Claude Code 업데이트로 응답이 바뀔
 *    수 있다. 그래서 이 모듈은 **절대 던지지 않는다** — 실패하면 `error` 를 담아
 *    돌려주고, 미니 창은 한도 줄만 빼고 나머지를 그대로 그린다.
 *
 * 토큰은 `~/.claude/.credentials.json` 에 있고 8시간쯤이면 만료된다. 파일을
 * **매번 새로 읽는** 이유가 그것이다 — 갱신은 Claude Code 가 알아서 하므로,
 * 우리가 캐시해 두면 만료된 토큰을 계속 쓰게 된다.
 *
 * 서버 전용 (fs·네트워크). 클라이언트에서 import 금지 — 타입은 lib/live-types.ts.
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { QuotaSnapshot, QuotaWindow } from "@/lib/live-types";

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const OAUTH_BETA = "oauth-2025-04-20";

/** 응답이 초 단위로 바뀌지 않는다. 미니 창이 10초마다 물어도 벤더는 이 주기로만 탄다. */
const CACHE_MS = 30_000;

export function credentialsPath(): string {
  return (
    process.env.CLAUDE_CREDENTIALS_PATH ||
    path.join(os.homedir(), ".claude", ".credentials.json")
  );
}

/**
 * 한도 조회가 가능한 환경인지. 배포본에는 자격증명 파일이 없으므로 항상 false 다
 * (`lib/live.ts` 가 이걸 보고 한도 줄 자체를 안 만든다).
 */
export async function hasQuotaSource(): Promise<boolean> {
  try {
    // 경로가 **항상 저장소 밖**(홈 디렉토리)이다. 표시를 안 붙이면 Turbopack 이
    // "어디를 읽을지 모르겠다" 며 프로젝트 전체를 배포 번들에 넣는다.
    await fs.access(/* turbopackIgnore: true */ credentialsPath());
    return true;
  } catch {
    return false;
  }
}

type Cached = { at: number; value: QuotaSnapshot };
let cache: Cached | null = null;

/** 테스트가 캐시를 넘어 다시 부를 수 있게. */
export function resetQuotaCache(): void {
  cache = null;
}

/**
 * 한도 스냅샷. **던지지 않는다** — 실패는 `error` 에 담아 돌려준다.
 *
 * 실패한 결과도 캐시한다. 토큰이 만료됐거나 엔드포인트가 바뀐 상황에서 미니 창이
 * 10초마다 재시도하면 의미 없는 호출만 쌓이기 때문이다.
 */
export async function getQuota(now: Date = new Date()): Promise<QuotaSnapshot> {
  if (cache && now.getTime() - cache.at < CACHE_MS) return cache.value;

  const value = await fetchQuota();
  cache = { at: now.getTime(), value };
  return value;
}

async function fetchQuota(): Promise<QuotaSnapshot> {
  let token: string;
  try {
    token = await readAccessToken();
  } catch (error) {
    return fail(error);
  }

  let payload: unknown;
  try {
    const res = await fetch(USAGE_URL, {
      headers: {
        authorization: `Bearer ${token}`,
        "anthropic-beta": OAUTH_BETA,
      },
      cache: "no-store",
    });
    if (!res.ok) {
      // 401 은 거의 항상 "토큰 만료" 다. 사유를 그대로 노출해야 사용자가 조치한다.
      return fail(
        new Error(
          res.status === 401
            ? "인증 만료 — Claude Code 에서 한 번 실행하면 토큰이 갱신됩니다"
            : `HTTP ${res.status}`,
        ),
      );
    }
    payload = await res.json();
  } catch (error) {
    return fail(error);
  }

  return parseQuota(payload);
}

async function readAccessToken(): Promise<string> {
  // 위와 같은 이유 — 홈 디렉토리 경로라 정적 분석 대상에서 뺀다.
  const raw = await fs.readFile(/* turbopackIgnore: true */ credentialsPath(), "utf8");
  const parsed = JSON.parse(raw) as {
    claudeAiOauth?: { accessToken?: unknown; expiresAt?: unknown };
  };
  const token = parsed.claudeAiOauth?.accessToken;
  if (typeof token !== "string" || !token) {
    throw new Error("자격증명 파일에 accessToken 이 없습니다");
  }
  return token;
}

/**
 * 응답 → 화면에 쓸 형태.
 *
 * `limits` 배열을 쓴다. 최상위의 `five_hour`·`seven_day` 와 같은 값이지만 이쪽만
 * **모델별 한도(`weekly_scoped`)까지** 들고 있고, 항목이 늘어도 그대로 따라온다.
 * 내부 엔드포인트라 필드가 언제든 바뀔 수 있으므로 하나하나 방어적으로 읽는다.
 */
export function parseQuota(payload: unknown): QuotaSnapshot {
  const root = payload as Record<string, unknown> | null;
  const raw = Array.isArray(root?.limits) ? (root.limits as unknown[]) : null;
  if (!raw) return fail(new Error("응답에 limits 배열이 없습니다"));

  const windows: QuotaWindow[] = [];
  for (const item of raw) {
    const o = item as Record<string, unknown>;
    /**
     * `Number(null)` 은 0 이다. 그냥 Number() 에 넘기면 한도를 **모르는** 상태가
     * "0% 사용 = 100% 남음" 으로 둔갑한다 — 이 화면에서 제일 위험한 오작동이라
     * (다 썼는데 여유 있다고 표시된다) 숫자·숫자꼴 문자열만 통과시킨다.
     */
    if (typeof o?.percent !== "number" && typeof o?.percent !== "string") continue;
    const percent = Number(o.percent);
    if (!Number.isFinite(percent)) continue;

    const kind = typeof o.kind === "string" ? o.kind : "unknown";
    const used = clamp(percent);
    windows.push({
      key: kind,
      label: labelOf(kind, o.scope),
      usedPercent: used,
      // 100 을 넘겨 온 적은 없지만, 넘어와도 "남음 -5%" 가 뜨면 안 된다.
      remainingPercent: clamp(100 - used),
      resetsAt: typeof o.resets_at === "string" ? o.resets_at : null,
      severity: typeof o.severity === "string" ? o.severity : "normal",
    });
  }

  if (windows.length === 0) return fail(new Error("한도 항목이 비어 있습니다"));

  const extra = root?.extra_usage as Record<string, unknown> | undefined;
  return {
    windows,
    // 이게 false 면 한도를 넘겨도 돈이 더 나가지 않고 **막히기만** 한다.
    // 화면 문구가 "초과 시 과금" 이냐 "초과 시 중단" 이냐를 이 값이 가른다.
    extraUsageEnabled: extra?.is_enabled === true,
  };
}

const LABELS: Record<string, string> = {
  session: "5시간",
  weekly_all: "이번 주",
  weekly_scoped: "이번 주",
};

function labelOf(kind: string, scope: unknown): string {
  const base = LABELS[kind] ?? kind;
  const model = (scope as { model?: { display_name?: unknown } } | null)?.model
    ?.display_name;
  // 모델별 한도는 "이번 주" 가 둘이 되므로 모델명을 붙여야 구분된다.
  return typeof model === "string" && model ? `${base} · ${model}` : base;
}

function clamp(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n)));
}

function fail(error: unknown): QuotaSnapshot {
  const message = error instanceof Error ? error.message : String(error);
  console.warn("[quota] 한도 조회 실패", message);
  return { windows: [], extraUsageEnabled: false, error: message };
}
