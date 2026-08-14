import { promises as fs } from "node:fs";
import path from "node:path";

import {
  ANTHROPIC_METRICS,
  ANTHROPIC_PRIMARY_METRIC,
  adaptAnthropic,
  type AnthropicRaw,
} from "@/lib/adapters/anthropic";
import {
  VERCEL_METRICS,
  VERCEL_PRIMARY_METRIC,
  adaptVercel,
  type VercelRaw,
} from "@/lib/adapters/vercel";
import type { ServiceId, ServiceSeries } from "@/lib/types";

/**
 * ★ 목업 ↔ 실제 API 스위치는 여기 한 곳뿐이다.
 *
 *   .env 의  DATA_SOURCE=mock   → mock/*.json 을 읽는다 (기본값)
 *            DATA_SOURCE=api    → 실제 API 를 호출한다
 *
 * 어느 쪽이든 같은 어댑터를 타고 같은 ServiceSeries 가 나오므로, 화면 코드는
 * 전혀 손대지 않아도 된다. 목업 파일이 실제 응답 스키마 그대로 생겼기 때문에
 * 가능한 구조다.
 *
 * 서버에서만 실행된다 (fs 접근 + API 키). 클라이언트 컴포넌트에서 import 금지.
 */

export type DataSourceMode = "mock" | "api";

export function getDataSourceMode(): DataSourceMode {
  return process.env.DATA_SOURCE === "api" ? "api" : "mock";
}

export async function getServiceSeries(service: ServiceId): Promise<ServiceSeries> {
  const mode = getDataSourceMode();
  return service === "claude" ? getClaude(mode) : getVercel(mode);
}

export async function getAllSeries(): Promise<ServiceSeries[]> {
  return Promise.all([getServiceSeries("claude"), getServiceSeries("vercel")]);
}

// ---------------------------------------------------------------- Claude

async function getClaude(mode: DataSourceMode): Promise<ServiceSeries> {
  const raw =
    mode === "mock"
      ? await readMock<AnthropicRaw>("anthropic-usage.json")
      : await fetchAnthropic();

  return {
    service: "claude",
    label: "Claude",
    breakdownLabel: "모델",
    primaryMetric: ANTHROPIC_PRIMARY_METRIC,
    metricSpecs: ANTHROPIC_METRICS,
    points: adaptAnthropic(raw),
    source: mode,
    note:
      mode === "mock"
        ? "목업 데이터입니다. 실제 API 연동 시 필드명 확인 필요."
        : undefined,
  };
}

/** Anthropic Admin API 두 엔드포인트를 커서 페이지네이션으로 전부 긁어온다. */
async function fetchAnthropic(): Promise<AnthropicRaw> {
  const key = requireEnv("ANTHROPIC_ADMIN_KEY");
  const version = process.env.ANTHROPIC_API_VERSION ?? "2023-06-01";
  const base = process.env.ANTHROPIC_API_BASE ?? "https://api.anthropic.com";
  const { from, to } = fetchWindow();

  const headers = {
    "x-api-key": key,
    "anthropic-version": version,
    accept: "application/json",
  };

  // bucket_width=1d 는 최대 31버킷/페이지라, 45일치는 반드시 2페이지 이상이 된다.
  const collect = async (endpoint: string, groupBy: string[]) => {
    const buckets: unknown[] = [];
    let page: string | null = null;

    do {
      const url = new URL(endpoint, base);
      url.searchParams.set("starting_at", from);
      url.searchParams.set("ending_at", to);
      url.searchParams.set("bucket_width", "1d");
      url.searchParams.set("limit", "31");
      for (const g of groupBy) url.searchParams.append("group_by[]", g);
      if (page) url.searchParams.set("page", page);

      const res = await fetch(url, { headers, cache: "no-store" });
      if (!res.ok) {
        throw new Error(
          `Anthropic ${endpoint} 실패 (HTTP ${res.status}): ${await res.text()}`,
        );
      }
      const json = await res.json();
      buckets.push(...(json.data ?? []));
      page = json.has_more ? json.next_page : null;
    } while (page);

    return buckets;
  };

  const [usage, cost] = await Promise.all([
    collect("/v1/organizations/usage_report/messages", [
      "model",
      "api_key_id",
      "workspace_id",
    ]),
    // cost_report 는 description / workspace_id 만 group_by 가능하다.
    collect("/v1/organizations/cost_report", ["description", "workspace_id"]),
  ]);

  return {
    usage_report: { data: usage as AnthropicRaw["usage_report"]["data"] },
    cost_report: { data: cost as AnthropicRaw["cost_report"]["data"] },
  };
}

// ---------------------------------------------------------------- Vercel

async function getVercel(mode: DataSourceMode): Promise<ServiceSeries> {
  const raw =
    mode === "mock"
      ? await readMock<VercelRaw>("vercel-usage.json")
      : await fetchVercel();

  return {
    service: "vercel",
    label: "Vercel",
    breakdownLabel: "프로젝트",
    primaryMetric: VERCEL_PRIMARY_METRIC,
    metricSpecs: VERCEL_METRICS,
    points: adaptVercel(raw),
    source: mode,
    note:
      mode === "mock"
        ? "목업 데이터입니다. 실제 API 연동 시 필드명 확인 필요."
        : undefined,
  };
}

/** Vercel 은 페이지네이션이 없다. JSONL 스트림을 한 번에 받아 줄 단위로 파싱한다. */
async function fetchVercel(): Promise<VercelRaw> {
  const token = requireEnv("VERCEL_API_TOKEN");
  const base = process.env.VERCEL_API_BASE ?? "https://api.vercel.com";
  const { from, to } = fetchWindow();

  const url = new URL("/v1/billing/charges", base);
  url.searchParams.set("from", from);
  url.searchParams.set("to", to);
  if (process.env.VERCEL_TEAM_ID) {
    url.searchParams.set("teamId", process.env.VERCEL_TEAM_ID);
  }

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, accept: "application/jsonl" },
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(
      `Vercel /v1/billing/charges 실패 (HTTP ${res.status}): ${await res.text()}`,
    );
  }

  const text = await res.text();
  const charges = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l));

  return { charges };
}

// ---------------------------------------------------------------- 공통

async function readMock<T>(file: string): Promise<T> {
  const p = path.join(process.cwd(), "mock", file);
  return JSON.parse(await fs.readFile(p, "utf8")) as T;
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v || /^s(k|bp)-?.*x{10,}/.test(v)) {
    throw new Error(
      `.env 의 ${name} 가 비어 있거나 자리표시자 그대로입니다. ` +
        `실제 키를 넣거나 DATA_SOURCE=mock 으로 두세요.`,
    );
  }
  return v;
}

/**
 * 조회 구간. 전월 동기 대비를 계산하려면 이번 달 + 전월 전체가 필요하므로
 * 전월 1일부터 오늘까지 받는다.
 */
function fetchWindow() {
  const now = new Date();
  const from = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1, 0, 0, 0),
  );
  const to = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0),
  );
  return { from: from.toISOString(), to: to.toISOString() };
}
