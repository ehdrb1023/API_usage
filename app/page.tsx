import Dashboard from "@/components/Dashboard";
import VendorList from "@/components/VendorList";
import { loadReceipts } from "@/lib/billing/store";
import { buildVendorSpend, loadVendorCosts } from "@/lib/billing/vendor-spend";
import { getAllSeries, getDataSourceMode } from "@/lib/data-source";
import { kstDay } from "@/lib/kst";
import { loadVendors } from "@/lib/vendors";

/**
 * 페이지 자체는 매 요청 새로 그린다 — config/client-keys.json 수정이 바로 보여야 하고,
 * 렌더는 어차피 싸다. 무거운 벤더 API 호출만 lib/data-source.ts 에서 하루 단위로
 * 캐싱한다 (UTC 날짜 기준).
 */
export const dynamic = "force-dynamic";

export default async function Page() {
  const mode = getDataSourceMode();
  // 실패해도 빈 배열이라 대시보드를 막지 않는다 (lib/vendors.ts 주석 참고).
  const vendors = await loadVendors();
  // 탭에 띄울 개수 — Claude·GPT 는 자기 탭이 있으므로 뺀다.
  const vendorCount = vendors.filter((v) => v.tier !== "primary").length;

  /**
   * "그 외 API" 의 이번 달 지출. 영수증(실제 청구액) + 수기 장부를 합친다.
   * 셋 다 실패해도 빈 값으로 떨어지므로 대시보드를 막지 않는다.
   */
  const month = kstDay(new Date()).slice(0, 7);
  const [receipts, manualMonths] = await Promise.all([
    loadReceipts().catch(() => []),
    loadVendorCosts(),
  ]);
  const spend = buildVendorSpend(receipts, vendors, manualMonths, month);

  let series;
  try {
    series = await getAllSeries();
  } catch (err) {
    // DATA_SOURCE=api 인데 키가 없거나 요청이 실패한 경우.
    // 화면을 깨뜨리는 대신 원인을 그대로 보여준다.
    return (
      <main className="mx-auto max-w-2xl px-6 py-20">
        <h1 className="text-xl font-semibold">데이터를 불러오지 못했습니다</h1>
        <p className="mt-2 text-sm" style={{ color: "var(--text-secondary)" }}>
          현재 DATA_SOURCE=<code>{mode}</code> 입니다.
        </p>
        <pre
          className="card mt-6 overflow-x-auto p-4 text-xs"
          style={{ color: "var(--status-critical)" }}
        >
          {err instanceof Error ? err.message : String(err)}
        </pre>
        <p className="mt-4 text-sm" style={{ color: "var(--text-secondary)" }}>
          .env 에서 <code>DATA_SOURCE=mock</code> 으로 되돌리면 목업 데이터로 볼 수 있습니다.
        </p>
      </main>
    );
  }

  return (
    <Dashboard series={series} mode={mode} vendorCount={vendorCount}>
      <VendorList vendors={vendors} spend={spend} />
    </Dashboard>
  );
}
