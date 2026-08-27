/**
 * 서비스 레지스트리 — **AI API 벤더를 추가하는 곳은 여기 한 곳이다.**
 *
 * 이 대시보드는 AI API 비용만 다룬다 (2026-08-26 확정). Vercel·Supabase 등
 * 인프라 비용은 범위 밖이고, 관련 코드는 같은 날 전부 걷어냈다.
 *
 * 한 벤더를 붙이는 데 필요한 것은 아래 `ServiceDefinition` 하나뿐이다:
 *   - 화면 문구 (탭 이름·축 이름·주의문)
 *   - 지표 정의 (`metricSpecs`) 와 집계 옵션 (`build`)
 *   - 실 API 조회 두 개 (`fetchDays` = 본문, `fetchTodayUsage` = 미니 위젯)
 *   - 목업 파일 이름과 변환 함수
 *
 * 집계·안분·KST 접기·단가 역산은 전부 공통 코드가 한다. 벤더 파일에 그 로직을
 * 다시 쓰지 말 것 — 그러면 "Claude 탭은 맞는데 GPT 탭은 합계가 안 맞는" 상태가 된다.
 *
 * ── 하루 경계 ──────────────────────────────────────────────────────────────
 * **모든 서비스가 KST 자정 기준이다.** 예외를 만들지 않는다. 두 벤더 모두
 * 사용량을 1시간 버킷으로 주기 때문에 KST 자정(= UTC 15:00 정각)에 정확히 맞춰
 * 다시 접을 수 있다. 비용만 UTC 하루라 단가 역산으로 채운다 (`lib/token-rates.ts`).
 */

import {
  ANTHROPIC_BUILD,
  ANTHROPIC_METRICS,
  ANTHROPIC_PRIMARY_METRIC,
  toCostDays as anthropicCostDays,
  toDayRows as anthropicDayRows,
  toHourBuckets as anthropicHourBuckets,
  toUsageRows as anthropicUsageRows,
  type AnthropicRaw,
} from "@/lib/adapters/anthropic";
import type { BuildOptions, DayRows, KeyMeta, UsageRow } from "@/lib/adapters/core";
import {
  OPENAI_BUILD,
  OPENAI_METRICS,
  OPENAI_PRIMARY_METRIC,
  toCostDays as openaiCostDays,
  toDayRows as openaiDayRows,
  toHourBuckets as openaiHourBuckets,
  toUsageRows as openaiUsageRows,
  type OpenAiRaw,
} from "@/lib/adapters/openai";
import {
  fetchAllAnthropicApiKeys,
  fetchAllAnthropicCostBuckets,
  fetchAllAnthropicUsageBuckets,
} from "@/lib/clients/anthropic";
import {
  fetchAllOpenAiCostBuckets,
  fetchAllOpenAiProjectApiKeys,
  fetchAllOpenAiProjects,
  fetchAllOpenAiUsageBuckets,
  hasOpenAiCredentials,
  toUnixSeconds,
} from "@/lib/clients/openai";
import { buildKstDays, type KstDaysResult } from "@/lib/kst-days";
import { kstMonthWindow } from "@/lib/kst";
import type { MetricSpec, ServiceId } from "@/lib/types";

export type VendorDays = KstDaysResult & {
  /** 보조 축(API 키·프로젝트)의 id → 이름. 없으면 id 앞자리로 표시된다. */
  keys: KeyMeta[];
};

export type ServiceDefinition = {
  id: ServiceId;
  label: string;
  /** 주 축 이름. 두 벤더 모두 "모델". */
  breakdownLabel: string;
  /** 보조 축. Claude 는 API 키(= 거래처), GPT 는 프로젝트. */
  altBreakdown: { label: string; notice?: string; note?: string };
  metricSpecs: MetricSpec[];
  primaryMetric: string;
  build: BuildOptions;
  /** `mock/` 아래 파일명. 목업 모드에서 읽는다. */
  mockFile: string;
  mockToDays: (raw: unknown) => DayRows[];
  /** 실 API 를 쓸 수 있는 상태인가. false 면 api 모드에서 탭이 안 뜬다. */
  isConfigured: () => boolean;
  /** 본문 대시보드용 — 전월 1일(KST) ~ 지금. */
  fetchDays: () => Promise<VendorDays>;
  /** 미니 위젯용 — KST 오늘 구간의 1시간 버킷. */
  fetchTodayUsage: (from: string, to: string) => Promise<UsageRow[]>;
  /** 실 API 모드에서 화면 하단에 띄울 주의문. */
  apiNote: string;
  /**
   * 실응답으로 검증되지 않은 벤더에 붙는 경고. 있으면 화면에도 그대로 나간다 —
   * 숫자가 틀릴 수 있다는 사실은 숨기면 안 된다.
   */
  unverified?: string;
};

// ============================================================================
// Claude (Anthropic) — 실키 검증 완료 (2026-08-25)
// ============================================================================

const ANTHROPIC: ServiceDefinition = {
  id: "claude",
  label: "Claude",
  breakdownLabel: "모델",
  altBreakdown: {
    label: "서비스",
    notice:
      "이 표는 API 키 기준으로 나뉩니다. 키를 새로 만들거나 이름을 바꾼 시점 이후의 " +
      "데이터부터 정확하게 구분됩니다.",
    note:
      "cost_report 는 api_key_id 로 나눌 수 없어(group_by 는 description·workspace_id 뿐), " +
      "키별 비용은 같은 날·같은 모델·같은 토큰 종류의 토큰 수 비율로 안분한 추정치입니다. " +
      "토큰 수는 usage_report 실측값입니다. " +
      "표시 이름은 config/client-keys.json 에서 바꿀 수 있습니다 (작성법은 config/README.md).",
  },
  metricSpecs: ANTHROPIC_METRICS,
  primaryMetric: ANTHROPIC_PRIMARY_METRIC,
  build: ANTHROPIC_BUILD,
  mockFile: "anthropic-usage.json",
  mockToDays: (raw) => anthropicDayRows(raw as AnthropicRaw),
  // Anthropic 은 이 대시보드의 기본 서비스라 키가 없으면 에러 화면이 뜨는 편이 맞다.
  isConfigured: () => true,

  /**
   * ⚠️ 사용량을 **1일이 아니라 1시간** 버킷으로 받는다. KST 자정(= UTC 15:00)이
   *    시간 버킷 경계와 정확히 맞아떨어져야 하루가 어긋나지 않기 때문이다.
   *    2026-08-25 실측: 조회 구간 1,344시간 → 8페이지, 총 0.38MB, 페이지당 1.5초.
   */
  fetchDays: async () => {
    const { from, to } = kstMonthWindow();

    const [hourly, cost, keys] = await Promise.all([
      fetchAllAnthropicUsageBuckets({
        starting_at: from,
        ending_at: to,
        bucket_width: "1h",
        // 1h 는 페이지당 최대 168버킷(=7일). 구간이 두 달이라 8페이지쯤 된다.
        limit: 168,
        // 키별(서비스별) 집계를 하려면 api_key_id 가 반드시 있어야 한다.
        group_by: ["model", "api_key_id"],
      }),
      // ⚠️ cost_report 는 **1d 뿐이고** group_by 도 description / workspace_id 만 된다.
      //    api_key_id 를 넣으면 400 이 난다 (2026-08-14 실측). 그래서 이 값은 화면에
      //    직접 나가지 않고 **단가 역산에만** 쓴다.
      fetchAllAnthropicCostBuckets({
        starting_at: from,
        ending_at: to,
        bucket_width: "1d",
        limit: 31,
        group_by: ["description", "workspace_id"],
      }),
      anthropicKeyNames(),
    ]);

    return {
      ...buildKstDays({
        hourly: anthropicHourBuckets(hourly),
        cost: anthropicCostDays(cost),
      }),
      keys,
    };
  },

  fetchTodayUsage: async (from, to) => {
    const buckets = await fetchAllAnthropicUsageBuckets({
      starting_at: from,
      ending_at: to,
      bucket_width: "1h",
      limit: 24,
      group_by: ["model", "api_key_id"],
    });
    return buckets.flatMap((b) => anthropicUsageRows(b.results));
  },

  apiNote:
    "토큰 수는 1시간 버킷을 한국시간 하루로 다시 합친 실측값입니다. " +
    "비용은 cost_report 가 UTC 하루 단위로만 나와서 한국시간으로 자를 수 없기 때문에, " +
    "최근 구간의 (비용 ÷ 토큰) 으로 역산한 단가를 곱한 추정치입니다 " +
    "(하루씩 빼고 맞히는 검증에서 오차 ±0.1%). 청구서와 소수점까지 같지는 않습니다.",
};

/**
 * 키 id → 이름 매핑. 이름 조회는 **부가 정보**라, 실패해도 대시보드 전체를 죽이지 않고
 * 빈 목록으로 넘긴다 (표에는 "미등록" + id 앞자리로 뜬다).
 *
 * status 필터를 걸지 않는다 — 과거 사용량에는 지금 archived 인 키도 등장하고,
 * 필터를 걸면 그 몫이 통째로 "미등록" 이 된다.
 */
async function anthropicKeyNames(): Promise<KeyMeta[]> {
  try {
    return await fetchAllAnthropicApiKeys();
  } catch (error) {
    console.warn(
      "[services] Anthropic List API Keys 실패 — 키 이름 없이 id 로 표시합니다.",
      error instanceof Error ? error.message : error,
    );
    return [];
  }
}

// ============================================================================
// GPT (OpenAI) — ⚠️ 자리만 잡아 둔 상태. 실키 미검증.
// ============================================================================

/**
 * ✅ 2026-08-27 실키 검증 완료 (`node scripts/verify_openai.mjs` 19/19).
 *    경로·필드명·페이지네이션·금액 단위·group_by 전부 실응답으로 확인했다.
 *    같은 날 60일치 실측으로 단가 조인 매칭률 **금액 기준 100%** 도 확인했다.
 *
 * 그래도 문구를 남기는 이유: **단가 역산 자체가 추정이라는 사실은 변하지 않는다.**
 * Anthropic 쪽은 hold-out 검증(하루를 빼고 그 하루를 맞히기)으로 오차 ±0.1% 를
 * 확인했지만 OpenAI 쪽은 아직 그 검증을 못 했다.
 */
const OPENAI_UNVERIFIED =
  "GPT 비용은 단가 역산 추정치입니다 (토큰 수는 실측). 조회 API 자체는 " +
  "2026-08-27 실키로 검증했지만, 추정 오차 폭은 아직 측정하지 않았습니다 — " +
  "청구서 대신 쓰지 마세요. docs/openai-integration.md 참고.";

const OPENAI: ServiceDefinition = {
  id: "gpt",
  label: "GPT",
  breakdownLabel: "모델",
  altBreakdown: {
    label: "API 키",
    notice:
      "이름은 '프로젝트 / 키' 로 표시됩니다. 키가 안 붙는 사용분(콘솔·비 API 트래픽)은 " +
      "api_key_id 가 비어서 오기 때문에 그 프로젝트 몫으로 묶입니다.",
    note:
      "costs 는 모델로도 키로도 나눌 수 없어(group_by 는 line_item·project_id 뿐), " +
      "키별 비용은 같은 날·같은 모델·같은 토큰 종류의 토큰 수 비율로 안분한 " +
      "추정치입니다. 토큰 수는 usage 실측값입니다.",
  },
  metricSpecs: OPENAI_METRICS,
  primaryMetric: OPENAI_PRIMARY_METRIC,
  build: OPENAI_BUILD,
  mockFile: "openai-usage.json",
  mockToDays: (raw) => openaiDayRows(raw as OpenAiRaw),
  // 키가 없으면 탭 자체가 안 뜬다 — 아직 안 붙인 벤더로 화면을 어지럽히지 않는다.
  isConfigured: hasOpenAiCredentials,

  fetchDays: async () => {
    const { from, to } = kstMonthWindow();

    const [hourly, cost, keys] = await Promise.all([
      fetchAllOpenAiUsageBuckets({
        start_time: toUnixSeconds(from),
        end_time: toUnixSeconds(to),
        bucket_width: "1h",
        limit: 168,
        group_by: ["model", "project_id", "api_key_id"],
      }),
      // ⚠️ costs 는 1d 뿐이고 model 로 group_by 할 수 없다 (Anthropic 과 같은 제약).
      //    화면에 직접 나가지 않고 **단가 역산에만** 쓴다.
      fetchAllOpenAiCostBuckets({
        start_time: toUnixSeconds(from),
        end_time: toUnixSeconds(to),
        bucket_width: "1d",
        // ⚠️ 기본값이 7 이라 그대로 두면 8일째부터 조용히 잘린다.
        limit: 180,
        group_by: ["line_item", "project_id"],
      }),
      openaiKeyNames(),
    ]);

    return {
      ...buildKstDays({
        hourly: openaiHourBuckets(hourly),
        cost: openaiCostDays(cost),
      }),
      keys,
    };
  },

  fetchTodayUsage: async (from, to) => {
    const buckets = await fetchAllOpenAiUsageBuckets({
      start_time: toUnixSeconds(from),
      end_time: toUnixSeconds(to),
      bucket_width: "1h",
      limit: 24,
      group_by: ["model", "project_id", "api_key_id"],
    });
    return buckets.flatMap((b) => openaiUsageRows(b.results));
  },

  apiNote:
    "토큰 수는 1시간 버킷을 한국시간 하루로 다시 합친 실측값입니다. " +
    "비용은 costs 가 UTC 하루 단위로만 나와서 한국시간으로 자를 수 없기 때문에, " +
    "최근 구간의 (비용 ÷ 토큰) 으로 역산한 단가를 곱한 추정치입니다. " +
    "입력 토큰은 캐시 읽기를 뺀 값입니다 (Claude 탭과 뜻을 맞췄습니다).",

  unverified: OPENAI_UNVERIFIED,
};

/**
 * API 키 id → 이름, 그리고 프로젝트 id → 이름. **한 배열에 둘 다 담는다.**
 *
 * OpenAI 에는 조직 전체 키를 주는 엔드포인트가 없어서 프로젝트를 먼저 나열하고
 * 프로젝트마다 키 목록을 다시 두드린다. 프로젝트가 N 개면 요청이 N+1 번이라
 * 하루 1회 캐시(`lib/data-source.ts`) 안에서만 돈다.
 *
 * 프로젝트 항목도 함께 넣는 이유는 `api_key_id` 가 비어 오는 사용분(콘솔·비 API
 * 트래픽)이 project_id 로 떨어지기 때문이다 (`lib/adapters/openai.ts` 6번).
 *
 * Anthropic 의 키 이름 조회와 같은 원칙으로 **실패를 삼킨다** — 이름은 부가
 * 정보라 목록 하나 때문에 탭 전체가 죽으면 안 된다.
 */
async function openaiKeyNames(): Promise<KeyMeta[]> {
  let projects: Awaited<ReturnType<typeof fetchAllOpenAiProjects>>;
  try {
    projects = await fetchAllOpenAiProjects();
  } catch (error) {
    console.warn(
      "[services] OpenAI 프로젝트 목록 실패 — 이름 없이 id 로 표시합니다.",
      error instanceof Error ? error.message : error,
    );
    return [];
  }

  const metas: KeyMeta[] = projects.map((p) => ({
    id: p.id,
    name: p.name,
    status: p.status,
  }));

  const perProject = await Promise.all(
    projects.map(async (p) => {
      try {
        const keys = await fetchAllOpenAiProjectApiKeys(p.id);
        return keys.map(
          (k): KeyMeta => ({
            id: k.id,
            // 프로젝트를 앞에 붙인다 — 키 이름은 프로젝트끼리 겹치는 일이 흔하다.
            name: `${p.name} / ${k.name ?? k.id}`,
            // 키 목록에는 상태 필드가 없다. 프로젝트가 보관되면 키도 못 쓴다.
            status: p.status,
            partial_key_hint: k.redacted_value ?? null,
          }),
        );
      } catch (error) {
        console.warn(
          `[services] OpenAI 프로젝트 ${p.id} 의 키 목록 실패 — id 로 표시합니다.`,
          error instanceof Error ? error.message : error,
        );
        return [];
      }
    }),
  );

  return metas.concat(...perProject);
}

// ============================================================================
// 레지스트리
// ============================================================================

/** 등록 순서가 곧 탭 순서다. */
export const SERVICES: ServiceDefinition[] = [ANTHROPIC, OPENAI];

const BY_ID = new Map<ServiceId, ServiceDefinition>(SERVICES.map((s) => [s.id, s]));

export function getService(id: ServiceId): ServiceDefinition {
  const service = BY_ID.get(id);
  if (!service) throw new Error(`알 수 없는 서비스: ${id}`);
  return service;
}

/**
 * 화면에 띄울 서비스.
 *
 * 목업 모드는 전부 띄운다 — 화면 배치를 보는 게 목적이라 키가 없어도 상관없다.
 * 실 API 모드는 **키가 있는 것만** 띄운다. 아직 안 붙인 벤더 탭이 "조회 실패" 로
 * 떠 있으면 진짜 장애와 구분이 안 된다.
 */
export function enabledServices(mode: "mock" | "api"): ServiceDefinition[] {
  if (mode === "mock") return SERVICES;
  return SERVICES.filter((s) => s.isConfigured());
}
