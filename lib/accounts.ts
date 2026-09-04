/**
 * Claude 계정 레지스트리 — **키 하나당 조직 하나.**
 *
 * ── 왜 계정마다 탭이 따로인가 ──────────────────────────────────────────────
 * Anthropic Admin 키는 **발급한 조직 하나만** 본다. 조직이 셋이면 키도 셋이고,
 * 한 탭에 합치면 "어느 계정에서 새는지" 가 사라진다. 이 대시보드가 답하려는
 * 질문이 정확히 그것이라 합치지 않는다.
 *
 * ── ⚠️ 키를 폴백시키지 않는다 ──────────────────────────────────────────────
 * `resolveAnthropicConfig` 은 `adminKey` 가 비면 `process.env.ANTHROPIC_ADMIN_KEY`
 * 로 떨어진다. 2번 계정 키가 없을 때 그 폴백이 걸리면 **1번 계정 숫자가 2번 탭에
 * 그대로 뜬다** — 조용히 틀린 숫자다. 그래서 `requireAdminKey()` 로 명시적으로
 * 끊는다.
 *
 * ── 표시 이름 ──────────────────────────────────────────────────────────────
 * `config/accounts.json` 에서 바꾼다. 코드 수정도 재배포도 필요 없다
 * (`config/client-keys.json` 과 같은 방식).
 */

import { promises as fs } from "node:fs";
import path from "node:path";

import { isServiceId, type ServiceId } from "@/lib/types";

export const ACCOUNTS_FILE = path.join("config", "accounts.json");

export type ClaudeAccount = {
  id: ServiceId;
  /** `config/accounts.json` 에 이름이 없을 때 쓸 기본 표시 이름. */
  defaultLabel: string;
  /** 이 계정의 Admin 키가 들어 있는 환경변수 이름. */
  envVar: string;
};

/**
 * 계정 목록. **순서가 곧 탭 순서다.**
 *
 * 계정을 더 늘리려면 (1) 여기 한 줄, (2) `ServiceId` 에 id 하나,
 * (3) `.env` 에 키 하나. 셋 다 해야 뜬다 — 하나라도 빠지면 타입 검사나
 * `isConfigured()` 에서 걸린다.
 */
export const CLAUDE_ACCOUNTS: ClaudeAccount[] = [
  { id: "claude", defaultLabel: "Claude 1", envVar: "ANTHROPIC_ADMIN_KEY" },
  { id: "claude-2", defaultLabel: "Claude 2", envVar: "ANTHROPIC_ADMIN_KEY_2" },
  { id: "claude-3", defaultLabel: "Claude 3", envVar: "ANTHROPIC_ADMIN_KEY_3" },
];

/** `.env.example` 의 자리표시자를 진짜 키로 오인하지 않도록 (클라이언트와 같은 규칙). */
const PLACEHOLDER_PATTERN = /x{8,}/i;

/** 이 계정의 키가 실제로 쓸 수 있는 상태인가. 자리표시자는 없는 것으로 본다. */
export function hasAdminKey(envVar: string): boolean {
  const value = (process.env[envVar] ?? "").trim();
  return value !== "" && !PLACEHOLDER_PATTERN.test(value);
}

/**
 * 키를 꺼낸다. **없으면 던진다** — 다른 계정 키로 폴백시키지 않는다.
 * (위 주석의 "조용히 틀린 숫자" 를 막는 지점이다.)
 */
export function requireAdminKey(envVar: string): string {
  const value = (process.env[envVar] ?? "").trim();
  if (!value) {
    throw new Error(
      `${envVar} 가 .env 에 없습니다. Console → Settings → Admin keys 에서 ` +
        `해당 조직의 Owner 권한으로 Admin 키(sk-ant-admin...)를 발급해 넣어 주세요. ` +
        `다른 계정 키로 대신 조회하지 않습니다 — 그러면 남의 조직 숫자가 이 탭에 뜹니다.`,
    );
  }
  if (PLACEHOLDER_PATTERN.test(value)) {
    throw new Error(`${envVar} 가 자리표시자 값 그대로입니다. 실제 Admin 키로 바꿔 주세요.`);
  }
  return value;
}

/**
 * 표시 이름 매핑. 파일이 없거나 깨져도 빈 값 —
 * 설정 파일 하나 때문에 대시보드가 죽으면 안 된다.
 */
export async function loadAccountLabels(
  root = process.cwd(),
): Promise<Partial<Record<ServiceId, string>>> {
  let text: string;
  try {
    text = await fs.readFile(path.join(root, ACCOUNTS_FILE), "utf8");
  } catch {
    return {};
  }

  try {
    return parseAccountLabels(JSON.parse(text));
  } catch (error) {
    console.warn(
      `[accounts] ${ACCOUNTS_FILE} 을 읽지 못했습니다 —`,
      error instanceof Error ? error.message : String(error),
    );
    return {};
  }
}

/** 알 수 없는 id·빈 이름은 버린다. 오타를 조용히 통과시키지 않는다. */
export function parseAccountLabels(raw: unknown): Partial<Record<ServiceId, string>> {
  const labels = (raw as { labels?: unknown } | null)?.labels;
  if (!labels || typeof labels !== "object") return {};

  const out: Partial<Record<ServiceId, string>> = {};
  for (const [key, value] of Object.entries(labels as Record<string, unknown>)) {
    if (!isServiceId(key)) continue;
    if (typeof value !== "string" || value.trim() === "") continue;
    out[key] = value.trim();
  }
  return out;
}
