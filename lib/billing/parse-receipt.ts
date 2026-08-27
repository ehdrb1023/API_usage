/**
 * 결제 메일 본문 → `Receipt`. **순수 함수다** — 네트워크도 파일도 타지 않는다.
 *
 * 메일을 실제로 긁어 오는 일은 Claude 루틴이 한다 (`docs/billing-receipts.md`).
 * 여기는 "받아 온 본문을 어떻게 읽느냐" 만 안다. 그래야 테스트가 가능하다.
 *
 * ── 왜 벤더가 아니라 템플릿으로 가르는가 ────────────────────────────────
 *
 * Anthropic 영수증과 Deep Infra 영수증은 **본문이 글자 단위로 같은 틀**이다.
 * 둘 다 Stripe 가 보내기 때문이다. 보낸사람만 다르다:
 *
 *   invoice+statements@mail.anthropic.com          (Anthropic 이 자기 도메인으로)
 *   invoice+statements+acct_1M7T5m…@stripe.com     (Deep Infra 는 Stripe 도메인으로)
 *
 * 그래서 벤더마다 파서를 두면 같은 코드가 계속 복제된다. 템플릿 단위로 두면
 * Stripe 쓰는 업체가 늘어도 `config/billing-sources.json` 에 규칙 한 줄만 더하면 된다.
 *
 * ⚠️ 실제 메일 4종(2026-08-27 확인)을 기준으로 썼다. 새 형식이 나오면 조용히 틀리는
 *    게 아니라 `kind: "unknown"` 으로 떨어지게 해 뒀다 — 사람이 보라는 뜻이다.
 */

import type {
  BillingConfig,
  ChargeKind,
  Receipt,
  TemplateId,
  VendorRule,
} from "./types";

/** 파서에 넘길 메일 한 통. Gmail 응답에서 필요한 것만 추린 모양이다. */
export type RawMail = {
  messageId: string;
  sender: string;
  subject: string;
  /** 수신 시각 (ISO). 본문에 결제일이 없을 때만 대체로 쓴다. */
  date: string;
  plaintextBody: string;
  attachments?: string[];
  /** 어느 메일함에서 가져왔는지. 호출부가 알려 준다. */
  mailbox: string;
};

export type ParseResult =
  | { ok: true; receipt: Receipt }
  | { ok: false; reason: string; sender: string; subject: string };

// ---------------------------------------------------------------- 규칙 맞추기

/** 보낸사람에 맞는 규칙을 찾는다. 못 찾으면 null — 결제 메일이 아니라는 뜻이다. */
export function matchRule(sender: string, config: BillingConfig): VendorRule | null {
  const addr = extractAddress(sender);
  for (const rule of config.vendorRules) {
    let re: RegExp;
    try {
      re = new RegExp(rule.senderPattern, "i");
    } catch {
      // 정규식이 깨진 규칙 하나 때문에 나머지를 못 쓰면 안 된다.
      continue;
    }
    if (re.test(addr)) return rule;
  }
  return null;
}

/** `"이름" <a@b.com>` → `a@b.com`. 이미 주소만 있으면 그대로. */
export function extractAddress(sender: string): string {
  const m = /<([^>]+)>/.exec(sender);
  return (m ? m[1] : sender).trim().toLowerCase();
}

/** 지금 이 메일함을 봐야 하는가 — 활성이고, 기간 안이면. */
export function mailboxCovers(
  config: BillingConfig,
  address: string,
  isoDate: string,
): boolean {
  const box = config.mailboxes.find(
    (m) => m.address.toLowerCase() === address.toLowerCase(),
  );
  if (!box || !box.active) return false;
  const day = isoDate.slice(0, 10);
  if (box.since && day < box.since) return false;
  if (box.until && day > box.until) return false;
  return true;
}

// ---------------------------------------------------------------- 진입점

export function parseMail(mail: RawMail, config: BillingConfig): ParseResult {
  const rule = matchRule(mail.sender, config);
  if (!rule) {
    return {
      ok: false,
      reason: "보낸사람이 어느 규칙에도 안 걸립니다 (결제 메일이 아니거나 새 벤더)",
      sender: mail.sender,
      subject: mail.subject,
    };
  }

  const parsed = TEMPLATES[rule.template](mail);
  if (!parsed) {
    return {
      ok: false,
      reason: `${rule.template} 형식으로 읽히지 않습니다 (벤더가 템플릿을 바꿨을 수 있습니다)`,
      sender: mail.sender,
      subject: mail.subject,
    };
  }

  const vendor = rule.vendor ?? parsed.vendor ?? "(미상)";
  const kind = rule.kind ?? classifyKind(parsed.lineItem, parsed.subjectHint);

  return {
    ok: true,
    receipt: {
      vendor,
      kind,
      paidOn: parsed.paidOn ?? mail.date.slice(0, 10),
      // 환불은 나간 돈이 아니라 돌아온 돈이다. 부호를 여기서 뒤집어 둬야
      // 합계가 그냥 더하기로 끝난다.
      amount: kind === "credit_note" ? -Math.abs(parsed.amount) : parsed.amount,
      currency: parsed.currency,
      receiptNumber: parsed.receiptNumber,
      invoiceNumber: parsed.invoiceNumber,
      lineItem: parsed.lineItem,
      periodStart: parsed.periodStart,
      periodEnd: parsed.periodEnd,
      cardLast4: parsed.cardLast4,
      paymentMethod: parsed.paymentMethod,
      sourceMailbox: mail.mailbox,
      sourceMessageId: mail.messageId,
      sourceSender: extractAddress(mail.sender),
      sourceSubject: mail.subject,
      attachments: mail.attachments ?? [],
    },
  };
}

// ---------------------------------------------------------------- 종류 판정

/**
 * 품목명으로 요금제/API 를 가른다. **이 대시보드의 존재 이유가 이 한 줄이다** —
 * "월 구독으로 나가는 돈" 과 "API 로 나가는 돈" 을 갈라야 비교가 된다.
 *
 * 못 가르면 `unknown` 이다. 넘겨짚어서 `api_usage` 로 떨어뜨리면 요금제 합계가
 * 조용히 작아진다 — 틀린 걸 아무도 모른다.
 */
export function classifyKind(lineItem: string | null, subject?: string): ChargeKind {
  const text = `${lineItem ?? ""} ${subject ?? ""}`.toLowerCase();
  if (!text.trim()) return "unknown";

  // 선불 충전을 구독보다 먼저 본다 — "credit" 이 양쪽에 다 나온다.
  if (/prepay|prepaid|top-?up|funded|credit balance|재충전|충전/.test(text)) {
    return "prepaid_topup";
  }
  if (/\bplan\b|subscription|max plan|pro plan|team plan|seat|구독|요금제/.test(text)) {
    return "subscription";
  }
  if (/api|usage|token|사용량/.test(text)) return "api_usage";
  return "unknown";
}

// ---------------------------------------------------------------- 템플릿별 파서

type Extracted = {
  vendor: string | null;
  paidOn: string | null;
  amount: number;
  currency: string;
  receiptNumber: string | null;
  invoiceNumber: string | null;
  lineItem: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  cardLast4: string | null;
  paymentMethod: string | null;
  subjectHint?: string;
};

const TEMPLATES: Record<TemplateId, (mail: RawMail) => Extracted | null> = {
  "stripe-receipt": parseStripeReceipt,
  "openai-notice": parseOpenAiNotice,
  "anthropic-failed": parseAnthropicFailed,
};

/**
 * Stripe 영수증 — Anthropic·Deep Infra·Meshy 등 공통.
 *
 * 실제 본문 (2026-08-16 Anthropic):
 *   Receipt from Anthropic, PBC $200.00 Paid August 16, 2026 …
 *   Receipt number 2070-4164-2450 Invoice number ITRMHVSC-0017 Payment method Link
 *   Receipt #2070-4164-2450 Aug 16–Sep 16, 2026 Max plan - 20x Qty 1 $200.00 Total $200.00
 *
 * 실제 본문 (2026-08-08 Deep Infra):
 *   Receipt from Deep Infra Inc. $5.00 Paid August 8, 2026 …
 *   Receipt number 2978-7957 Invoice number ECORE5KG-0001 Payment method - 4411
 *   Receipt #2978-7957 Prepayment Qty 1 $5.00 Total $5.00
 */
function parseStripeReceipt(mail: RawMail): Extracted | null {
  const body = normalize(mail.plaintextBody);

  const head = /Receipt from (.+?) \$([\d,]+\.\d{2}) Paid ([A-Z][a-z]+ \d{1,2}, \d{4})/.exec(body);
  if (!head) return null;

  const receiptNumber = pick(body, /Receipt number ([A-Za-z0-9-]+)/);
  const invoiceNumber = pick(body, /Invoice number ([A-Za-z0-9-]+)/);
  const paymentMethod = pick(body, /Payment method (.+?)(?: Receipt #|$)/);

  // 품목 줄: "Receipt #<번호> [기간] <품목> Qty <n> $<금액>"
  //   기간은 구독에만 있다 (Deep Infra 선불에는 없다).
  const itemLine = pick(body, /Receipt #[A-Za-z0-9-]+\s+(.+?)\s+Qty\s+\d+/);
  const period = itemLine ? parsePeriod(itemLine) : null;
  const lineItem = itemLine ? stripPeriod(itemLine).trim() || null : null;

  return {
    vendor: head[1].trim(),
    paidOn: toIsoDate(head[3]),
    amount: Number(head[2].replace(/,/g, "")),
    currency: "USD",
    receiptNumber,
    invoiceNumber,
    lineItem,
    periodStart: period?.start ?? null,
    periodEnd: period?.end ?? null,
    // "- 4411" 은 카드, "Link" 는 카드가 아니다.
    cardLast4: paymentMethod ? pick(paymentMethod, /(\d{4})\s*$/) : null,
    paymentMethod,
    subjectHint: mail.subject,
  };
}

/**
 * OpenAI 자체 알림 — 영수증 번호가 **없다.**
 *
 * 실제 본문 (2026-08-13):
 *   Hi speciai, We charged $10.00 to your credit card ending in 4411 to fund your
 *   OpenAI API credit balance.
 *
 * 번호가 없으니 `receiptKey()` 가 (벤더·날짜·금액·카드) 대체 키로 떨어진다.
 * 같은 날 같은 금액을 두 번 충전하면 한 건으로 합쳐지는 한계가 있다 — 알고 두는 것이지
 * 고칠 방법이 없다 (메일에 구분할 정보가 아예 없다).
 */
function parseOpenAiNotice(mail: RawMail): Extracted | null {
  const body = normalize(mail.plaintextBody);

  const charged = /charged \$([\d,]+\.\d{2})/i.exec(body);
  const last4 = pick(body, /card ending in (\d{4})/i);

  // 충전이 아닌 알림(구독 개시·로그인 등)은 금액이 없다. 금액이 없으면
  // 증빙이 아니므로 여기서 끊는다 — 0원짜리 영수증을 만들지 않는다.
  if (!charged) return null;

  return {
    vendor: "OpenAI",
    paidOn: mail.date.slice(0, 10),
    amount: Number(charged[1].replace(/,/g, "")),
    currency: "USD",
    receiptNumber: null,
    invoiceNumber: null,
    lineItem: /credit balance/i.test(body) ? "API credit top-up" : null,
    periodStart: null,
    periodEnd: null,
    cardLast4: last4,
    paymentMethod: last4 ? `credit card ending in ${last4}` : null,
    subjectHint: mail.subject,
  };
}

/**
 * Anthropic 결제 실패 — 금액이 **제목에만** 있다.
 *   "$500.00 payment to Anthropic, PBC was unsuccessful"
 *
 * 증빙이 아니라 경보다. `kind: "failed"` 로 고정되고 합계에서 빠진다.
 */
function parseAnthropicFailed(mail: RawMail): Extracted | null {
  const amount = /\$([\d,]+\.\d{2})/.exec(mail.subject);
  if (!amount) return null;

  return {
    vendor: "Anthropic",
    paidOn: mail.date.slice(0, 10),
    amount: Number(amount[1].replace(/,/g, "")),
    currency: "USD",
    receiptNumber: null,
    invoiceNumber: null,
    lineItem: mail.subject,
    periodStart: null,
    periodEnd: null,
    cardLast4: null,
    paymentMethod: null,
    subjectHint: mail.subject,
  };
}

// ---------------------------------------------------------------- 잔손질

/** 줄바꿈·표 문자·연속 공백을 한 칸으로. Stripe 본문은 줄바꿈 위치가 들쭉날쭉하다. */
function normalize(body: string): string {
  return body.replace(/[|\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim();
}

function pick(text: string, re: RegExp): string | null {
  const m = re.exec(text);
  return m ? m[1].trim() : null;
}

const MONTHS: Record<string, string> = {
  jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
  jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
};

/** "August 16, 2026" · "Aug 16" → ISO. 못 읽으면 null. */
function toIsoDate(text: string, fallbackYear?: string): string | null {
  const m = /([A-Za-z]{3,})\s+(\d{1,2})(?:,\s*(\d{4}))?/.exec(text);
  if (!m) return null;
  const month = MONTHS[m[1].slice(0, 3).toLowerCase()];
  const year = m[3] ?? fallbackYear;
  if (!month || !year) return null;
  return `${year}-${month}-${m[2].padStart(2, "0")}`;
}

/**
 * "Aug 16–Sep 16, 2026" → { start, end }.
 *
 * ⚠️ 시작 쪽에는 연도가 없다. 끝 쪽 연도를 빌려 쓰되, 12월→1월처럼 해를 넘기면
 *    시작이 끝보다 뒤가 되므로 그때는 시작 연도를 1 빼야 한다.
 */
function parsePeriod(text: string): { start: string; end: string } | null {
  // en dash(–)·em dash(—)·하이픈 전부 받는다.
  const m = /([A-Za-z]{3,}\s+\d{1,2})\s*[–—-]\s*([A-Za-z]{3,}\s+\d{1,2},\s*\d{4})/.exec(text);
  if (!m) return null;

  const end = toIsoDate(m[2]);
  if (!end) return null;
  const endYear = end.slice(0, 4);

  let start = toIsoDate(m[1], endYear);
  if (!start) return null;
  if (start > end) {
    start = toIsoDate(m[1], String(Number(endYear) - 1));
    if (!start) return null;
  }
  return { start, end };
}

/** 품목에서 기간 부분을 떼어낸다 — "Aug 16–Sep 16, 2026 Max plan - 20x" → "Max plan - 20x". */
function stripPeriod(text: string): string {
  return text.replace(
    /^[A-Za-z]{3,}\s+\d{1,2}\s*[–—-]\s*[A-Za-z]{3,}\s+\d{1,2},\s*\d{4}\s*/,
    "",
  );
}
