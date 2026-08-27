/**
 * 영수증·카드 저장소 — **JSON 파일**.
 *
 * ── 왜 DB 가 아닌가 ───────────────────────────────────────────────────────
 * 양이 아주 작다. 영수증이 월 5~10건이라 1년에 100건 남짓이고, 카드는 지금 1장,
 * 요금제는 두어 개다. 이 프로젝트는 원래 DB 가 없고(`lib/` 전부 API 조회 전용)
 * DB 를 들이면 마이그레이션 관리와 "어느 프로젝트에 두나" 가 따라온다.
 * 여럿이 쓰게 되면 그때 옮긴다 — 파서가 저장소를 모르게 짜여 있어 옮기기 쉽다.
 *
 * ⚠️ `data/` 는 `.gitignore` 대상이다. **실제 결제 내역이라 커밋하면 안 된다.**
 *
 * 서버 전용 (fs 접근). 클라이언트 컴포넌트에서 import 금지.
 */

import { promises as fs } from "node:fs";
import path from "node:path";

import { receiptKey, type ChargeKind, type Receipt } from "./types";

export const DATA_DIR = path.join("data", "billing");

const FILES = {
  receipts: "receipts.json",
  cards: "cards.json",
  unparsed: "unparsed.json",
  subscriptions: "subscriptions.json",
} as const;

/** 영수증의 끝 4자리를 사람이 아는 이름으로 잇는다. */
export type Card = {
  last4: string;
  label: string;
  holder?: string;
  issuer?: string;
  corporate?: boolean;
  note?: string;
};

/** 못 읽은 메일. **버리지 않는다** — 여기가 곧 "새 벤더 발견 목록" 이다. */
export type UnparsedMail = {
  messageId: string;
  mailbox: string;
  sender: string;
  subject: string;
  date: string;
  reason: string;
};

/** 지금 붙어 있는 월 구독. 아직 청구 안 된 것도 알아야 해서 영수증과 따로 둔다. */
export type Subscription = {
  vendor: string;
  plan: string;
  monthlyAmount: number;
  currency: string;
  startedOn: string;
  endedOn?: string | null;
  cardLast4?: string | null;
  note?: string;
};

// ---------------------------------------------------------------- 읽기/쓰기

function file(root: string, name: string): string {
  return path.join(root, DATA_DIR, name);
}

/** 파일이 없으면 **빈 배열**이다. 아직 한 번도 안 모은 정상 상태다. */
async function readJson<T>(p: string): Promise<T[]> {
  let text: string;
  try {
    text = await fs.readFile(p, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return [];
    throw error;
  }
  const parsed = JSON.parse(text);
  if (!Array.isArray(parsed)) {
    throw new Error(`${p}: 배열이어야 하는데 ${typeof parsed} 입니다.`);
  }
  return parsed as T[];
}

async function writeJson(p: string, rows: unknown[]): Promise<void> {
  await fs.mkdir(path.dirname(p), { recursive: true });
  // 사람이 열어 볼 파일이고 git diff 를 볼 수도 있으니 들여쓰기를 넣는다.
  await fs.writeFile(p, JSON.stringify(rows, null, 2) + "\n", "utf8");
}

export const loadReceipts = (root = process.cwd()) =>
  readJson<Receipt>(file(root, FILES.receipts));
export const loadCards = (root = process.cwd()) => readJson<Card>(file(root, FILES.cards));
export const loadUnparsed = (root = process.cwd()) =>
  readJson<UnparsedMail>(file(root, FILES.unparsed));
export const loadSubscriptions = (root = process.cwd()) =>
  readJson<Subscription>(file(root, FILES.subscriptions));

export const saveCards = (rows: Card[], root = process.cwd()) =>
  writeJson(file(root, FILES.cards), rows);
export const saveSubscriptions = (rows: Subscription[], root = process.cwd()) =>
  writeJson(file(root, FILES.subscriptions), rows);

// ---------------------------------------------------------------- 병합

export type MergeResult = {
  added: number;
  skipped: number;
  total: number;
  /** 새로 등장한 카드 끝 4자리. **자동으로 만들지 않는다** — 이름은 추측 못 한다. */
  newCards: string[];
  /** 규칙이 못 가른 건. 사람이 봐야 한다. */
  unknownKinds: Receipt[];
};

/**
 * 영수증을 합친다. **같은 건은 건너뛴다.**
 *
 * ⚠️ 중복 판정은 `receiptKey()` 가 하고 **메일함을 보지 않는다.** 메일함을
 *    갈아타는 동안 같은 영수증이 두 주소로 들어와도 한 건이어야 하기 때문이다.
 *    (`lib/billing/types.ts` 참고)
 */
export async function mergeReceipts(
  incoming: Receipt[],
  root = process.cwd(),
): Promise<MergeResult> {
  const existing = await loadReceipts(root);
  const seen = new Set(existing.map(receiptKey));
  const cards = await loadCards(root);
  const knownCards = new Set(cards.map((c) => c.last4));

  const merged = [...existing];
  const newCards = new Set<string>();
  let added = 0;
  let skipped = 0;

  for (const r of incoming) {
    if (seen.has(receiptKey(r))) {
      skipped++;
      continue;
    }
    seen.add(receiptKey(r));
    merged.push(r);
    added++;
    if (r.cardLast4 && !knownCards.has(r.cardLast4)) newCards.add(r.cardLast4);
  }

  // 결제일 순으로 정렬해 둬야 파일을 사람이 읽을 수 있다.
  merged.sort((a, b) => a.paidOn.localeCompare(b.paidOn) || a.vendor.localeCompare(b.vendor));
  await writeJson(file(root, FILES.receipts), merged);

  return {
    added,
    skipped,
    total: merged.length,
    newCards: [...newCards],
    unknownKinds: merged.filter((r) => r.kind === "unknown"),
  };
}

/** 못 읽은 메일을 쌓는다. 같은 메시지는 한 번만. */
export async function mergeUnparsed(
  incoming: UnparsedMail[],
  root = process.cwd(),
): Promise<number> {
  const existing = await loadUnparsed(root);
  const seen = new Set(existing.map((m) => m.messageId));
  const merged = [...existing];
  let added = 0;
  for (const m of incoming) {
    if (seen.has(m.messageId)) continue;
    seen.add(m.messageId);
    merged.push(m);
    added++;
  }
  await writeJson(file(root, FILES.unparsed), merged);
  return added;
}

// ---------------------------------------------------------------- 월별 집계

export type MonthlyRow = {
  month: string;
  vendor: string;
  /** 요금제. **쓰든 안 쓰든 나간 돈.** */
  subscription: number;
  /** API 후불. 쓴 만큼. */
  apiUsage: number;
  /**
   * API 선불 충전.
   * ⚠️ **apiUsage 와 더하지 말 것.** 나간 시점과 쓰는 시점이 달라서, $10 을 충전해
   *    석 달에 걸쳐 쓰면 충전한 달에 $10 이 통째로 잡힌다. 현금흐름으로는 맞지만
   *    "이 달에 API 를 얼마나 썼나" 의 답은 아니다.
   */
  prepaidTopup: number;
  /** 환불 (음수). */
  creditNote: number;
  /** 위 넷의 합. `failed`·`unknown` 은 뺀다. */
  total: number;
  failedCount: number;
  unknownCount: number;
};

const ZERO = (month: string, vendor: string): MonthlyRow => ({
  month,
  vendor,
  subscription: 0,
  apiUsage: 0,
  prepaidTopup: 0,
  creditNote: 0,
  total: 0,
  failedCount: 0,
  unknownCount: 0,
});

const BUCKET: Partial<Record<ChargeKind, keyof MonthlyRow>> = {
  subscription: "subscription",
  api_usage: "apiUsage",
  prepaid_topup: "prepaidTopup",
  credit_note: "creditNote",
};

/** 월 × 벤더로 접는다. 순수 함수라 테스트가 붙어 있다. */
export function monthlySummary(receipts: Receipt[]): MonthlyRow[] {
  const byKey = new Map<string, MonthlyRow>();

  for (const r of receipts) {
    const month = r.paidOn.slice(0, 7); // yyyy-mm
    const key = `${month}\t${r.vendor}`;
    let row = byKey.get(key);
    if (!row) {
      row = ZERO(month, r.vendor);
      byKey.set(key, row);
    }

    if (r.kind === "failed") {
      row.failedCount++;
      continue; // 나간 돈이 아니다. 합계에 넣지 않는다.
    }
    if (r.kind === "unknown") {
      row.unknownCount++;
      continue; // 어디에 넣을지 모른다. 넘겨짚으면 조용히 틀린다.
    }

    const bucket = BUCKET[r.kind];
    if (!bucket) continue;
    (row[bucket] as number) += r.amount;
    row.total += r.amount;
  }

  return [...byKey.values()].sort(
    (a, b) => b.month.localeCompare(a.month) || a.vendor.localeCompare(b.vendor),
  );
}

/** 카드별 합계. "어떤 카드로 얼마 나갔나". */
export function byCard(
  receipts: Receipt[],
  cards: Card[],
): { last4: string; label: string; total: number; count: number }[] {
  const names = new Map(cards.map((c) => [c.last4, c.label]));
  const out = new Map<string, { last4: string; label: string; total: number; count: number }>();

  for (const r of receipts) {
    if (r.kind === "failed" || r.kind === "unknown") continue;
    // 카드가 아닌 수단(Link 등)은 결제 수단 원문으로 묶는다.
    const last4 = r.cardLast4 ?? `(${r.paymentMethod ?? "미상"})`;
    let row = out.get(last4);
    if (!row) {
      row = { last4, label: names.get(last4) ?? last4, total: 0, count: 0 };
      out.set(last4, row);
    }
    row.total += r.amount;
    row.count++;
  }

  return [...out.values()].sort((a, b) => b.total - a.total);
}
