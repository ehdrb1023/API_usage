import type { Metadata } from "next";

import MiniWidget from "@/components/MiniWidget";

/**
 * 항상 띄워 두는 작은 창.
 *
 * 브라우저 앱 모드(`msedge --app=…`)로 열면 주소창·탭이 없는 창이 되고,
 * 항상 위 고정은 scripts/mini/ 의 스크립트가 맡는다. 자세한 건 그쪽 README.
 *
 * 페이지 자체는 정적이다 — 숫자는 클라이언트가 /api/live 를 1분마다 폴링해서
 * 채운다. 서버 렌더로 첫 화면에 숫자를 박으면 그 순간의 값이 캐시될 뿐이라,
 * 실시간 위젯에서는 오히려 손해다.
 */
export const metadata: Metadata = {
  title: "API 사용량",
};

export default function MiniPage() {
  return <MiniWidget />;
}
