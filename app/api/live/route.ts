import { getLiveSnapshot } from "@/lib/live";

/**
 * GET /api/live — 미니 위젯이 1분마다 폴링하는 "오늘" 스냅샷.
 *
 * 라우트 자체는 캐시하지 않는다(`no-store`). 벤더 호출 캐시는 lib/data-source.ts 에
 * 이미 있고 — Claude 는 분 단위, Vercel·Supabase 는 하루 단위 — 여기서 또 캐시하면
 * 두 층이 어긋나 "새로고침해도 안 바뀌는" 상태가 생긴다.
 */
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return Response.json(await getLiveSnapshot(), {
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500, headers: { "cache-control": "no-store" } },
    );
  }
}
