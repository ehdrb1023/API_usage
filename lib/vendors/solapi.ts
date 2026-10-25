/**
 * 솔라피(Solapi) 실잔액 조회 — `GET https://api.solapi.com/cash/v1/balance`.
 *
 * AI 벤더(Claude·GPT)는 사용량 리포트에서 비용을 역산하지만, 솔라피는 **실시간 실잔액**을
 * API 가 바로 준다 (balance + point). 그래서 선불 어림이 아니라 확정값이다 — "수기" 가 아닌
 * "자동" 카드로 뜬다.
 *
 * 인증: HMAC-SHA256. `Authorization: HMAC-SHA256 apiKey=…, date=…, salt=…, signature=…`
 * (linktalk-error-alerts/lib/sms 의 solapiAuthHeader 와 같은 규격. 여기서는 그 레포 의존성을
 * 끌어오지 않으려고 Node crypto 로 직접 서명한다.)
 *
 * 키가 없으면 null 을 돌려주고 크래시하지 않는다 — 카드는 "미설정" 으로 뜬다.
 */

import crypto from "node:crypto";

const SOLAPI_BALANCE_URL = "https://api.solapi.com/cash/v1/balance";
const TIMEOUT_MS = 10_000;

/** `.env.example` 자리표시자를 진짜 키로 오인하지 않도록 (다른 벤더와 같은 규칙). */
const PLACEHOLDER_PATTERN = /x{8,}/i;

function hasValue(v: string | undefined): v is string {
  const t = (v ?? "").trim();
  return t !== "" && !PLACEHOLDER_PATTERN.test(t);
}

/** 솔라피 잔액을 조회할 키가 세팅됐는가. */
export function hasSolapiCredentials(): boolean {
  return hasValue(process.env.SOLAPI_API_KEY) && hasValue(process.env.SOLAPI_API_SECRET);
}

/** HMAC 서명 헤더. 키가 없으면 null. */
function solapiAuthHeader(): string | null {
  const apiKey = (process.env.SOLAPI_API_KEY ?? "").trim();
  const apiSecret = (process.env.SOLAPI_API_SECRET ?? "").trim();
  if (!apiKey || !apiSecret) return null;

  const date = new Date().toISOString();
  const salt = crypto.randomBytes(32).toString("hex");
  const signature = crypto
    .createHmac("sha256", apiSecret)
    .update(date + salt)
    .digest("hex");

  return `HMAC-SHA256 apiKey=${apiKey}, date=${date}, salt=${salt}, signature=${signature}`;
}

export type SolapiBalance =
  | { ok: true; krw: number }
  | { ok: false; reason: string };

/**
 * 실잔액(원). balance + point 를 합친다 (linktalk 쪽과 같은 집계).
 * 키가 없으면 null — 호출부는 "미설정" 카드로 처리한다.
 */
export async function fetchSolapiBalance(): Promise<SolapiBalance | null> {
  const auth = solapiAuthHeader();
  if (!auth) return null;

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(SOLAPI_BALANCE_URL, {
      headers: { Authorization: auth },
      signal: ctl.signal,
      cache: "no-store",
    });
    const json = (await res.json().catch(() => null)) as
      | { balance?: number | string; point?: number | string; errorCode?: string; errorMessage?: string }
      | null;

    if (!res.ok) {
      /* 솔라피는 틀린 키에 400 + errorCode InvalidApiKey 로 답한다 (2026-10-23 실측). */
      const code = String(json?.errorCode ?? res.status);
      return { ok: false, reason: `솔라피 응답 ${code}` };
    }

    const balance = Number(json?.balance);
    if (!Number.isFinite(balance)) return { ok: false, reason: "잔액 형식 오류" };
    const krw = balance + (Number(json?.point) || 0);
    return { ok: true, krw };
  } catch (e) {
    const reason =
      e instanceof Error && e.name === "AbortError"
        ? `응답 없음 ${TIMEOUT_MS / 1000}초`
        : "닿지 않음";
    return { ok: false, reason };
  } finally {
    clearTimeout(timer);
  }
}
