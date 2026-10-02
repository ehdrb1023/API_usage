/**
 * 결제 장부의 원재료를 어디서 읽나.
 *
 *   로컬       `data/billing/receipts.json` + `manual-payments.json` (수집 스크립트가 쓰는 곳)
 *   Vercel     비공개 Blob `billing/ledger-source.json` (scripts/export_ledger.mjs 가 올린다)
 *
 * ── 왜 Blob 인가 ─────────────────────────────────────────────────────────
 * GitHub 저장소가 **공개**다. `data/` 를 커밋하면 결제 기록이 git 기록에 영구히
 * 남는다 (그래서 .gitignore 로 막아 두었다). 배포본은 git 에서 빌드되므로 따로
 * 넘겨야 하고, 그 통로가 비공개 Blob 저장소 `api-usage-billing` 이다 (2026-10-02 생성).
 *
 * ⚠️ 페이지 자체는 **공개**다 (2026-10-02 사용자 결정). Blob 은 git 에 안 남기기
 *    위한 것이지 화면을 가리기 위한 것이 아니다.
 */

import { get } from "@vercel/blob";

import type { ManualPayment } from "./ledger";
import { loadManualPayments, loadReceipts } from "./store";
import type { Receipt } from "./types";

export const BLOB_PATH = "billing/ledger-source.json";

export type LedgerSource = {
  receipts: Receipt[];
  manual: ManualPayment[];
  /** 언제 내보낸 자료인가. 로컬 파일을 바로 읽을 때는 null. */
  exportedAt: string | null;
  origin: "local" | "blob";
};

/** Vercel 에서 Blob 저장소가 연결돼 있으면 Blob, 아니면 로컬 파일. */
export async function loadLedgerSource(): Promise<LedgerSource> {
  const onVercel = Boolean(process.env.VERCEL);
  const hasBlob = Boolean(process.env.BLOB_STORE_ID || process.env.BLOB_READ_WRITE_TOKEN);

  if (onVercel && hasBlob) {
    // 새로 올리면 바로 보여야 하므로 CDN 캐시를 건너뛴다. 하루 몇 번 읽는 페이지라 비용은 무시할 만하다.
    const res = await get(BLOB_PATH, { access: "private", useCache: false });
    // 아직 한 번도 안 올린 상태. 0 건을 지어내지 않고 빈 장부로 보여 준다 (화면이 안내문을 띄운다).
    if (!res || res.statusCode !== 200) {
      return { receipts: [], manual: [], exportedAt: null, origin: "blob" };
    }
    const body = JSON.parse(await new Response(res.stream).text()) as Omit<LedgerSource, "origin">;
    return { ...body, origin: "blob" };
  }

  const [receipts, manual] = await Promise.all([loadReceipts(), loadManualPayments()]);
  return { receipts, manual, exportedAt: null, origin: "local" };
}
