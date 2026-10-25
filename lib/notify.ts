/**
 * 디스코드 알림 — 예산·러너웨이 단계 알림 전송.
 *
 * ⚠️ **금액·퍼센트·며칠 남았는지만 싣는다.** 키 값·PII·조직 식별자는 본문에 넣지 않는다
 *    (linktalk-error-alerts/lib/key-watch 의 notifyInfra 원칙 그대로).
 *
 * 웹훅 주소: DISCORD_SECURITY_WEBHOOK → 없으면 DISCORD_WEBHOOK_URL. 둘 다 없으면 조용히 건너뛴다
 * (설정 안 된 상태에서 크래시하지 않는다 — 작업 지시 제약).
 */

export type NotifyTone = "info" | "warn" | "critical" | "recovered";

export type NotifyField = { name: string; value: string };

const COLOR: Record<NotifyTone, number> = {
  info: 0x5865f2,
  warn: 0xe7a300,
  critical: 0xd03b3b,
  recovered: 0x1baf7a,
};

function webhookUrl(): string | undefined {
  const v = (process.env.DISCORD_SECURITY_WEBHOOK || process.env.DISCORD_WEBHOOK_URL || "").trim();
  return v || undefined;
}

export function hasDiscordWebhook(): boolean {
  return webhookUrl() !== undefined;
}

/**
 * 알림 한 건. 웹훅이 없으면 false 를 돌려주고 끝낸다 (크래시 금지).
 * 전송 실패도 삼킨다 — 알림이 실패했다고 크론 전체를 죽이지 않는다.
 */
export async function notifyBudget(opts: {
  title: string;
  tone: NotifyTone;
  fields: NotifyField[];
}): Promise<boolean> {
  const url = webhookUrl();
  if (!url) return false;

  const embed = {
    title: opts.title,
    color: COLOR[opts.tone],
    fields: opts.fields.slice(0, 25).map((f) => ({
      name: f.name.slice(0, 256),
      value: (f.value || "—").slice(0, 1024),
      inline: false,
    })),
    footer: { text: "api.speciai.kr · 예산·잔액 감시" },
    timestamp: new Date().toISOString(),
  };

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 10_000);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ embeds: [embed] }),
      signal: ctl.signal,
    });
    if (!res.ok) {
      console.warn("[notify] 디스코드 전송 실패", res.status);
      return false;
    }
    return true;
  } catch (e) {
    console.warn("[notify] 디스코드 전송 오류", e instanceof Error ? e.message : e);
    return false;
  } finally {
    clearTimeout(timer);
  }
}
