import type { Metadata } from "next";

import ReceiptsView from "@/components/ReceiptsView";
import { buildLedger } from "@/lib/billing/ledger";
import { loadLedgerSource } from "@/lib/billing/ledger-source";

export const metadata: Metadata = {
  title: "결제 내역",
};

/** 수집·업로드하면 바로 보여야 한다. */
export const dynamic = "force-dynamic";

/**
 * 결제 내역 — 카드 끝자리·거래처·금액이 그대로 뜬다.
 *
 * ⚠️ **공개 페이지다** (2026-10-02 사용자 결정, api.speciai.kr 무인증).
 *    데이터는 git 이 아니라 비공개 Blob 으로 배포본에 넘어간다 — lib/billing/ledger-source.ts.
 */
export default async function ReceiptsPage() {
  const source = await loadLedgerSource();
  return (
    <ReceiptsView entries={buildLedger(source.receipts, source.manual)} exportedAt={source.exportedAt} />
  );
}
