"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import { formatMetric } from "@/lib/format";
import { formatKstDate } from "@/lib/kst";
import {
  COST_METRIC_KEY,
  findEntry,
  findService,
  lineId,
  type LiveLine,
  type LiveMetricSpec,
  type LiveSnapshot,
} from "@/lib/live-types";
import type { ServiceId } from "@/lib/types";

/**
 * 항상 켜두는 미니 위젯.
 *
 * ── 무엇을 띄울지는 사용자가 고른다 ────────────────────────────────────────
 * 한 줄 = (서비스, 항목, 지표). 항목은 "전체" 뿐 아니라 모델 하나·API 키 하나도
 * 될 수 있고, 지표는 비용·총 토큰·입력 토큰·요청 수 등 서비스가 가진 무엇이든
 * 된다. 조합을 미리 열거하지 않고 스냅샷이 알려주는 목록에서 고르게 했기 때문에,
 * 새 모델이나 새 키가 생기면 코드를 안 고쳐도 선택지에 나타난다.
 *
 * 선택은 localStorage 에만 있다. 서버에 저장하지 않는 이유는 이게 **이 컴퓨터의
 * 이 창** 설정이기 때문이다 — 노트북과 데스크톱에서 다른 걸 띄우고 싶은 게 정상이다.
 */

/** 폴링 주기. Claude 쪽 벤더 캐시도 분 단위라 이보다 촘촘히 받아도 값이 안 바뀐다. */
const REFRESH_MS = 60_000;
const STORAGE_KEY = "api-usage-mini-lines-v1";

const SERVICE_COLOR: Record<ServiceId, string> = {
  claude: "var(--series-2)",
  vercel: "var(--series-1)",
  supabase: "var(--series-3)",
};

/** `snapshot` 이 아직 없을 때의 빈 목록. 매 렌더 새 배열을 만들면 useMemo 가 헛돈다. */
const NO_SERVICES: LiveSnapshot["services"] = [];

/** 처음 열었을 때. Claude 는 KST 실시간이라 두 줄, 나머지는 하루치 비용 한 줄씩. */
const DEFAULT_LINES: LiveLine[] = [
  { service: "claude", entryId: "total", metricKey: COST_METRIC_KEY, fallbackLabel: "Claude 전체" },
  { service: "claude", entryId: "total", metricKey: "totalTokens", fallbackLabel: "Claude 전체" },
  { service: "vercel", entryId: "total", metricKey: COST_METRIC_KEY, fallbackLabel: "Vercel 전체" },
  { service: "supabase", entryId: "total", metricKey: COST_METRIC_KEY, fallbackLabel: "Supabase 전체" },
];

/**
 * localStorage 를 외부 저장소로 다루기 위한 최소 구현.
 *
 * `useState` + `useEffect` 로 읽으면 (1) 첫 렌더가 기본값으로 한 번 그려졌다가
 * 저장값으로 다시 그려지고 (2) 창이 둘일 때 서로 모른다. `useSyncExternalStore`
 * 는 둘 다 없애 준다.
 */
const LINES_EVENT = "api-usage-mini-lines-changed";

/** 시크릿 모드처럼 localStorage 가 막힌 환경용 거울. 이번 세션에서만 유지된다. */
let memoryLines: string | null = null;

function subscribeLines(onChange: () => void): () => void {
  window.addEventListener(LINES_EVENT, onChange);
  window.addEventListener("storage", onChange); // 다른 미니 창에서의 변경
  return () => {
    window.removeEventListener(LINES_EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}

function readLines(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY) ?? memoryLines;
  } catch {
    return memoryLines;
  }
}

/** 서버에는 저장값이 없다 → 기본값으로 그려야 hydration 이 어긋나지 않는다. */
function readLinesOnServer(): string | null {
  return null;
}

function writeLines(json: string): void {
  memoryLines = json;
  try {
    localStorage.setItem(STORAGE_KEY, json);
  } catch {
    /* 저장은 못 해도 이번 세션은 memoryLines 로 굴러간다. */
  }
  window.dispatchEvent(new Event(LINES_EVENT));
}

function parseLines(raw: string | null): LiveLine[] {
  if (!raw) return DEFAULT_LINES;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as LiveLine[]) : DEFAULT_LINES;
  } catch {
    return DEFAULT_LINES; // 저장값이 깨졌으면 조용히 기본값으로 간다.
  }
}

export default function MiniWidget() {
  const [snapshot, setSnapshot] = useState<LiveSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [showPicker, setShowPicker] = useState(false);

  // 선택 목록은 React state 가 아니라 localStorage 를 **원본**으로 읽는다.
  // 그래야 미니 창을 두 개 띄워도 한쪽에서 바꾼 게 다른 쪽에 바로 반영되고,
  // 서버 렌더(=저장값 없음)와 첫 클라이언트 렌더가 어긋나지 않는다.
  const rawLines = useSyncExternalStore(subscribeLines, readLines, readLinesOnServer);
  const lines = useMemo(() => parseLines(rawLines), [rawLines]);
  const persist = useCallback((next: LiveLine[]) => {
    writeLines(JSON.stringify(next));
  }, []);

  const load = useCallback(async () => {
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

  useEffect(() => {
    const refresh = () => void load();
    const timer = setInterval(refresh, REFRESH_MS);
    // 창을 다시 보는 순간에도 한 번 — 절전에서 깨어나면 setInterval 이 밀린다.
    window.addEventListener("focus", refresh);
    // 첫 조회는 커밋 밖으로 한 틱 미룬다. effect 본문에서 곧바로 setState 로
    // 이어지면 렌더가 한 번 더 도는데, 어차피 네트워크를 기다릴 값이라 의미가 없다.
    const kick = setTimeout(refresh, 0);
    return () => {
      clearInterval(timer);
      clearTimeout(kick);
      window.removeEventListener("focus", refresh);
    };
  }, [load]);

  return (
    <div className="mini">
      <header className="mini-head">
        <span className="mini-clock">
          {snapshot ? `${formatKstDate(snapshot.kstDate)} ${snapshot.kstTime}` : "불러오는 중…"}
          {snapshot?.source === "mock" && <em className="mini-mock"> 목업</em>}
        </span>
        <span className="mini-head-right">
          <span className={`mini-pulse${loading ? " on" : ""}`} aria-hidden />
          <button
            type="button"
            className="mini-gear"
            onClick={() => setShowPicker((v) => !v)}
            title="표시 항목 고르기"
          >
            {showPicker ? "✕" : "⚙"}
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
        <Picker
          snapshot={snapshot}
          lines={lines}
          onChange={persist}
          onReset={() => persist(DEFAULT_LINES)}
        />
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
      title={rowTitle(service?.boundaryNote, service?.freshness)}
    >
      <span className="mini-dot" style={{ background: SERVICE_COLOR[line.service] }} />
      <span className="mini-label">
        {label}
        {entry?.hint && <em className="mini-hint"> {entry.hint}</em>}
      </span>
      <span className="mini-metric">
        {spec?.label ?? line.metricKey}
        {service && service.boundary !== "KST" && (
          <em className="mini-badge">{service.boundary}</em>
        )}
      </span>
      <span className="mini-value">
        {value === undefined || !spec ? (
          <span className="mini-na">—</span>
        ) : (
          `${estimated ? "~" : ""}${formatMetric(value, spec)}`
        )}
      </span>
    </li>
  );
}

function rowTitle(boundaryNote?: string, freshness?: string): string {
  return [boundaryNote, freshness].filter(Boolean).join("\n");
}

// ---------------------------------------------------------------- 고르기

function Picker({
  snapshot,
  lines,
  onChange,
  onReset,
}: {
  snapshot: LiveSnapshot | null;
  lines: LiveLine[];
  onChange: (next: LiveLine[]) => void;
  onReset: () => void;
}) {
  const services = snapshot?.services ?? NO_SERVICES;
  const [serviceId, setServiceId] = useState<ServiceId>("claude");
  const [entryId, setEntryId] = useState("total");
  const [metricKey, setMetricKey] = useState(COST_METRIC_KEY);

  const service = useMemo(
    () => services.find((s) => s.id === serviceId),
    [services, serviceId],
  );

  // 서비스를 바꾸면 항목·지표는 그 서비스에 있는 값으로 되돌린다.
  const prevService = useRef(serviceId);
  useEffect(() => {
    if (prevService.current === serviceId) return;
    prevService.current = serviceId;
    setEntryId("total");
    setMetricKey(COST_METRIC_KEY);
  }, [serviceId]);

  const add = () => {
    const entry = findEntry(service, entryId);
    const next: LiveLine = {
      service: serviceId,
      entryId,
      metricKey,
      fallbackLabel: entry?.label ?? entryId,
    };
    if (lines.some((l) => lineId(l) === lineId(next))) return; // 같은 줄 두 번은 무의미
    onChange([...lines, next]);
  };

  const move = (i: number, delta: number) => {
    const j = i + delta;
    if (j < 0 || j >= lines.length) return;
    const next = [...lines];
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  };

  return (
    <div className="mini-picker">
      <div className="mini-picker-row">
        <select
          value={serviceId}
          onChange={(e) => setServiceId(e.target.value as ServiceId)}
          aria-label="서비스"
        >
          {services.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </select>

        <select
          value={entryId}
          onChange={(e) => setEntryId(e.target.value)}
          aria-label="항목"
        >
          {(service?.groups ?? []).map((g) => (
            <optgroup key={g.key} label={g.label}>
              {g.entries.map((e) => (
                <option key={`${g.key}:${e.id}`} value={e.id}>
                  {e.label}
                  {e.hint ? ` ${e.hint}` : ""}
                </option>
              ))}
            </optgroup>
          ))}
        </select>

        <select
          value={metricKey}
          onChange={(e) => setMetricKey(e.target.value)}
          aria-label="지표"
        >
          {(service?.metricSpecs ?? []).map((m: LiveMetricSpec) => (
            <option key={m.key} value={m.key}>
              {m.label}
              {m.estimated ? " (추정)" : ""}
            </option>
          ))}
        </select>

        <button type="button" onClick={add} className="mini-add">
          추가
        </button>
      </div>

      <ul className="mini-picked">
        {lines.map((line, i) => (
          <li key={`${lineId(line)}-${i}`}>
            <span className="mini-picked-label">
              {findEntry(findService(snapshot, line.service), line.entryId)?.label ??
                line.fallbackLabel}
              <em>
                {" · "}
                {findService(snapshot, line.service)?.metricSpecs.find(
                  (m) => m.key === line.metricKey,
                )?.label ?? line.metricKey}
              </em>
            </span>
            <span className="mini-picked-btns">
              <button type="button" onClick={() => move(i, -1)} title="위로">↑</button>
              <button type="button" onClick={() => move(i, 1)} title="아래로">↓</button>
              <button
                type="button"
                onClick={() => onChange(lines.filter((_, j) => j !== i))}
                title="빼기"
              >
                ✕
              </button>
            </span>
          </li>
        ))}
      </ul>

      {service && (
        <p className="mini-note">
          {service.boundaryNote}
          {service.freshness && ` · ${service.freshness}`}
        </p>
      )}

      <div className="mini-picker-foot">
        <button type="button" onClick={onReset}>
          기본값으로
        </button>
        <a href="/" target="_blank" rel="noreferrer">
          전체 대시보드 ↗
        </a>
      </div>
    </div>
  );
}
