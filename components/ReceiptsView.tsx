"use client";

import { useMemo, useState } from "react";

import {
  KIND_LABEL,
  byMonth,
  byPayment,
  counts,
  totalsByKind,
  type Category,
  type LedgerEntry,
  type LedgerKind,
  type Money,
} from "@/lib/billing/ledger";

type Props = {
  entries: LedgerEntry[];
  /** 배포본은 Blob 에 올린 시각까지만 반영된다. 로컬 파일을 바로 읽으면 null. */
  exportedAt: string | null;
};

const MAILBOX = "speciai250331@gmail.com";

/** 카드표·월별표의 칸 순서. 실패는 칸이 아니라 건수로 따로 센다. */
const COLUMNS: LedgerKind[] = ["credit", "subscription", "usage", "one_time", "refund"];

function formatOne(currency: string, n: number): string {
  // 부호는 통화 기호 앞에 둔다: -$80.00 ($-80.00 아님)
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  if (currency === "KRW") return `${sign}₩${Math.round(abs).toLocaleString("ko-KR")}`;
  if (currency === "USD")
    return `${sign}$${abs.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  return `${sign}${abs.toLocaleString()} ${currency}`;
}

/** 통화가 여럿이면 줄을 나눠 보여 준다. 환산해 더하지 않는다. */
function MoneyCell({ money }: { money?: Money }) {
  const parts = Object.entries(money ?? {}).filter(([, n]) => Math.abs(n) > 0.0001);
  if (parts.length === 0) return <span style={{ color: "var(--text-muted)" }}>·</span>;
  return (
    <span className="flex flex-col items-end">
      {parts
        .sort(([a], [b]) => (a === "USD" ? -1 : b === "USD" ? 1 : a.localeCompare(b)))
        .map(([c, n]) => (
          <span key={c}>{formatOne(c, n)}</span>
        ))}
    </span>
  );
}

function gmailUrl(messageId: string): string {
  return `https://mail.google.com/mail/?authuser=${MAILBOX}#all/${messageId}`;
}

const KIND_COLOR: Record<LedgerKind, string> = {
  credit: "var(--series-1)",
  subscription: "var(--series-2)",
  usage: "var(--series-3)",
  one_time: "var(--series-6)",
  refund: "var(--text-muted)",
  failed: "var(--status-critical)",
};

function KindBadge({ kind }: { kind: LedgerKind }) {
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-xs">
      <span
        aria-hidden
        className="inline-block h-2 w-2 rounded-full"
        style={{ background: KIND_COLOR[kind] }}
      />
      {KIND_LABEL[kind]}
    </span>
  );
}

function Section({
  title,
  note,
  children,
}: {
  title: string;
  note?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="card p-4 sm:p-5">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 className="text-sm font-semibold">{title}</h2>
        {note && (
          <p className="text-xs" style={{ color: "var(--text-muted)" }}>
            {note}
          </p>
        )}
      </div>
      {children}
    </section>
  );
}

const th = "px-2 py-2 font-medium whitespace-nowrap";
const td = "px-2 py-2 align-top";

export default function ReceiptsView({ entries, exportedAt }: Props) {
  const [payment, setPayment] = useState<string>("all");
  const [kind, setKind] = useState<LedgerKind | "all">("all");
  const [category, setCategory] = useState<Category | "all">("all");

  const totals = useMemo(() => totalsByKind(entries), [entries]);
  const cards = useMemo(() => byPayment(entries), [entries]);
  const months = useMemo(() => byMonth(entries), [entries]);
  const review = useMemo(
    () => entries.filter((e) => e.excludeReason || e.flags.length > 0),
    [entries],
  );
  const failedCount = entries.filter((e) => e.kind === "failed").length;

  const payments = useMemo(
    () => [...new Set(entries.map((e) => e.payment))].sort(),
    [entries],
  );
  const categories = useMemo(
    () => [...new Set(entries.map((e) => e.category))].sort(),
    [entries],
  );

  const filtered = entries.filter(
    (e) =>
      (payment === "all" || e.payment === payment) &&
      (kind === "all" || e.kind === kind) &&
      (category === "all" || e.category === category),
  );

  if (entries.length === 0) {
    return (
      <main className="mx-auto max-w-2xl px-6 py-20">
        <h1 className="text-xl font-semibold">결제 내역이 없습니다</h1>
        <p className="mt-2 text-sm" style={{ color: "var(--text-secondary)" }}>
          배포본이면 아직 <code>node scripts/export_ledger.mjs</code> 로 올리지 않은 상태입니다.
          수집 절차는 <code>docs/billing-receipts.md</code> 를 보세요.
        </p>
      </main>
    );
  }

  const first = entries[entries.length - 1].date;
  const last = entries[0].date;

  return (
    <main className="mx-auto max-w-6xl px-4 pt-4 pb-8 sm:px-6 lg:px-8">
      <header className="mb-6">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">결제 내역</h1>
          <p className="text-xs" style={{ color: "var(--text-muted)" }}>
            {first} ~ {last} · {entries.length}건 · 메일함 {MAILBOX}
            {exportedAt && ` · ${exportedAt.slice(0, 16).replace("T", " ")} UTC 업로드`}
          </p>
        </div>
        <p className="mt-2 text-xs" style={{ color: "var(--text-secondary)" }}>
          결제 메일에서 모은 기록입니다. 달러와 원화는 환산하지 않고 따로 더합니다. 실패
          {` ${failedCount}`}건과 확인 필요로 뺀 건은 합계에 들어가지 않습니다.
        </p>
      </header>

      {/* 종류별 합계 */}
      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {(["credit", "subscription", "usage", "one_time"] as LedgerKind[]).map((k) => (
          <div key={k} className="card p-4">
            <KindBadge kind={k} />
            <div className="tabular mt-2 text-lg font-semibold">
              <MoneyCell money={totals[k]} />
            </div>
          </div>
        ))}
      </div>

      <div className="flex flex-col gap-6">
        <Section title="카드별 — 무엇을 어느 카드로 냈나" note="행을 누르면 아래 내역이 그 결제 수단으로 좁혀집니다">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs" style={{ color: "var(--text-secondary)" }}>
                  <th scope="col" className={th}>결제 수단</th>
                  {COLUMNS.map((k) => (
                    <th key={k} scope="col" className={`${th} text-right`}>
                      {KIND_LABEL[k]}
                    </th>
                  ))}
                  <th scope="col" className={th}>거래처</th>
                  <th scope="col" className={th}>기간</th>
                </tr>
              </thead>
              <tbody>
                {cards.map((r) => {
                  const selected = payment === r.payment;
                  return (
                    <tr
                      key={r.payment}
                      onClick={() => setPayment(selected ? "all" : r.payment)}
                      className="cursor-pointer border-t"
                      style={{
                        borderColor: "var(--border)",
                        background: selected ? "var(--hover)" : undefined,
                      }}
                    >
                      <th scope="row" className={`${td} text-left font-medium whitespace-nowrap`}>
                        {r.isCard ? `카드 ${r.payment}` : r.payment}
                        <span className="ml-1 text-xs font-normal" style={{ color: "var(--text-muted)" }}>
                          {r.count}건
                        </span>
                      </th>
                      {COLUMNS.map((k) => (
                        <td key={k} className={`${td} tabular text-right`}>
                          <MoneyCell money={r.byKind[k]} />
                        </td>
                      ))}
                      <td className={`${td} text-xs`} style={{ color: "var(--text-secondary)" }}>
                        {r.vendors.join(", ")}
                      </td>
                      <td className={`${td} tabular text-xs whitespace-nowrap`} style={{ color: "var(--text-muted)" }}>
                        {r.first.slice(2, 7)} ~ {r.last.slice(2, 7)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Section>

        <Section title="월별" note="결제일 기준 · 최신 달이 위">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs" style={{ color: "var(--text-secondary)" }}>
                  <th scope="col" className={th}>월</th>
                  {COLUMNS.map((k) => (
                    <th key={k} scope="col" className={`${th} text-right`}>
                      {KIND_LABEL[k]}
                    </th>
                  ))}
                  <th scope="col" className={`${th} text-right`}>합계</th>
                  <th scope="col" className={`${th} text-right`}>실패</th>
                </tr>
              </thead>
              <tbody>
                {months.map((m) => (
                  <tr key={m.month} className="border-t" style={{ borderColor: "var(--border)" }}>
                    <th scope="row" className={`${td} tabular text-left font-normal`}>{m.month}</th>
                    {COLUMNS.map((k) => (
                      <td key={k} className={`${td} tabular text-right`}>
                        <MoneyCell money={m.byKind[k]} />
                      </td>
                    ))}
                    <td className={`${td} tabular text-right font-medium`}>
                      <MoneyCell money={m.total} />
                    </td>
                    <td
                      className={`${td} tabular text-right`}
                      style={{ color: m.failed ? "var(--status-critical)" : "var(--text-muted)" }}
                    >
                      {m.failed ? `${m.failed}건` : "·"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>

        {review.length > 0 && (
          <Section title="확인 필요" note="합계에서 뺐거나 사람이 봐야 하는 건">
            <ul className="flex flex-col gap-2 text-sm">
              {review.map((e) => (
                <li key={e.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <span className="tabular text-xs" style={{ color: "var(--text-muted)" }}>{e.date}</span>
                  <span className="font-medium">{e.vendor}</span>
                  <span className="tabular">
                    {e.amount === null ? "금액 미기재" : formatOne(e.currency, e.amount)}
                  </span>
                  <span className="text-xs" style={{ color: "var(--text-secondary)" }}>
                    {[e.excludeReason && `합계 제외: ${e.excludeReason}`, ...e.flags]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                </li>
              ))}
            </ul>
          </Section>
        )}

        <Section title="전체 내역" note={`${filtered.length}건 · 원본 메일 링크는 ${MAILBOX} 로그인 상태에서 열립니다`}>
          <div className="mb-3 flex flex-wrap gap-2 text-sm">
            <label className="flex items-center gap-1.5">
              <span className="text-xs" style={{ color: "var(--text-secondary)" }}>결제 수단</span>
              <select
                value={payment}
                onChange={(e) => setPayment(e.target.value)}
                className="rounded-md px-2 py-1"
                style={{ background: "var(--surface-1)", border: "1px solid var(--border)" }}
              >
                <option value="all">전체</option>
                {payments.map((p) => (
                  <option key={p} value={p}>{p}</option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-1.5">
              <span className="text-xs" style={{ color: "var(--text-secondary)" }}>종류</span>
              <select
                value={kind}
                onChange={(e) => setKind(e.target.value as LedgerKind | "all")}
                className="rounded-md px-2 py-1"
                style={{ background: "var(--surface-1)", border: "1px solid var(--border)" }}
              >
                <option value="all">전체</option>
                {(Object.keys(KIND_LABEL) as LedgerKind[]).map((k) => (
                  <option key={k} value={k}>{KIND_LABEL[k]}</option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-1.5">
              <span className="text-xs" style={{ color: "var(--text-secondary)" }}>분야</span>
              <select
                value={category}
                onChange={(e) => setCategory(e.target.value as Category | "all")}
                className="rounded-md px-2 py-1"
                style={{ background: "var(--surface-1)", border: "1px solid var(--border)" }}
              >
                <option value="all">전체</option>
                {categories.map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
            </label>
          </div>

          <div className="max-h-[36rem] overflow-auto">
            <table className="w-full text-sm">
              <thead className="sticky top-0" style={{ background: "var(--surface-1)" }}>
                <tr className="text-left text-xs" style={{ color: "var(--text-secondary)" }}>
                  <th scope="col" className={th}>날짜</th>
                  <th scope="col" className={th}>거래처</th>
                  <th scope="col" className={th}>품목</th>
                  <th scope="col" className={th}>종류</th>
                  <th scope="col" className={th}>결제 수단</th>
                  <th scope="col" className={`${th} text-right`}>금액</th>
                  <th scope="col" className={th}>원본</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((e) => {
                  const dim = !counts(e);
                  return (
                    <tr
                      key={e.id}
                      className="border-t"
                      style={{ borderColor: "var(--border)", opacity: dim ? 0.6 : 1 }}
                    >
                      <td className={`${td} tabular whitespace-nowrap`}>{e.date}</td>
                      <td className={td}>
                        <div className="font-medium">{e.vendor}</div>
                        <div className="text-xs" style={{ color: "var(--text-muted)" }}>{e.category}</div>
                      </td>
                      <td className={`${td} text-xs`} style={{ color: "var(--text-secondary)" }}>
                        {e.item}
                        {e.receiptNo && (
                          <div className="tabular" style={{ color: "var(--text-muted)" }}>#{e.receiptNo}</div>
                        )}
                      </td>
                      <td className={td}><KindBadge kind={e.kind} /></td>
                      <td className={`${td} whitespace-nowrap`}>{e.payment}</td>
                      <td className={`${td} tabular text-right whitespace-nowrap`}>
                        {e.amount === null ? "—" : formatOne(e.currency, e.amount)}
                      </td>
                      <td className={`${td} text-xs whitespace-nowrap`}>
                        <a
                          href={gmailUrl(e.messageId)}
                          target="_blank"
                          rel="noreferrer"
                          style={{ color: "var(--series-1)" }}
                        >
                          메일
                        </a>
                        <span
                          className="ml-1"
                          title={e.source === "parser" ? "테스트가 붙은 파서로 읽음" : "메일을 읽고 옮김 — 원본 대조 권장"}
                          style={{ color: "var(--text-muted)" }}
                        >
                          {e.source === "parser" ? "자동" : "수동"}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Section>
      </div>
    </main>
  );
}
