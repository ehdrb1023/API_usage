/**
 * 즐겨찾기 키 — **브라우저(localStorage)에만** 저장한다. 사람마다 보고 싶은 키가 달라서
 * 서버에 두지 않는다. 다른 PC·다른 사람 화면에는 반영되지 않는다.
 *
 * 저장 모양: `{ [serviceId]: apiKeyId[] }`. 키 id 는 서비스(계정)마다 따로라 서비스로 나눈다.
 *
 * ⚠️ localStorage 는 비공개 창·차단 설정에서 **읽기만 해도 던진다.** 전부 try/catch 로 감싸고,
 *    실패하면 즐겨찾기 없이(= 비용 상위 키로) 그린다.
 *
 * 클라이언트 전용.
 */

import { useCallback, useMemo, useSyncExternalStore } from "react";

import type { ServiceId } from "@/lib/types";

export const FAVORITES_STORAGE_KEY = "api-usage.favorites.v1";

export type Favorites = Partial<Record<ServiceId, string[]>>;

/** 저장값을 믿지 않는다 — 문자열 배열이 아닌 건 버린다. */
export function parseFavorites(raw: string | null): Favorites {
  if (!raw) return {};
  try {
    const obj = JSON.parse(raw) as unknown;
    if (!obj || typeof obj !== "object") return {};
    const out: Favorites = {};
    for (const [service, ids] of Object.entries(obj as Record<string, unknown>)) {
      if (!Array.isArray(ids)) continue;
      const clean = ids.filter((x): x is string => typeof x === "string");
      if (clean.length) out[service as ServiceId] = [...new Set(clean)];
    }
    return out;
  } catch {
    return {};
  }
}

export function toggleFavorite(favs: Favorites, service: ServiceId, keyId: string): Favorites {
  const current = favs[service] ?? [];
  const next = current.includes(keyId)
    ? current.filter((k) => k !== keyId)
    : [...current, keyId];
  return { ...favs, [service]: next };
}

/** 같은 탭 안의 변경은 `storage` 이벤트가 안 오므로 직접 알린다. */
const LOCAL_EVENT = "api-usage:favorites";

function readRaw(): string | null {
  try {
    return window.localStorage.getItem(FAVORITES_STORAGE_KEY);
  } catch {
    return null;
  }
}

function write(favs: Favorites): void {
  try {
    window.localStorage.setItem(FAVORITES_STORAGE_KEY, JSON.stringify(favs));
  } catch {
    /* 저장 못 하면 이번 변경은 사라진다 — 차단된 브라우저에서는 어쩔 수 없다 */
  }
  window.dispatchEvent(new Event(LOCAL_EVENT));
}

function subscribe(onChange: () => void): () => void {
  const onStorage = (e: StorageEvent) => {
    if (e.key === FAVORITES_STORAGE_KEY) onChange();
  };
  window.addEventListener("storage", onStorage);
  window.addEventListener(LOCAL_EVENT, onChange);
  return () => {
    window.removeEventListener("storage", onStorage);
    window.removeEventListener(LOCAL_EVENT, onChange);
  };
}

/**
 * 스냅샷은 **원문 문자열**이다 — 매번 새 객체를 돌려주면 무한 렌더가 난다.
 * 서버 렌더에서는 null(= 즐겨찾기 없음)이라 하이드레이션 뒤에 저장값으로 바뀐다.
 * 다른 탭에서 바꾸면 `storage` 이벤트로 따라간다.
 */
export function useFavorites(): {
  favorites: Favorites;
  toggle: (service: ServiceId, keyId: string) => void;
} {
  const raw = useSyncExternalStore(subscribe, readRaw, () => null);
  const favorites = useMemo(() => parseFavorites(raw), [raw]);

  const toggle = useCallback((service: ServiceId, keyId: string) => {
    write(toggleFavorite(parseFavorites(readRaw()), service, keyId));
  }, []);

  return { favorites, toggle };
}
