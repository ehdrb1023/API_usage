"use client";

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";

import WidgetPicker from "@/components/WidgetPicker";
import { formatMetric } from "@/lib/format";
import { formatKstDate } from "@/lib/kst";
import { LIVE_RANGES, type LiveRange } from "@/lib/live-range";
import {
  findEntry,
  findService,
  lineId,
  type LiveLine,
  type LiveSnapshot,
  SERVICE_COLOR,
} from "@/lib/live-types";
import {
  parseLines,
  readLines,
  readLinesOnServer,
  readRange,
  readRangeOnServer,
  subscribeLines,
  subscribeRange,
  writeRange,
} from "@/lib/mini-storage";

/**
 * 항상 켜두는 미니 위젯.
 *
 * ── 크기 ──────────────────────────────────────────────────────────────────
 * 창을 키우면 글자도 같이 커진다. 루트에 `clamp(…vw…)` 로 기준 글자 크기를 한 번만
 * 정하고 안쪽 치수를 전부 `em` 으로 잡았기 때문이다 (app/globals.css 의 `.mini`).
 * 폭을 어디까지 줄이고 늘릴지 모르는 창이라, 픽셀 고정값을 두면 어느 한쪽에서 깨진다.
 *
 * ── 무엇을 띄울지 ─────────────────────────────────────────────────────────
 * 한 줄 = (서비스, 항목, 지표). 고르는 UI 는 대시보드와 공유한다(WidgetPicker).
 * 선택은 localStorage 에 있고 `storage` 이벤트로 창 사이를 넘나든다 — 대시보드에서
 * 체크하면 열려 있는 이 창이 그 자리에서 바뀐다.
 */

/**
 * 폴링 주기는 **서버가 정한다** (`snapshot.refreshSeconds`). 벤더 캐시 구간과 같은
 * 값이라, 클라이언트가 더 자주 물어봐야 같은 값만 다시 받는다. 첫 응답이 오기 전에만
 * 이 기본값을 쓴다.
 */
const FALLBACK_REFRESH_MS = 60_000;

export default function MiniWidget() {
  const [snapshot, setSnapshot] = useState<LiveSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [showPicker, setShowPicker] = useState(false);
  /**
   * 구간도 줄 목록과 같이 localStorage 가 원본이다. state 로 들고 마운트 뒤에
   * 읽어 오면 effect 안에서 setState 를 하게 되어 렌더가 한 번 더 돈다.
   */
  const range = useSyncExternalStore(subscribeRange, readRange, readRangeOnServer);
  const chooseRange = useCallback((next: LiveRange) => writeRange(next), []);

  const raw = useSyncExternalStore(subscribeLines, readLines, readLinesOnServer);
  const lines = useMemo(() => parseLines(raw), [raw]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/live?range=${range}`, { cache: "no-store" });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
      setSnapshot(body as LiveSnapshot);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
    // range 가 바뀌면 이 함수가 새로 만들어지고, 아래 두 effect 가 곧바로 다시 받아 온다.
  }, [range]);

  // 첫 조회. 커밋 밖으로 한 틱 미룬다 — effect 본문에서 곧바로 setState 로 이어지면
  // 렌더가 한 번 더 도는데, 어차피 네트워크를 기다릴 값이라 의미가 없다.
  useEffect(() => {
    const kick = setTimeout(() => void load(), 0);
    return () => clearTimeout(kick);
  }, [load]);

  const refreshMs = (snapshot?.refreshSeconds ?? 0) * 1000 || FALLBACK_REFRESH_MS;

  useEffect(() => {
    const refresh = () => void load();
    const timer = setInterval(refresh, refreshMs);
    // 창을 다시 보는 순간에도 한 번 — 절전에서 깨어나면 setInterval 이 밀린다.
    window.addEventListener("focus", refresh);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", refresh);
    };
  }, [load, refreshMs]);

  // 갱신이 막힌 서비스가 하나라도 있으면 머리말에 알린다. 값은 그대로 뜨는데
  // 그게 방금 값인지 20분 전 값인지 모르면 판단을 그르친다.
  const stale = snapshot?.services.some((s) => s.stale) ?? false;

  return (
    <div className="mini">
      <header className="mini-head">
        <span className="mini-clock">
          {snapshot ? (
            <>
              <strong>{snapshot.kstTime}</strong>
              <em>{formatKstDate(snapshot.kstDate)} KST</em>
            </>
          ) : (
            <em>불러오는 중…</em>
          )}
          {snapshot?.source === "mock" && <em className="mini-mock">목업</em>}
          {stale && (
            <em
              className="mini-stale"
              title={snapshot?.services.find((s) => s.stale)?.freshness}
            >
              갱신 지연
            </em>
          )}
        </span>
        <span className="mini-head-right">
          <span className={`mini-pulse${loading ? " on" : ""}`} aria-hidden />
          <button
            type="button"
            className="mini-gear"
            onClick={() => setShowPicker(true)}
            title="표시 항목 고르기"
          >
            ⚙
          </button>
        </span>
      </header>

      <nav className="mini-ranges" aria-label="조회 구간">
        {LIVE_RANGES.map((r) => (
          <button
            key={r.id}
            type="button"
            className="mini-range"
            // 서버가 되돌려 준 값이 아니라 **고른 값**을 기준으로 칠한다. 그래야
            // 느린 응답을 기다리는 동안에도 누른 버튼이 눌린 채로 보인다.
            aria-pressed={range === r.id}
            onClick={() => chooseRange(r.id)}
            title={
              snapshot?.range === r.id
                ? snapshot.services.find((s) => s.boundaryNote)?.boundaryNote
                : undefined
            }
          >
            {r.label}
          </button>
        ))}
      </nav>

      {error && <p className="mini-error">{error}</p>}

      <QuotaBars quota={snapshot?.quota} />

      <ul className="mini-rows">
        {lines.map((line, i) => (
          <Row key={`${lineId(line)}-${i}`} line={line} snapshot={snapshot} />
        ))}
        {lines.length === 0 && (
          <li className="mini-empty">⚙ 를 눌러 띄울 항목을 고르세요.</li>
        )}
      </ul>

      {showPicker && (
        <div className="mini-overlay">
          <WidgetPicker snapshot={snapshot} onClose={() => setShowPicker(false)} />
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- 구독 한도

/**
 * 구독 한도 잔량. **비용 줄과 성격이 완전히 다르다** — 아래 `Row` 들이 "돈이
 * 얼마 나갔나"(종량제 API)라면, 이쪽은 "앞으로 얼마나 더 쓸 수 있나"(정액 구독)다.
 * 두 숫자는 출처도 단위도 달라서 한데 섞으면 안 되고, 그래서 칸을 나눠 놓았다.
 *
 * 한도를 못 읽는 환경(배포본에는 자격증명이 없다)에서는 `quota` 가 아예
 * undefined 로 오고, 그때는 이 영역을 통째로 그리지 않는다 — 고장이 아니라
 * 원래 안 되는 것이라 "조회 실패" 를 띄우면 오히려 오해를 만든다.
 */
function QuotaBars({ quota }: { quota: LiveSnapshot["quota"] }) {
  if (!quota) return null;

  // 반대로 **읽을 수 있어야 하는데 실패한** 경우는 반드시 보여야 한다. 한도가
  // 조용히 사라지면 "여유 있나 보다" 로 읽히기 때문이다.
  if (quota.error) {
    return <p className="mini-quota-error" title={quota.error}>한도 조회 실패</p>;
  }

  return (
    <ul className="mini-quota">
      {quota.windows.map((w) => (
        <li key={w.key} className="mini-quota-row" data-severity={w.severity}>
          <span className="mini-quota-label">{w.label}</span>
          <span
            className="mini-quota-track"
            role="meter"
            aria-valuenow={w.usedPercent}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label={`${w.label} 한도 ${w.usedPercent}% 사용`}
          >
            <span
              className="mini-quota-fill"
              style={{ width: `${w.usedPercent}%` }}
            />
          </span>
          <span className="mini-quota-value">
            {w.remainingPercent}%
            <em>남음</em>
          </span>
          <span className="mini-quota-reset">{resetLabel(w.resetsAt)}</span>
        </li>
      ))}
      {!quota.extraUsageEnabled && (
        // 이 문구가 없으면 100% 를 "돈이 더 나간다" 로 오해한다. 실제로는 **중단**이다.
        <li className="mini-quota-note">한도 초과 시 과금 없이 중단됩니다</li>
      )}
    </ul>
  );
}

/** 리셋 시각. 오늘 안이면 시각만, 넘어가면 날짜만 — 좁은 창이라 둘 다는 못 넣는다. */
function resetLabel(iso: string | null): string {
  if (!iso) return "";
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";

  const fmt = (opts: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", ...opts }).format(at);
  const day = (d: Date) =>
    new Intl.DateTimeFormat("ko-KR", {
      timeZone: "Asia/Seoul",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(d);

  return day(at) === day(new Date())
    ? fmt({ hour: "2-digit", minute: "2-digit", hour12: false })
    : fmt({ month: "numeric", day: "numeric" });
}

// ---------------------------------------------------------------- 한 줄

function Row({
  line,
  snapshot,
}: {
  line: LiveLine;
  snapshot: LiveSnapshot | null;
}) {
  const service = findService(snapshot, line.service);
  const entry = findEntry(service, line.entryId);
  const spec = service?.metricSpecs.find((s) => s.key === line.metricKey);
  const value = entry?.metrics[line.metricKey];

  const label = entry?.label ?? line.fallbackLabel;
  const estimated = spec?.estimated === true;

  return (
    <li
      className="mini-row"
      title={[service?.boundaryNote, service?.freshness].filter(Boolean).join("\n")}
    >
      <span
        className="mini-bar"
        style={{ background: SERVICE_COLOR[line.service] }}
        aria-hidden
      />
      <span className="mini-text">
        <span className="mini-label">{label}</span>
        <span className="mini-metric">
          {spec?.label ?? line.metricKey}
          {service && service.boundary !== "KST" && (
            <em className="mini-badge">{service.boundary}</em>
          )}
        </span>
      </span>
      <span className="mini-value">
        {value === undefined || !spec ? (
          <span className="mini-na">—</span>
        ) : (
          <>
            {estimated && <em className="mini-approx">~</em>}
            {formatMetric(value, spec)}
          </>
        )}
      </span>
    </li>
  );
}
