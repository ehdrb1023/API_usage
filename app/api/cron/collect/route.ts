/**
 * 일 1회 수집 크론 — 각 벤더 사용액·잔액을 모아 그날 스냅샷을 Vercel Blob 에 남기고,
 * 예산·러너웨이 단계가 오르면 디스코드로 알린다.
 *
 * 편성: vercel.json 의 crons — `0 15 * * *` (UTC) = KST 자정.
 * 인증: `Authorization: Bearer $CRON_SECRET`. Vercel Cron 은 이 헤더를 자동으로 붙인다.
 *       CRON_SECRET 이 없으면(미설정) 인증을 걸 수 없으므로 거부한다 — 공개 트리거 방지.
 *
 * 아무 env(잔액·예산·웹훅·Blob 토큰)도 없어도 500 으로 죽지 않는다. 할 수 있는 만큼만 한다.
 */

import { NextResponse } from "next/server";

import { getBudgetCards } from "@/lib/budget";
import { planSweep } from "@/lib/budget-alert";
import {
  hasBlobToken,
  readAlertState,
  writeAlertState,
  writeSnapshot,
} from "@/lib/budget-snapshot";
import { hasDiscordWebhook, notifyBudget } from "@/lib/notify";
import { kstDay } from "@/lib/kst";

export const dynamic = "force-dynamic";
// 벤더 조회가 길어질 수 있어 넉넉히 둔다 (Vercel 플랜 상한 안에서).
export const maxDuration = 300;

function authorized(req: Request): boolean {
  const secret = (process.env.CRON_SECRET ?? "").trim();
  if (!secret) return false; // 비밀이 없으면 크론 자체를 막는다.
  const header = req.headers.get("authorization") ?? "";
  return header === `Bearer ${secret}`;
}

export async function GET(req: Request) {
  if (!authorized(req)) {
    const reason = (process.env.CRON_SECRET ?? "").trim()
      ? "invalid_secret"
      : "cron_secret_not_set";
    return NextResponse.json({ ok: false, reason }, { status: 401 });
  }

  const day = kstDay();
  const cards = await getBudgetCards();

  const snapshotWritten = await writeSnapshot(day, cards);

  const prev = await readAlertState();
  const plan = planSweep(cards, prev);

  let sent = 0;
  if (hasDiscordWebhook()) {
    for (const m of plan.messages) {
      const ok = await notifyBudget(m);
      if (ok) sent++;
    }
  }
  await writeAlertState(plan.nextState);

  return NextResponse.json({
    ok: true,
    day,
    cards: cards.map((c) => ({
      id: c.id,
      level: c.level,
      mode: c.mode,
      unconfigured: c.unconfigured ?? null,
    })),
    snapshotWritten,
    blobConfigured: hasBlobToken(),
    discordConfigured: hasDiscordWebhook(),
    alertsRaised: plan.raised.length,
    alertsRecovered: plan.recovered.length,
    alertsSent: sent,
  });
}
