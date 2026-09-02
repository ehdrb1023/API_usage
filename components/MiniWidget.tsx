"use client";

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";

import WidgetPicker from "@/components/WidgetPicker";
import { formatMetric } from "@/lib/format";
import { formatKstDate } from "@/lib/kst";
import {
  findEntry,
  findService,
  lineId,
  type LiveLine,
  type LiveSnapshot,
} from "@/lib/live-types";
import {
  parseLines,
  readLines,
  readLinesOnServer,
  subscribeLines,
} from "@/lib/mini-storage";
import type { ServiceId } from "@/lib/types";

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

/**
 * 로컬 세션 로그(`cc`)만 따로 받아 오는 주기의 기본값. 서버가 `localRefreshSeconds`
 * 로 알려 주면 그 값을 따른다. 벤더보다 훨씬 짧은 이유는 쿼터가 없기 때문이다 —
 * 자세한 배경은 app/api/live/route.ts 주석 참고.
 */
const FALLBACK_LOCAL_REFRESH_MS = 10_000;

/**
 * 방금 받은 로컬 서비스만 갈아 끼운다. 벤더 줄은 손대지 않는다 —
 * 이 응답에는 벤더가 아예 담겨 있지 않으므로 통째로 바꾸면 벤더 줄이 사라진다.
 *
 * 시계(kstTime)는 이쪽으로도 갱신한다. 로컬 폴링이 더 잦으니 머리말이 그만큼
 * 자주 움직이고, "화면이 살아 있다" 는 신호가 된다.
 */
function mergeLocal(prev: LiveSnapshot, fresh: LiveSnapshot): LiveSnapshot {
  return {
    ...prev,
    updatedAt: fresh.updatedAt,
    kstDate: fresh.kstDate,
    kstTime: fresh.kstTime,
    services: [
      ...prev.services.filter((s) => s.id !== "cc"),
      ...fresh.services.filter((s) => s.id === "cc"),
    ],
  };
}

const SERVICE_COLOR: Record<ServiceId, string> = {
  claude: "var(--series-2)",
  gpt: "var(--series-1)",
  cc: "var(--series-3)",
};

export default function MiniWidget() {
  const [snapshot, setSnapshot] = useState<LiveSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [showPicker, setShowPicker] = useState(false);

  const raw = useSyncExternalStore(subscribeLines, readLines, readLinesOnServer);
  const lines = useMemo(() => parseLines(raw), [raw]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/live", { cache: "no-store" });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
      setSnapshot(body as LiveSnapshot);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

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

  /**
   * 로컬 세션만 자주 다시 읽는다. **띄우기로 고른 줄에 로컬이 있을 때만** 돈다 —
   * 벤더 줄만 걸어 뒀다면 이 폴링은 아무것도 바꾸지 않으므로 낭비다.
   *
   * `loading` 을 건드리지 않는 것도 의도적이다. 10초마다 깜빡이면 눈에 거슬리고,
   * 실제로 기다리는 시간도 아니다 (로컬 파일 증분 읽기).
   */
  const wantsLocal = useMemo(() => lines.some((l) => l.service === "cc"), [lines]);

  const loadLocal = useCallback(async () => {
    try {
      const res = await fetch("/api/live?scope=local", { cache: "no-store" });
      const body = await res.json();
      if (!res.ok) return;
      const fresh = body as LiveSnapshot;
      setSnapshot((prev) => (prev ? mergeLocal(prev, fresh) : fresh));
    } catch {
      // 다음 주기에 다시 시도한다. 전체 폴링이 살아 있으므로 에러 문구까지 띄우지 않는다.
    }
  }, []);

  const localMs =
    (snapshot?.localRefreshSeconds ?? 0) * 1000 || FALLBACK_LOCAL_REFRESH_MS;

  useEffect(() => {
    if (!wantsLocal) return;
    const timer = setInterval(() => void loadLocal(), localMs);
    return () => clearInterval(timer);
  }, [wantsLocal, loadLocal, localMs]);

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

      {error && <p className="mini-error">{error}</p>}

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
