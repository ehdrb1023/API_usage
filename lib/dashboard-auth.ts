/**
 * 대시보드 접근 판정. **프레임워크를 모른다** — 순수 함수뿐이다.
 *
 * 실제로 요청을 가로채는 곳은 루트의 `proxy.ts` 다. 판정을 여기로 뺀 이유는 둘이다.
 *   1. `next/server` 를 안 끌고 와야 `node --test` 로 테스트할 수 있다
 *   2. 이 프로젝트의 `lib/` 은 원래 "프레임워크 모르는 순수 로직" 자리다
 *
 * ── 왜 앱에서 막는가 ──────────────────────────────────────────────────────
 *
 * 화면에 조직 전체 AI 지출액과 **거래처별 API 키 이름**이 그대로 뜬다
 * (`lawsync`, `devcowork`, `legalmask`, `yulam` … 실제 고객사 이름이다).
 *
 * Vercel Deployment Protection 으로 막으려 했는데 요금제에서 거부됐다
 * (2026-08-27 실측):
 *
 *   ssoProtection.deploymentType = "all"    → HTTP 428
 *     "Vercel Authentication is not available on your plan for production deployments"
 *   ssoProtection.deploymentType = "prod_deployment_urls_and_all_previews" → 200
 *
 * 즉 현재 요금제에서는 `*.vercel.app` URL 과 프리뷰까지만 막히고
 * **커스텀 도메인(api.speciai.kr)은 못 막는다.** 그래서 앱에서 막는다.
 */

/** 판정 결과. 응답 만들기는 `proxy.ts` 가 한다. */
export type AuthVerdict =
  | { allow: true }
  | { allow: false; status: 401; message: string }
  | { allow: false; status: 503; message: string };

/**
 * 길이가 달라도 같은 시간이 걸리게 비교한다. 한 글자씩 맞춰 보며 응답 시간 차이로
 * 비밀번호를 알아내는 공격을 막는다.
 *
 * `crypto.timingSafeEqual` 을 안 쓰는 이유: 런타임에 따라 없을 수 있고, 길이가 다르면
 * 예외를 던져서 **길이 자체가 새어 나간다.**
 */
export function safeEqual(a: string, b: string): boolean {
  const len = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

/** base64 디코드. 런타임에 `atob` 이 없을 때를 대비해 Buffer 로 떨어진다. */
function decodeBase64(value: string): string | null {
  try {
    if (typeof atob === "function") return atob(value);
    return Buffer.from(value, "base64").toString("utf8");
  } catch {
    return null;
  }
}

export function authorize(input: {
  authorization: string | null;
  password: string | undefined;
  /**
   * 비밀번호가 없을 때 어떻게 할지를 가른다. **환경에 따라 반대로 움직인다.**
   *
   *   개발: 통과시킨다. 로컬에서 매번 비밀번호를 치게 하면 아무도 안 쓴다.
   *   운영: **막는다.** 여기서 통과시키면 설정을 깜빡한 순간 조용히 전면 공개된다.
   *         화면이 안 뜨는 건 금방 알아채지만, 공개된 건 아무도 모른다.
   */
  production: boolean;
}): AuthVerdict {
  const expected = (input.password ?? "").trim();

  if (!expected) {
    if (!input.production) return { allow: true };
    return {
      allow: false,
      status: 503,
      message:
        "DASHBOARD_PASSWORD 가 설정되지 않아 잠겨 있습니다.\n" +
        "Vercel → Settings → Environment Variables 에 추가한 뒤 다시 배포하세요.",
    };
  }

  const header = input.authorization ?? "";
  if (!header.toLowerCase().startsWith("basic ")) {
    return { allow: false, status: 401, message: "인증이 필요합니다." };
  }

  const decoded = decodeBase64(header.slice(6).trim());
  if (decoded === null) {
    return { allow: false, status: 401, message: "인증 정보를 읽을 수 없습니다." };
  }

  // "사용자:비밀번호". 비밀번호에 콜론이 들어갈 수 있으므로 **첫 콜론에서만** 자른다.
  // 여기서 잘못 자르면 "pa:ss:word" 가 "pa" 로 줄어 훨씬 짧은 값으로 통과된다.
  const colon = decoded.indexOf(":");
  const password = colon === -1 ? "" : decoded.slice(colon + 1);

  // 사용자명은 보지 않는다. 아무거나 넣어도 되고, 비밀번호 하나만 맞으면 된다.
  if (!safeEqual(password, expected)) {
    return { allow: false, status: 401, message: "비밀번호가 틀렸습니다." };
  }

  return { allow: true };
}
