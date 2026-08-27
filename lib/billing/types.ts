/**
 * 결제·영수증 도메인 타입.
 *
 * 대시보드의 사용량 쪽(`lib/adapters/`)과 **일부러 분리돼 있다.** 사용량은 벤더 API 에서
 * 오고 KST 로 다시 접히는 추정치지만, 이쪽은 **실제로 청구된 금액**이라 손대면 안 되는
 * 숫자다. 두 세계를 한 타입으로 묶으면 "추정 비용" 과 "청구액" 이 섞인다.
 *
 * ── 이 파일의 핵심 결정 ──────────────────────────────────────────────────
 *
 * **메일함 주소를 코드에 박지 않는다.** 결제 메일이 어느 계정으로 오는지는 바뀔 수 있고
 * 지금도 확실하지 않다. 그래서 메일함 목록과 벤더 인식 규칙을 전부
 * `config/billing-sources.json` 에서 읽는다 — 주소를 바꾸는 데 코드 수정도 재배포도
 * 필요 없다.
 */

/** 무엇으로 나간 돈인가. **요금제 vs API 를 가르는 축이라 가장 중요하다.** */
export type ChargeKind =
  /** 월 구독 (Claude Max, ChatGPT Pro …). 쓰든 안 쓰든 같은 금액이 나간다. */
  | "subscription"
  /** API 사용분 후불 청구. 쓴 만큼 나간다. */
  | "api_usage"
  /** API 크레딧 선불 충전. 나간 시점과 쓰는 시점이 다르다 — 월별 비교에서 주의. */
  | "prepaid_topup"
  /** 환불·크레딧노트. 금액이 **음수**다. */
  | "credit_note"
  /** 결제 실패. 증빙이 아니라 경보다. 합계에 넣지 않는다. */
  | "failed"
  /** 규칙으로 못 가른 것. 사람이 봐야 한다 — 조용히 버리지 않는다. */
  | "unknown";

/** 결제 메일이 오는 메일함. `config/billing-sources.json` 의 한 줄. */
export type Mailbox = {
  address: string;
  /** 끄면 수집에서 빠진다. 주소를 갈아탈 때 옛 주소는 지우지 말고 이걸 false 로. */
  active: boolean;
  /** 이 날짜 이후 메일만 본다 (ISO yyyy-mm-dd). null 이면 제한 없음. */
  since: string | null;
  /** 이 날짜까지만 본다. 주소를 갈아탄 시점을 적어 두면 중복 수집이 준다. */
  until: string | null;
  note?: string;
};

/** 보낸사람 → 벤더·템플릿. `config/billing-sources.json` 의 한 줄. */
export type VendorRule = {
  /**
   * null 이면 본문에서 읽는다 (Stripe 재판매사는 보낸사람이 전부 stripe.com 이라
   * 주소만으로는 어느 업체인지 알 수 없다).
   */
  vendor: string | null;
  /** 보낸사람 주소에 걸 정규식 (문자열로 저장하고 읽을 때 컴파일한다). */
  senderPattern: string;
  template: TemplateId;
  /** 이 규칙에 걸리면 종류를 고정한다. 없으면 품목명으로 판정한다. */
  kind?: ChargeKind;
  note?: string;
};

/** 본문 생김새. 벤더가 아니라 **템플릿**으로 가른다 — Anthropic 과 Deep Infra 는
 *  보낸사람이 다른데 본문이 완전히 같다 (둘 다 Stripe 가 보낸다). */
export type TemplateId = "stripe-receipt" | "openai-notice" | "anthropic-failed";

export type BillingConfig = {
  mailboxes: Mailbox[];
  vendorRules: VendorRule[];
};

/** 파서가 만들어 내는 한 건. Supabase `billing_receipts` 와 같은 모양이다. */
export type Receipt = {
  vendor: string;
  kind: ChargeKind;
  /** 결제일 (ISO yyyy-mm-dd). 메일 수신일이 아니라 **본문에 적힌 결제일**이다. */
  paidOn: string;
  /** USD. 환불이면 음수. */
  amount: number;
  currency: string;

  /** 벤더가 매긴 영수증 번호. 중복 판정의 1순위 키. */
  receiptNumber: string | null;
  invoiceNumber: string | null;

  /** 품목 원문. "Max plan - 20x" / "Prepayment" 등. 종류 판정의 근거라 그대로 남긴다. */
  lineItem: string | null;
  /** 구독이면 "2026-08-16 ~ 2026-09-16". 선불 충전 등에는 없다. */
  periodStart: string | null;
  periodEnd: string | null;

  /** 카드 끝 4자리. "Link" 처럼 카드가 아닌 수단이면 null 이고 method 에 남는다. */
  cardLast4: string | null;
  /** 결제 수단 원문. "Link", "- 4411", "credit card ending in 4411". */
  paymentMethod: string | null;

  /** ── 출처 ── 주소를 갈아타도 과거 이력이 "출처 불명" 이 되지 않게 남긴다. */
  sourceMailbox: string;
  sourceMessageId: string;
  sourceSender: string;
  sourceSubject: string;
  /** 증빙 PDF 파일명. 첨부 자체는 따로 내려받는다. */
  attachments: string[];
};

/**
 * 중복 판정 키. **메일함은 일부러 넣지 않는다.**
 *
 * 주소를 갈아타는 동안 같은 영수증이 두 메일함에 들어오면 두 번 잡히는데, 키에
 * 메일함이 있으면 서로 다른 건으로 보여 **매출이 두 번 계상된다.** 벤더가 매긴 번호가
 * 있으면 그걸 쓰고, 없으면 (벤더·날짜·금액·카드) 로 대체 키를 만든다.
 */
export function receiptKey(r: Receipt): string {
  if (r.receiptNumber) return `${r.vendor}:receipt:${r.receiptNumber}`;
  if (r.invoiceNumber) return `${r.vendor}:invoice:${r.invoiceNumber}`;
  return `${r.vendor}:fallback:${r.paidOn}:${r.amount}:${r.cardLast4 ?? "-"}`;
}
