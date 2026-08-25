"use client";

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import {
  COST_METRIC_KEY,
  DEFAULT_LINES,
  lineId,
  type LiveEntry,
  type LiveLine,
  type LiveService,
  type LiveSnapshot,
} from "@/lib/live-types";
import {
  parseLines,
  readLines,
  readLinesOnServer,
  subscribeLines,
  writeLines,
} from "@/lib/mini-storage";
import type { ServiceId } from "@/lib/types";

/**
 * 미니 창에 띄울 항목 고르기.
 *
 * 한 곳에서만 쓰는 컴포넌트가 아니다 — 대시보드에서는 모달로, 미니 창에서는 창 전체를
 * 덮는 오버레이로 **같은 컴포넌트**가 뜬다. 고르는 규칙이 두 벌이 되면 반드시 어긋나기
 * 때문이다. 저장은 양쪽 다 lib/mini-storage.ts 를 거치므로, 대시보드에서 체크하는
 * 순간 열려 있는 미니 창이 바뀐다 (`storage` 이벤트).
 *
 * 목록은 "오늘 쓴 것" 이 아니라 **조회 구간에 한 번이라도 등장한 전체**다. 지금 0 인
 * 거래처를 미리 걸어 두고 언제 쓰기 시작하는지 보는 게 이 위젯의 용도라서다.
 */

type Props = {
  /** 이미 받아 둔 스냅샷이 있으면 넘긴다 (미니 창). 없으면 직접 받아온다 (대시보드). */
  snapshot?: LiveSnapshot | null;
  onClose: () => void;
};

const SERVICE_COLOR: Record<ServiceId, string> = {
  claude: "var(--series-2)",
  vercel: "var(--series-1)",
  supabase: "var(--series-3)",
};

export default function WidgetPicker({ snapshot: given, onClose }: Props) {
  const [fetched, setFetched] = useState<LiveSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const snapshot = given ?? fetched;

  // 미니 창은 스냅샷을 이미 갖고 있다. 대시보드에서 열렸을 때만, 그리고 **딱 한 번만**
  // 받아온다 — `given` 은 미니 창에서 1분마다 새 객체가 되므로 그대로 의존성에 두면
  // 창을 열어 둔 내내 분당 한 번씩 헛 요청이 나간다.
  const fetchedOnce = useRef(false);
  useEffect(() => {
    if (given || fetchedOnce.current) return;
    fetchedOnce.current = true;
    let alive = true;
    fetch("/api/live", { cache: "no-store" })
      .then(async (res) => {
        const body = await res.json();
        if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
        if (alive) setFetched(body as LiveSnapshot);
      })
      .catch((e) => alive && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
    };
  }, [given]);

  const raw = useSyncExternalStore(subscribeLines, readLines, readLinesOnServer);
  const lines = useMemo(() => parseLines(raw), [raw]);
  const chosen = useMemo(() => new Set(lines.map(lineId)), [lines]);

  const [query, setQuery] = useState("");
  const [allMetrics, setAllMetrics] = useState(false);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  const toggle = (service: ServiceId, entry: LiveEntry, metricKey: string) => {
    const next: LiveLine = {
      service,
      entryId: entry.id,
      metricKey,
      fallbackLabel: entry.label,
    };
    const id = lineId(next);
    writeLines(
      chosen.has(id) ? lines.filter((l) => lineId(l) !== id) : [...lines, next],
    );
  };

  return (
    <div className="wp">
      <header className="wp-head">
        <strong>표시 항목</strong>
        <span className="wp-count">{lines.length}줄 선택됨</span>
        <button type="button" className="wp-x" onClick={onClose} title="닫기">
          ✕
        </button>
      </header>

      <div className="wp-tools">
        <input
          className="wp-search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="모델·API 키 이름으로 찾기"
          aria-label="항목 검색"
        />
        <label className="wp-toggle">
          <input
            type="checkbox"
            checked={allMetrics}
            onChange={(e) => setAllMetrics(e.target.checked)}
          />
          지표 전체
        </label>
      </div>

      {error && <p className="wp-error">{error}</p>}
      {!snapshot && !error && <p className="wp-loading">목록을 불러오는 중…</p>}

      <div className="wp-body">
        {(snapshot?.services ?? []).map((service) => (
          <ServiceSection
            key={service.id}
            service={service}
            query={query}
            allMetrics={allMetrics}
            chosen={chosen}
            collapsed={collapsed}
            onToggleGroup={(k) =>
              setCollapsed((c) => ({ ...c, [k]: !c[k] }))
            }
            onToggle={toggle}
          />
        ))}
      </div>

      <footer className="wp-foot">
        <button type="button" onClick={() => writeLines(DEFAULT_LINES)}>
          기본값으로
        </button>
        <button
          type="button"
          onClick={() =>
            window.open(
              "/mini",
              "api-usage-mini",
              "width=320,height=240,menubar=no,toolbar=no,location=no,status=no",
            )
          }
        >
          미니 창 열기 ↗
        </button>
      </footer>
    </div>
  );
}

// ---------------------------------------------------------------- 서비스 한 덩어리

function ServiceSection({
  service,
  query,
  allMetrics,
  chosen,
  collapsed,
  onToggleGroup,
  onToggle,
}: {
  service: LiveService;
  query: string;
  allMetrics: boolean;
  chosen: Set<string>;
  collapsed: Record<string, boolean>;
  onToggleGroup: (key: string) => void;
  onToggle: (service: ServiceId, entry: LiveEntry, metricKey: string) => void;
}) {
  // 기본은 비용 + 그 서비스의 대표 지표. 나머지는 "지표 전체" 를 켜야 나온다 —
  // Vercel 은 지표가 9개라 전부 깔면 한 줄이 화면을 넘어간다.
  const specs = allMetrics
    ? service.metricSpecs
    : service.metricSpecs.filter(
        (m) => m.key === COST_METRIC_KEY || m.key === service.primaryMetric,
      );

  const q = query.trim().toLowerCase();

  return (
    <section className="wp-service">
      <h3 className="wp-service-head">
        <span className="wp-bar" style={{ background: SERVICE_COLOR[service.id] }} />
        {service.label}
        <em className="wp-boundary">{service.boundary} 기준</em>
        {service.error && <em className="wp-err-badge">조회 실패</em>}
      </h3>

      {service.error ? (
        <p className="wp-error">{service.error}</p>
      ) : (
        service.groups.map((group) => {
          const rows = group.entries.filter(
            (e) => !q || e.label.toLowerCase().includes(q) || e.id.toLowerCase().includes(q),
          );
          if (rows.length === 0) return null;

          // 검색 중에는 접힘을 무시한다 — 찾으라고 친 글자니까 보여 줘야 한다.
          const key = `${service.id}:${group.key}`;
          const isOpen = q.length > 0 || !collapsed[key];

          return (
            <div key={group.key} className="wp-group">
              <button
                type="button"
                className="wp-group-head"
                onClick={() => onToggleGroup(key)}
                aria-expanded={isOpen}
              >
                <span className="wp-caret">{isOpen ? "▾" : "▸"}</span>
                {group.label}
                <em>{rows.length}</em>
              </button>

              {isOpen && (
                <ul className="wp-rows">
                  {rows.map((entry) => (
                    <li key={entry.id} className="wp-row">
                      <span className="wp-name" title={entry.id}>
                        {entry.label}
                        {entry.hint && <em className="wp-hint"> {entry.hint}</em>}
                        {entry.badge && <em className="wp-badge">{entry.badge}</em>}
                        {entry.idle && <em className="wp-idle">오늘 0</em>}
                      </span>
                      <span className="wp-chips">
                        {specs.map((m) => {
                          const id = `${service.id}|${entry.id}|${m.key}`;
                          const on = chosen.has(id);
                          return (
                            <button
                              key={m.key}
                              type="button"
                              aria-pressed={on}
                              className={`wp-chip${on ? " on" : ""}`}
                              onClick={() => onToggle(service.id, entry, m.key)}
                            >
                              {m.label}
                              {m.estimated && <em>~</em>}
                            </button>
                          );
                        })}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          );
        })
      )}
    </section>
  );
}
