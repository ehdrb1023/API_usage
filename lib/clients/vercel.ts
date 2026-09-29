/**
 * Vercel REST API — 프로젝트·도메인·환경변수를 읽어 **키 사용처 대조**에 넘긴다.
 *
 *   GET /v9/projects                      프로젝트 목록 (+ 운영 도메인 alias)
 *   GET /v10/projects/{id}/env            변수 목록 — 값은 안 온다 (목록의 decrypt=true 는 무시된다)
 *   GET /v1/projects/{id}/env/{envId}     변수 하나 — "encrypted" 타입만 값을 복호화해 준다
 *
 * ⚠️ **키 원문을 이 파일 밖으로 내보내지 않는다.** 복호화한 값은 받은 자리에서
 *    `maskKey()` 로 `앞16자...뒤4자` 로 줄이고 버린다. 결과가 `unstable_cache` 로
 *    디스크에 저장되기 때문이다.
 *
 * ⚠️ "sensitive" 타입은 API 로도 값을 주지 않는다 (2026-09-29 확인: 787개 중 501개).
 *    그런 변수는 `masked: null` 로 두고 이름만 넘긴다.
 *
 * ⚠️ 복호화는 **API 키로 보이는 이름**의 변수에만 요청한다 (`DECRYPT_NAME`).
 *    DB 비밀번호 같은 다른 비밀까지 읽을 이유가 없다.
 *
 * 필요한 것: VERCEL_API_TOKEN (팀 범위 권한 필수), VERCEL_TEAM_ID.
 * 서버 전용. 클라이언트 컴포넌트에서 import 금지.
 */

import { maskKey, type HostProject, type HostVar } from "@/lib/key-locations";

const BASE = "https://api.vercel.com";

/** 이 이름의 변수만 복호화한다. 벤더 키가 담겼을 법한 이름. */
const DECRYPT_NAME = /(ANTHROPIC|CLAUDE|OPENAI|GPT|LLM|(^|_)AI_)|API_KEY$/i;

/** 동시 요청 수. 프로젝트 60개 × 변수 요청이라 한 번에 다 쏘면 429 가 난다. */
const CONCURRENCY = 6;

export function hasVercelCredentials(): boolean {
  return !!process.env.VERCEL_API_TOKEN?.trim();
}

type RawProject = {
  id: string;
  name: string;
  targets?: { production?: { alias?: string[] } };
  alias?: { domain?: string }[];
};

type RawEnv = {
  id: string;
  key: string;
  type: string;
  target?: string[] | string;
  value?: string;
  decrypted?: boolean;
};

async function get<T>(path: string): Promise<T> {
  const token = process.env.VERCEL_API_TOKEN?.trim();
  if (!token) throw new Error("VERCEL_API_TOKEN 이 .env 에 없습니다.");
  const team = process.env.VERCEL_TEAM_ID?.trim();
  const url = `${BASE}${path}${path.includes("?") ? "&" : "?"}${team ? `teamId=${team}` : ""}`;

  const res = await fetch(url, { headers: { authorization: `Bearer ${token}` }, cache: "no-store" });
  if (!res.ok) {
    const body = (await res.text()).slice(0, 300);
    if (res.status === 403) {
      throw new Error(
        `Vercel 403 — 토큰이 팀(${team ?? "VERCEL_TEAM_ID 없음"}) 범위에 권한이 없습니다. ` +
          `Account Settings → Tokens 에서 Scope 를 그 팀으로 골라 다시 발급하세요. (${body})`,
      );
    }
    throw new Error(`Vercel ${res.status} ${path.split("?")[0]} — ${body}`);
  }
  return res.json() as Promise<T>;
}

async function pool<T, R>(items: T[], fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

async function listProjects(): Promise<RawProject[]> {
  const all: RawProject[] = [];
  let until: number | null = null;
  // 페이지당 최대 100. `pagination.next` 를 `until` 로 넘긴다.
  do {
    const page: { projects: RawProject[]; pagination?: { next: number | null } } = await get(
      `/v9/projects?limit=100${until ? `&until=${until}` : ""}`,
    );
    all.push(...page.projects);
    until = page.pagination?.next ?? null;
  } while (until);
  return all;
}

/** 커스텀 도메인을 앞에, `*.vercel.app` 은 커스텀이 없을 때 하나만. */
function pickDomains(p: RawProject): string[] {
  const aliases = p.targets?.production?.alias ?? p.alias?.map((a) => a.domain ?? "") ?? [];
  const custom = aliases.filter((d) => d && !d.endsWith(".vercel.app"));
  if (custom.length) return [...new Set(custom)];
  const fallback = aliases.filter(Boolean).sort((a, b) => a.length - b.length)[0];
  return fallback ? [fallback] : [];
}

async function readVar(projectId: string, env: RawEnv): Promise<HostVar> {
  const targets = Array.isArray(env.target) ? env.target : env.target ? [env.target] : [];
  const base = { key: env.key, type: env.type, targets };

  if (env.type === "sensitive" || !DECRYPT_NAME.test(env.key)) return { ...base, masked: null };
  if (env.type === "plain") return { ...base, masked: maskKey(env.value) };

  try {
    const one = await get<RawEnv>(`/v1/projects/${projectId}/env/${env.id}`);
    // 원문은 여기서 끝난다. 가린 모양만 밖으로 나간다.
    return { ...base, masked: one.decrypted === false ? null : maskKey(one.value) };
  } catch {
    return { ...base, masked: null };
  }
}

/** 팀의 모든 프로젝트 → 도메인 + 변수(가린 값). */
export async function fetchVercelProjects(): Promise<HostProject[]> {
  const projects = await listProjects();
  return pool(projects, async (p) => {
    const { envs } = await get<{ envs: RawEnv[] }>(`/v10/projects/${p.id}/env`);
    const vars: HostVar[] = [];
    for (const env of envs) vars.push(await readVar(p.id, env));
    return { name: p.name, domains: pickDomains(p), vars };
  });
}
