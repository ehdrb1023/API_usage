/**
 * 접근 잠금 — 이 대시보드는 **공개되면 안 된다.**
 *
 * 판정은 `lib/dashboard-auth.ts` 가 한다 (순수 함수라 테스트가 붙어 있다).
 * 이 파일은 요청을 가로채 그 판정을 HTTP 응답으로 옮기는 일만 한다.
 * **왜 Vercel 설정이 아니라 앱에서 막는지**도 그 파일 머리말에 적혀 있다.
 *
 * ── 왜 middleware.ts 가 아닌가 ────────────────────────────────────────────
 *
 * Next.js 16 에서 `middleware` 는 **폐기되고 `proxy` 로 이름이 바뀌었다.**
 * 기능은 같고 파일명·export 이름만 다르다.
 * (`node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/middleware.md`)
 *
 * ── 잠그는 방식 ───────────────────────────────────────────────────────────
 *
 * HTTP Basic 인증. 로그인 페이지·세션·쿠키 서명이 전부 필요 없고 브라우저가
 * 자격증명을 기억해 준다. 내부용 한 화면짜리 대시보드에는 이게 가장 적은 코드다.
 * 사람이 여럿 되고 누가 봤는지 남겨야 하면 그때 제대로 된 인증으로 바꾼다.
 */

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

import { authorize } from "@/lib/dashboard-auth";

const REALM = "API usage dashboard";

function isProduction(): boolean {
  return process.env.VERCEL_ENV === "production" || process.env.NODE_ENV === "production";
}

export function proxy(request: NextRequest) {
  const verdict = authorize({
    authorization: request.headers.get("authorization"),
    password: process.env.DASHBOARD_PASSWORD,
    production: isProduction(),
  });

  if (verdict.allow) return NextResponse.next();

  if (verdict.status === 401) {
    return new NextResponse(verdict.message, {
      status: 401,
      headers: {
        // 이게 있어야 브라우저가 비밀번호 창을 띄운다.
        "www-authenticate": `Basic realm="${REALM}", charset="UTF-8"`,
        "content-type": "text/plain; charset=utf-8",
        // 잠긴 화면이 어딘가에 캐시되면 안 된다.
        "cache-control": "no-store",
      },
    });
  }

  return new NextResponse(verdict.message, {
    status: 503,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}

/**
 * **모든 경로를 잠근다.** `/api/live` 도 포함이다 — 화면을 막아 놓고 API 를 열어 두면
 * 같은 데이터가 그대로 새어 나간다.
 *
 * 빼는 것은 비밀이 아닌 정적 자산뿐이다. 이걸 잠그면 401 화면 자체가 깨진다.
 */
export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
