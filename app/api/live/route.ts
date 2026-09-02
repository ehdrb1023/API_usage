import { getLiveSnapshot, type LiveScope } from "@/lib/live";

/**
 * GET /api/live — 미니 위젯이 1분마다 폴링하는 "오늘"(KST) 스냅샷.
 *
 * 라우트 자체는 캐시하지 않는다(`no-store`). 벤더 호출 캐시는 lib/data-source.ts 에
 * 이미 두 층으로 있다 — 오늘 사용량은 `liveBucket()` 구간 단위, 하루 시계열·단가는
 * KST 날짜 단위. 여기서 또 캐시하면 세 층이 어긋나 "새로고침해도 안 바뀌는" 상태가 된다.
 */
export const dynamic = "force-dynamic";

/**
 * `?scope=local` 이면 **로컬 세션 로그만** 담아 돌려준다 (벤더를 안 부른다).
 *
 * 미니 창은 이 경로를 훨씬 자주 두드린다. "지금 이 세션이 얼마 쓰고 있나" 는 1분
 * 지연이면 늦은데, 벤더까지 딸려 오면 Admin API 시간당 90회를 그만큼 태우기 때문이다.
 * 로컬 파일 읽기는 쿼터가 없고 증분이라(`lib/local/scan.ts`) 비용이 거의 0 이다.
 */
export async function GET(request: Request) {
  const scope: LiveScope =
    new URL(request.url).searchParams.get("scope") === "local" ? "local" : "all";

  try {
    return Response.json(await getLiveSnapshot(new Date(), scope), {
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500, headers: { "cache-control": "no-store" } },
    );
  }
}
