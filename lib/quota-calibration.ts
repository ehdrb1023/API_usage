/**
 * 구독 한도 보정 — **"1% 가 몇 토큰인가" 를 재서 알아낸다.**
 *
 * ── 왜 재야 하나 ──────────────────────────────────────────────────────────
 * 벤더는 퍼센트만 준다. `limit_dollars`·`used_dollars`·`remaining_dollars` 가
 * 전부 null 로 온다 (`lib/quota.ts` 주석, `docs/subscription-quota.md` 1절).
 * 그래서 **"전체 − 사용 = 남음" 이라는 뺄셈이 성립하지 않는다.** 전체를 모른다.
 *
 * 대신 나눗셈을 쓴다. 두 시점을 재면
 *
 *     Δ토큰 / Δ퍼센트 = 1% 당 토큰
 *
 * 이 나오고, 여기에 남은 퍼센트를 곱하면 남은 토큰이 추정된다. 로컬 로그의
 * 토큰 합은 **빼는 값이 아니라 퍼센트를 토큰으로 번역하는 환산기**다.
 *
 * ── 한 번이 아니라 여러 번 재는 이유 ──────────────────────────────────────
 * 한 번 재면 "이 창의 평균" 이고, 두 번 재면 "지금 이 순간의 속도" 다.
 * "몇 시에 막히나" 가 정확해지는 것은 후자뿐이다. 그래서 스냅샷을 **쌓는다**.
 *
 * ── 이 모듈이 감추지 않는 것 ──────────────────────────────────────────────
 * 캐시읽기를 한도에 어떻게 반영하는지 모른다. 포함/제외에 따라 결과가 40배까지
 * 갈린다. 그래서 **두 가지를 다 계산해 나란히 내놓는다.** 하나로 접어서 그럴듯한
 * 숫자 하나를 만드는 것이 이 화면에서 제일 위험한 오작동이다.
 *
 * ── 측정을 오염시키는 것 ──────────────────────────────────────────────────
 * 1. **claude.ai 웹·데스크톱 앱.** 같은 구독 한도를 먹지만 로컬 로그에 안 남는다.
 *    Δ퍼센트에는 잡히고 Δ토큰에는 안 잡혀 1%당 토큰이 실제보다 **작게** 나온다.
 * 2. **다른 PC.** 퍼센트는 계정 단위인데 로그는 이 PC 것뿐이다. 위와 같은 방향.
 * 재는 동안은 이 PC 의 Claude Code 만 쓰는 것이 깨끗하다. 오염을 자동으로 걸러낼
 * 방법은 없다 — `suspect` 플래그로 표시만 한다.
 *
 * 서버 전용 (fs·네트워크). 클라이언트에서 import 금지.
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { getQuota, resetQuotaCache } from "@/lib/quota";
import { resetScanCache, scanLocalUsage } from "@/lib/local/scan";

// ---------------------------------------------------------------- 타입

/** 이 PC 로그에서 센 토큰. 한 구간(직전 스냅샷 ~ 이번 스냅샷)의 합이다. */
export type TokenSums = {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  calls: number;
};

export type CalibWindow = {
  key: string;
  label: string;
  usedPercent: number;
  /** 창이 리셋되는 시각. 이 값이 바뀌면 창이 갈렸다는 뜻이다. */
  resetsAt: string | null;
};

export type Snapshot = {
  /** UTC ISO. */
  at: string;
  account: AccountStamp;
  /**
   * 찍은 컴퓨터 이름.
   *
   * 계정과 별개다 — 한 계정을 여러 PC 에서 쓸 수 있고, 그때 **퍼센트는 계정 전체인데
   * 토큰은 그 PC 것뿐**이라 둘을 짝지으면 1%당 토큰이 실제보다 작게 나온다.
   * 기록해 두지 않으면 나중에 파일을 합쳤을 때 어느 PC 것인지 알 방법이 없다.
   */
  machine: string;
  windows: CalibWindow[];
  /**
   * 이 스냅샷의 `tokens` 가 **어느 시각 이후**를 센 것인가.
   * 첫 스냅샷은 null — 직전이 없어서 셀 구간이 없다.
   */
  since: string | null;
  tokens: TokenSums | null;
  /** 모델별 내역. 창이 모델별로도 걸리므로(`weekly_scoped`) 남겨 둔다. */
  byModel: Record<string, TokenSums> | null;
};

/**
 * 계정 도장.
 *
 * ⚠️ **세션 로그에는 계정 정보가 없다.** 실측(2026-09-07): 세션 파일 191개 중
 * `accountUuid` 가 들어 있는 것은 7개고 그나마 `artifact-autoreact-ledger` 라는
 * 무관한 줄이다. assistant 줄의 필드는 `sessionId`·`cwd`·`gitBranch`·`model`·
 * `requestId` 뿐이다.
 *
 * 계정 정체는 `~/.claude.json` 의 `oauthAccount` 에 **현재 로그인 것 하나만** 있고
 * 계정을 바꾸면 덮어써진다. 그래서 **과거 로그를 나중에 계정별로 가르는 것은
 * 불가능하다.** 기록하는 순간에 도장을 찍는 수밖에 없다 — 이 타입이 그 도장이다.
 */
export type AccountStamp = {
  uuid: string;
  email: string | null;
  organization: string | null;
  /** "max_20x" 등. 한도 크기가 여기 걸리므로 티어가 바뀌면 보정값도 못 쓴다. */
  tier: string | null;
};

/** 연속한 두 스냅샷에서 뽑은 한 구간. 보정의 재료다. */
export type Segment = {
  from: string;
  to: string;
  windowKey: string;
  windowLabel: string;
  deltaPercent: number;
  tokens: TokenSums;
  /** 캐시읽기 포함/제외 두 가지 환산. 어느 쪽이 맞는지 모르므로 둘 다 남긴다. */
  perPercentWithCacheRead: number;
  perPercentWithoutCacheRead: number;
  /** 이 구간을 보정에 쓰면 안 되는 사유. 비어 있어야 유효한 구간이다. */
  reject: string | null;
};

// ---------------------------------------------------------------- 계정

export function claudeConfigPath(): string {
  return (
    process.env.CLAUDE_CONFIG_PATH || path.join(os.homedir(), ".claude.json")
  );
}

/**
 * 지금 로그인된 계정. 이걸 못 읽으면 스냅샷을 **찍지 않는다** —
 * 계정을 모르는 기록은 나중에 다른 계정 것과 섞여 조용히 틀린 보정값을 만든다.
 */
export async function readAccount(): Promise<AccountStamp> {
  const raw = await fs.readFile(
    /* turbopackIgnore: true */ claudeConfigPath(),
    "utf8",
  );
  const parsed = JSON.parse(raw) as {
    oauthAccount?: Record<string, unknown>;
  };
  const account = parsed.oauthAccount;
  const uuid = account?.accountUuid;
  if (typeof uuid !== "string" || !uuid) {
    throw new Error(
      "~/.claude.json 에 oauthAccount.accountUuid 가 없습니다 — Claude Code 로그인 상태를 확인하세요",
    );
  }
  return {
    uuid,
    email: str(account?.emailAddress),
    organization: str(account?.organizationName),
    tier: str(account?.userRateLimitTier) ?? str(account?.organizationRateLimitTier),
  };
}

function str(v: unknown): string | null {
  return typeof v === "string" && v ? v : null;
}

/** 이 컴퓨터 이름. 바꾸고 싶으면 `QUOTA_MACHINE` 로 덮는다. */
export function machineName(): string {
  return process.env.QUOTA_MACHINE || os.hostname();
}

// ---------------------------------------------------------------- 저장소

/**
 * 스냅샷 저장 위치. **홈 디렉토리다 — 레포 안이 아니다.**
 *
 * 전역 CLI 로 아무 프로젝트에서나 실행하는데 `process.cwd()` 를 쓰면 실행한
 * 디렉토리마다 기록이 따로 쌓인다. 보정은 **누적**이 전부인데 그러면 영원히 안 쌓인다.
 * 계정 UUID 가 파일명에 들어가므로 레포에 두면 커밋 사고 위험도 있다.
 */
export function storeDir(): string {
  return process.env.QUOTA_STORE_DIR || path.join(os.homedir(), ".claude-quota");
}

/** 계정마다 파일 하나. **append-only JSONL** 이다. */
export function storePath(accountUuid: string): string {
  return path.join(storeDir(), `${accountUuid}.jsonl`);
}

export async function readSnapshots(accountUuid: string): Promise<Snapshot[]> {
  let raw: string;
  try {
    raw = await fs.readFile(storePath(accountUuid), "utf8");
  } catch {
    return [];
  }
  const out: Snapshot[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as Snapshot);
    } catch {
      // 쓰다 만 줄은 버린다. append-only 라 마지막 줄에만 생길 수 있다.
    }
  }
  // 파일 순서를 믿지 않는다 — 시각으로 정렬해야 Δ 가 맞는다.
  out.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  return out;
}

async function append(accountUuid: string, snapshot: Snapshot): Promise<void> {
  const file = storePath(accountUuid);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.appendFile(file, JSON.stringify(snapshot) + "\n", "utf8");
}

// ---------------------------------------------------------------- 기록

/**
 * 스냅샷 한 장 = 퍼센트(벤더) + 직전 스냅샷 이후 토큰(이 PC 로그).
 *
 * 토큰을 **창 시작부터** 세지 않고 **직전 스냅샷부터** 세는 이유: 창 시작 시각은
 * `resets_at` 에서 창 길이를 빼서 구해야 하는데, 창 길이를 우리가 안다고 가정하는
 * 순간(5h/168h) 벤더가 바꾸면 조용히 틀린다. 구간 차이만 쓰면 그 가정이 필요 없다.
 */
export async function takeSnapshot(now: Date = new Date()): Promise<Snapshot> {
  const account = await readAccount();

  // 둘 다 모듈 캐시를 들고 있다. 스크립트가 주기적으로 부르는 경로라
  // 캐시된 옛 값이 그대로 기록되면 Δ 가 0 이 되어 보정이 죽는다.
  resetQuotaCache();
  resetScanCache();

  const quota = await getQuota(now);
  if (quota.error) {
    throw new Error(`한도 조회 실패: ${quota.error}`);
  }

  const previous = (await readSnapshots(account.uuid)).at(-1) ?? null;
  // 계정이 바뀌었으면 이전 것과 이어 붙이지 않는다 (파일이 계정별이라 자동으로 갈린다).
  const since = previous?.at ?? null;

  let tokens: TokenSums | null = null;
  let byModel: Record<string, TokenSums> | null = null;
  if (since) {
    const scan = await scanLocalUsage(since);
    tokens = empty();
    byModel = {};
    for (const row of scan.rows) {
      // scanLocalUsage 는 since **이후**를 주지만 경계를 한 번 더 막는다.
      if (Date.parse(row.ts) <= Date.parse(since)) continue;
      add(tokens, row);
      byModel[row.model] ??= empty();
      add(byModel[row.model], row);
    }
  }

  const snapshot: Snapshot = {
    at: now.toISOString(),
    account,
    machine: machineName(),
    windows: quota.windows.map((w) => ({
      key: w.key,
      label: w.label,
      usedPercent: w.usedPercent,
      resetsAt: w.resetsAt,
    })),
    since,
    tokens,
    byModel,
  };

  await append(account.uuid, snapshot);
  return snapshot;
}

function empty(): TokenSums {
  return { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, calls: 0 };
}

function add(
  sums: TokenSums,
  row: {
    input: number;
    cacheRead: number;
    cacheWrite5m: number;
    cacheWrite1h: number;
    output: number;
  },
): void {
  sums.input += row.input;
  sums.cacheRead += row.cacheRead;
  sums.cacheWrite += row.cacheWrite5m + row.cacheWrite1h;
  sums.output += row.output;
  sums.calls += 1;
}

// ---------------------------------------------------------------- 보정

export function totalWithCacheRead(t: TokenSums): number {
  return t.input + t.cacheRead + t.cacheWrite + t.output;
}

export function totalWithoutCacheRead(t: TokenSums): number {
  return t.input + t.cacheWrite + t.output;
}

/**
 * 연속한 스냅샷 쌍 → 창별 구간.
 *
 * 못 쓰는 구간을 **버리지 않고 사유와 함께 남긴다.** 조용히 걸러내면 "왜 보정값이
 * 안 쌓이나" 를 사람이 알 수 없다.
 */
export function segments(snapshots: Snapshot[]): Segment[] {
  const out: Segment[] = [];

  for (let i = 1; i < snapshots.length; i += 1) {
    const previous = snapshots[i - 1];
    const current = snapshots[i];
    if (!current.tokens) continue;

    for (const window of current.windows) {
      const before = previous.windows.find((w) => w.key === window.key);
      const base: Omit<
        Segment,
        "deltaPercent" | "perPercentWithCacheRead" | "perPercentWithoutCacheRead" | "reject"
      > = {
        from: previous.at,
        to: current.at,
        windowKey: window.key,
        windowLabel: window.label,
        tokens: current.tokens,
      };

      const reject =
        previous.machine && current.machine && previous.machine !== current.machine
          ? "다른 PC 에서 찍혔다"
          : rejectReason(before, window);
      const deltaPercent = before ? window.usedPercent - before.usedPercent : 0;

      out.push({
        ...base,
        deltaPercent,
        perPercentWithCacheRead: reject
          ? 0
          : totalWithCacheRead(current.tokens) / deltaPercent,
        perPercentWithoutCacheRead: reject
          ? 0
          : totalWithoutCacheRead(current.tokens) / deltaPercent,
        reject,
      });
    }
  }

  return out;
}

/**
 * 같은 창인가.
 *
 * ⚠️ **`resets_at` 을 문자열로 비교하면 안 된다.** 벤더가 매 호출마다 새로 계산해서
 * 내려주기 때문에 마이크로초 자리가 계속 흔들린다 (실측 10초 간격 두 호출:
 * `...:59.802554+00:00` → `...:59.840651+00:00`). 그대로 비교하면 **모든 구간이
 * "리셋됨" 으로 걸러져 유효 구간이 영원히 0 이 된다** — 그런데 화면은 정상으로
 * 보인다. 조용히 아무것도 안 쌓이는 종류의 고장이다.
 *
 * 진짜 리셋은 창 길이(5시간·168시간)만큼 점프한다. 흔들림은 밀리초다.
 * 사이에 낄 값이 없으므로 넉넉히 5분으로 가른다.
 */
const RESET_DRIFT_TOLERANCE_MS = 5 * 60 * 1000;

export function sameWindow(before: CalibWindow, current: CalibWindow): boolean {
  // 둘 다 리셋 시각이 없는 창(`weekly_scoped` 실측)은 이걸로 못 가른다.
  // 퍼센트 감소 검사가 뒤에서 받는다.
  if (!before.resetsAt || !current.resetsAt) return true;
  const gap = Math.abs(Date.parse(current.resetsAt) - Date.parse(before.resetsAt));
  if (!Number.isFinite(gap)) return true;
  return gap < RESET_DRIFT_TOLERANCE_MS;
}

function rejectReason(
  before: CalibWindow | undefined,
  current: CalibWindow,
): string | null {
  if (!before) return "직전 스냅샷에 이 창이 없다";
  // 리셋을 못 잡으면 Δ퍼센트가 음수가 되고 1%당 토큰이 음수로 나온다.
  if (!sameWindow(before, current)) return "창이 리셋됐다";
  const delta = current.usedPercent - before.usedPercent;
  if (delta < 0) return "퍼센트가 줄었다 (리셋 추정)";
  // 퍼센트는 정수로 온다. 0 이면 나눗셈이 무한대고, 1 은 반올림 오차가 100% 다.
  if (delta === 0) return "퍼센트가 안 움직였다 (구간이 짧다)";
  if (delta < 2) return "Δ가 1%p — 반올림 오차가 커서 쓰지 않는다";
  return null;
}

export type Calibration = {
  windowKey: string;
  windowLabel: string;
  /** 보정에 실제로 쓴 구간 수. */
  used: number;
  /** 사유별 버린 구간 수. */
  rejected: Record<string, number>;
  /** 1%당 토큰 — 중앙값. 평균이 아니다. 이상치 한 구간이 전체를 끌면 안 된다. */
  perPercentWithCacheRead: number | null;
  perPercentWithoutCacheRead: number | null;
  /** 구간별 값의 최소~최대. 흔들림 폭을 감추지 않는다. */
  spreadWithCacheRead: [number, number] | null;
};

export function calibrate(segs: Segment[]): Calibration[] {
  const groups = new Map<string, Segment[]>();
  for (const s of segs) {
    const list = groups.get(s.windowKey) ?? [];
    list.push(s);
    groups.set(s.windowKey, list);
  }

  const out: Calibration[] = [];
  for (const [key, list] of groups) {
    const usable = list.filter((s) => !s.reject);
    const rejected: Record<string, number> = {};
    for (const s of list) {
      if (s.reject) rejected[s.reject] = (rejected[s.reject] ?? 0) + 1;
    }
    const withCache = usable.map((s) => s.perPercentWithCacheRead);
    out.push({
      windowKey: key,
      windowLabel: list[0].windowLabel,
      used: usable.length,
      rejected,
      perPercentWithCacheRead: median(withCache),
      perPercentWithoutCacheRead: median(
        usable.map((s) => s.perPercentWithoutCacheRead),
      ),
      spreadWithCacheRead: withCache.length
        ? [Math.min(...withCache), Math.max(...withCache)]
        : null,
    });
  }
  return out;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
