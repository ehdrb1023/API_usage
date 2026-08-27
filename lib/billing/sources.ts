/**
 * `config/billing-sources.json` — **결제 메일이 어디로 오는지**와 **누가 보낸 것인지**.
 *
 * 이 파일이 따로 있는 이유는 하나다: **메일함 주소가 바뀔 수 있기 때문이다.**
 * 지금은 speciai250331@gmail.com 으로 오는 걸 확인했지만, 계정을 갈아타거나 여러
 * 개를 쓰게 될 수 있다. 주소를 코드에 박으면 그때마다 코드를 고치고 다시 배포해야 한다.
 *
 * 바꾸는 법:
 *   - 메일함 추가 → `mailboxes` 에 한 줄 추가
 *   - 메일함 교체 → 새 주소를 추가하고, 옛 주소는 **지우지 말고** `active: false` +
 *     `until: "2026-09-30"`. 지우면 과거 영수증의 출처를 설명할 수 없게 된다.
 *   - 새 벤더 → `vendorRules` 에 보낸사람 패턴 한 줄. Stripe 를 쓰는 업체면
 *     이미 있는 stripe.com 규칙에 자동으로 걸린다.
 *
 * `lib/client-keys.ts` 와 같은 원칙으로 **실패해도 죽지 않는다** — 다만 이쪽은
 * 빈 설정으로 넘어가면 "결제 메일이 하나도 없다" 로 조용히 보이므로, 표시 이름과
 * 달리 **던진다.** 돈 문제에서 조용한 0 은 위험하다.
 *
 * 서버 전용 (fs 접근). 클라이언트 컴포넌트에서 import 금지.
 */

import { promises as fs } from "node:fs";
import path from "node:path";

import type { BillingConfig, Mailbox, VendorRule } from "./types";

export const BILLING_SOURCES_FILE = path.join("config", "billing-sources.json");

export class BillingConfigError extends Error {
  constructor(message: string) {
    super(`${BILLING_SOURCES_FILE}: ${message}`);
    this.name = "BillingConfigError";
  }
}

export async function loadBillingConfig(
  file = path.join(process.cwd(), BILLING_SOURCES_FILE),
): Promise<BillingConfig> {
  let text: string;
  try {
    text = await fs.readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      throw new BillingConfigError(
        "파일이 없습니다. 결제 메일을 어느 메일함에서 읽을지 여기에 적어야 합니다.",
      );
    }
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new BillingConfigError(
      `JSON 문법이 틀렸습니다 (${error instanceof Error ? error.message : error})`,
    );
  }

  return validateBillingConfig(parsed);
}

/**
 * 모양 검사. 여기서 걸러 두지 않으면 파서가 조용히 0건을 뱉는다.
 * 파일을 안 거치고도 부를 수 있게 분리해 뒀다 (테스트용).
 */
export function validateBillingConfig(raw: unknown): BillingConfig {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new BillingConfigError("최상위가 객체여야 합니다.");
  }
  const obj = raw as Record<string, unknown>;

  if (!Array.isArray(obj.mailboxes)) {
    throw new BillingConfigError("`mailboxes` 배열이 없습니다.");
  }
  if (!Array.isArray(obj.vendorRules)) {
    throw new BillingConfigError("`vendorRules` 배열이 없습니다.");
  }

  const mailboxes = obj.mailboxes.map((m, i): Mailbox => {
    const box = m as Record<string, unknown>;
    if (typeof box.address !== "string" || !box.address.includes("@")) {
      throw new BillingConfigError(`mailboxes[${i}].address 가 메일 주소가 아닙니다.`);
    }
    return {
      address: box.address,
      // 안 적었으면 켜 둔다 — 주소를 적어 놓고 안 읽히는 쪽이 더 헷갈린다.
      active: box.active === undefined ? true : Boolean(box.active),
      since: typeof box.since === "string" ? box.since : null,
      until: typeof box.until === "string" ? box.until : null,
      note: typeof box.note === "string" ? box.note : undefined,
    };
  });

  if (mailboxes.filter((m) => m.active).length === 0) {
    throw new BillingConfigError(
      "활성 메일함이 하나도 없습니다. 전부 active:false 면 영수증을 한 건도 못 읽습니다.",
    );
  }

  const vendorRules = obj.vendorRules.map((r, i): VendorRule => {
    const rule = r as Record<string, unknown>;
    if (typeof rule.senderPattern !== "string") {
      throw new BillingConfigError(`vendorRules[${i}].senderPattern 이 없습니다.`);
    }
    try {
      new RegExp(rule.senderPattern);
    } catch (error) {
      throw new BillingConfigError(
        `vendorRules[${i}].senderPattern 이 정규식으로 안 읽힙니다 ` +
          `(${error instanceof Error ? error.message : error})`,
      );
    }
    if (
      rule.template !== "stripe-receipt" &&
      rule.template !== "openai-notice" &&
      rule.template !== "anthropic-failed"
    ) {
      throw new BillingConfigError(
        `vendorRules[${i}].template 이 알 수 없는 값입니다: ${String(rule.template)}`,
      );
    }
    return {
      vendor: typeof rule.vendor === "string" ? rule.vendor : null,
      senderPattern: rule.senderPattern,
      template: rule.template,
      kind: rule.kind as VendorRule["kind"],
      note: typeof rule.note === "string" ? rule.note : undefined,
    };
  });

  return { mailboxes, vendorRules };
}

/** 지금 긁어야 할 메일함들. */
export function activeMailboxes(config: BillingConfig): Mailbox[] {
  return config.mailboxes.filter((m) => m.active);
}

/**
 * Gmail 검색어를 만든다. 규칙의 보낸사람 패턴에서 실제 주소를 뽑아 `from:` 로 잇는다.
 *
 * ⚠️ 정규식을 그대로 Gmail 에 줄 수 없어서 **도메인만** 뽑아 넓게 검색하고,
 *    정확한 판정은 받아 온 뒤 `matchRule()` 이 다시 한다. 넓게 긁고 좁게 거르는 쪽이
 *    안전하다 — 반대로 하면 놓친 걸 영영 모른다.
 */
export function gmailQuery(config: BillingConfig, sinceDays = 90): string {
  const domains = new Set<string>();
  for (const rule of config.vendorRules) {
    const m = /@([A-Za-z0-9\\.-]+)\$?$/.exec(rule.senderPattern);
    if (m) domains.add(m[1].replace(/\\/g, ""));
  }
  const from = [...domains].map((d) => `from:${d}`).join(" ");
  return `{${from}} newer_than:${sinceDays}d`;
}
