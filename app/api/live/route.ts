import { getLiveSnapshot } from "@/lib/live";
import { isLiveRange } from "@/lib/live-range";

/**
 * GET /api/live — 미니 위젯이 1분마다 폴링하는 KST 스냅샷.
 *
 * `?range=today|7d|mtd` 로 구간을 고른다 (기본 today). 구간을 바꿔도 **벤더 호출은
 * 늘지 않는다** — 지난 날짜는 하루 캐시를 더해 쓴다 (lib/live-range.ts).
 * 모르는 값이 오면 400 이 아니라 **today 로 떨어진다**. 이건 화면을 채우는 경로라,
 * 오타 하나에 위젯이 통째로 비는 것보다 기본 구간을 보여주는 편이 낫다.
 *
 * 라우트 자체는 캐시하지 않는다(`no-store`). 벤더 호출 캐시는 lib/data-source.ts 에
 * 이미 두 층으로 있다 — 오늘 사용량은 `liveBucket()` 구간 단위, 하루 시계열·단가는
 * KST 날짜 단위. 여기서 또 캐시하면 세 층이 어긋나 "새로고침해도 안 바뀌는" 상태가 된다.
 */
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const raw = new URL(request.url).searchParams.get("range");
  const range = isLiveRange(raw) ? raw : "today";

  try {
    return Response.json(await getLiveSnapshot(new Date(), range), {
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500, headers: { "cache-control": "no-store" } },
    );
  }
}
