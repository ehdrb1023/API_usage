/**
 * 키 사용처 조립 — Vercel 프로젝트 목록(캐시) + 수동 지정 파일 + 벤더 키 목록
 * → `KeyLocationsView`. 대조 규칙 자체는 `lib/key-locations.ts` 에 있다.
 *
 * Vercel 조회는 **KST 하루 1회** 캐시한다 (프로젝트 60개 × 변수 요청이라 수십 초 걸린다).
 * 캐시에 들어가는 건 가린 값(`앞16자...뒤4자`)뿐이다 — `lib/clients/vercel.ts` 참고.
 *
 * 서버 전용 (fs·네트워크). 클라이언트 컴포넌트에서 import 금지.
 */

import { promises as fs } from "node:fs";
import path from "node:path";

import { unstable_cache } from "next/cache";

import type { KeyMeta } from "@/lib/adapters/core";
import { fetchVercelProjects, hasVercelCredentials } from "@/lib/clients/vercel";
import { kstCacheKey } from "@/lib/kst";
import {
  locateKeys,
  type HostProject,
  type KeyFamily,
  type ManualLocations,
} from "@/lib/key-locations";
import type { KeyLocationsView } from "@/lib/types";

export const KEY_LOCATIONS_FILE = path.join("config", "key-locations.json");

const projectsCache = unstable_cache(
  // 값은 안 쓰지만 캐시 키를 KST 하루 단위로 가르는 인자다.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async (_kstDay: string) => fetchVercelProjects(),
  ["vercel-projects"],
  { revalidate: 24 * 60 * 60, tags: ["key-locations"] },
);

/** 탭 4개가 동시에 부르면 첫 캐시 미스에 Vercel 을 네 번 훑는다. 진행 중인 요청을 나눠 쓴다. */
let inflight: { day: string; promise: Promise<HostProject[]> } | null = null;

function loadProjects(): Promise<HostProject[]> {
  const day = kstCacheKey();
  if (inflight?.day !== day) {
    const promise = projectsCache(day);
    inflight = { day, promise };
    // 실패는 캐시되지 않으므로 다음 요청이 다시 시도하게 비운다.
    promise.catch(() => {
      if (inflight?.promise === promise) inflight = null;
    });
  }
  return inflight.promise;
}

/**
 * `config/key-locations.json` — 이름으로 안 잡히는 키를 직접 지정한다.
 * 실패하면 빈 값. 매 요청 다시 읽는다 (저장하고 새로고침하면 반영).
 */
async function loadManual(): Promise<ManualLocations> {
  try {
    const raw = JSON.parse(
      await fs.readFile(path.join(process.cwd(), KEY_LOCATIONS_FILE), "utf8"),
    ) as { keys?: Record<string, unknown> };
    const out: ManualLocations = {};
    for (const [k, v] of Object.entries(raw.keys ?? {})) {
      const list = (Array.isArray(v) ? v : [v]).filter((x): x is string => typeof x === "string");
      if (list.length) out[k] = list;
    }
    return out;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
      console.warn(`[key-locations] ${KEY_LOCATIONS_FILE} 를 읽지 못했습니다.`, error);
    }
    return {};
  }
}

/** Vercel 토큰이 없으면 undefined — 표에 "사용처" 칸 자체가 안 생긴다. */
export async function getKeyLocations(
  keys: KeyMeta[],
  family: KeyFamily,
): Promise<KeyLocationsView | undefined> {
  if (!hasVercelCredentials()) return undefined;

  let projects: HostProject[];
  try {
    projects = await loadProjects();
  } catch (error) {
    return {
      byKey: {},
      projectCount: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  const subjects = keys.map((k) => ({
    id: k.id,
    name: k.matchName ?? k.name,
    hint: k.partial_key_hint,
  }));
  return {
    byKey: locateKeys(subjects, projects, family, await loadManual()),
    projectCount: projects.length,
  };
}
