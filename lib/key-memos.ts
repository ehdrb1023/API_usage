/**
 * API 키별 메모 — 즐겨찾기와 마찬가지로 브라우저(localStorage)에 저장한다.
 *
 * 서버 장부나 공개 설정 파일에 메모를 넣으면 배포·공유 범위가 커진다. 사용자가
 * 화면에서 바로 적는 개인 운영 메모이므로 서비스와 키 ID를 기준으로 브라우저에만 둔다.
 */

import { useCallback, useMemo, useSyncExternalStore } from "react";

import { isServiceId, type ServiceId } from "@/lib/types";

export const KEY_MEMOS_STORAGE_KEY = "api-usage.key-memos.v1";
export const KEY_MEMO_MAX_LENGTH = 500;

export type KeyMemos = Partial<Record<ServiceId, Record<string, string>>>;

/** 저장값을 그대로 믿지 않고, 알려진 서비스의 짧은 문자열 메모만 남긴다. */
export function parseKeyMemos(raw: string | null): KeyMemos {
  if (!raw) return {};
  try {
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== "object") return {};

    const out: KeyMemos = {};
    for (const [service, notes] of Object.entries(value as Record<string, unknown>)) {
      if (!isServiceId(service) || !notes || typeof notes !== "object") continue;
      const clean: Record<string, string> = {};
      for (const [keyId, note] of Object.entries(notes as Record<string, unknown>)) {
        if (typeof note !== "string" || !keyId.trim()) continue;
        const trimmed = note.trim().slice(0, KEY_MEMO_MAX_LENGTH);
        if (trimmed) clean[keyId] = trimmed;
      }
      if (Object.keys(clean).length) out[service] = clean;
    }
    return out;
  } catch {
    return {};
  }
}

/** 빈 문자열은 메모 삭제로 취급한다. */
export function setKeyMemo(
  memos: KeyMemos,
  service: ServiceId,
  keyId: string,
  note: string,
): KeyMemos {
  const nextService = { ...(memos[service] ?? {}) };
  const trimmed = note.trim().slice(0, KEY_MEMO_MAX_LENGTH);
  if (trimmed) nextService[keyId] = trimmed;
  else delete nextService[keyId];

  const next: KeyMemos = { ...memos };
  if (Object.keys(nextService).length) next[service] = nextService;
  else delete next[service];
  return next;
}

const LOCAL_EVENT = "api-usage:key-memos";

function readRaw(): string | null {
  try {
    return window.localStorage.getItem(KEY_MEMOS_STORAGE_KEY);
  } catch {
    return null;
  }
}

function write(memos: KeyMemos): void {
  try {
    window.localStorage.setItem(KEY_MEMOS_STORAGE_KEY, JSON.stringify(memos));
  } catch {
    /* 저장이 차단된 브라우저에서는 화면을 깨뜨리지 않는다. */
  }
  window.dispatchEvent(new Event(LOCAL_EVENT));
}

function subscribe(onChange: () => void): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key === KEY_MEMOS_STORAGE_KEY) onChange();
  };
  window.addEventListener("storage", onStorage);
  window.addEventListener(LOCAL_EVENT, onChange);
  return () => {
    window.removeEventListener("storage", onStorage);
    window.removeEventListener(LOCAL_EVENT, onChange);
  };
}

export function useKeyMemos(): {
  memos: KeyMemos;
  save: (service: ServiceId, keyId: string, note: string) => void;
} {
  const raw = useSyncExternalStore(subscribe, readRaw, () => null);
  const memos = useMemo(() => parseKeyMemos(raw), [raw]);

  const save = useCallback((service: ServiceId, keyId: string, note: string) => {
    write(setKeyMemo(parseKeyMemos(readRaw()), service, keyId, note));
  }, []);

  return { memos, save };
}
