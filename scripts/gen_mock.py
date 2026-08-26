#!/usr/bin/env python3
"""mock/ 목업 데이터 생성기 (결정적 — 시드 고정이라 매번 같은 결과).

이 대시보드는 **AI API 비용만** 다룬다 (2026-08-26 확정). Vercel·Supabase 생성부는
같은 날 걷어냈다.

필드명은 임의로 지어낸 게 아니라, docs/api-response-notes.md 에 정리한 실제 문서
스키마를 따른다. 그래야 목업 → 실제 API 교체 시 어댑터를 안 고쳐도 된다.

  anthropic-usage.json  usage_report / cost_report / api_keys   (2026-08-14 실키 검증됨)
  openai-usage.json     usage / costs / projects                (⚠️ 문서 기준, 미검증)

기간: 2026-07-01 ~ 2026-08-14 (45일)
  - "최근 7일"  : 08-08 ~ 08-14
  - "최근 30일" : 07-16 ~ 08-14
  - "이번 달"   : 08-01 ~ 08-14
  - "전월 동기" : 07-01 ~ 07-14   ← 전월 대비 증감률 계산에 필요해서 30일보다 길게 생성

⚠️ 목업 버킷은 UTC 하루 그대로다. 화면의 하루는 KST 지만, 목업은 배치를 보기 위한
   것이라 1시간 버킷까지 만들지 않는다. 실 API 경로에서만 KST 재구성이 일어난다
   (lib/kst-days.ts).
"""
import json
import os
import random
from datetime import date, datetime, timedelta, timezone

SEED = 20260814
START = date(2026, 7, 1)
END = date(2026, 8, 14)

HERE = os.path.dirname(os.path.abspath(__file__))
MOCK_DIR = os.path.join(os.path.dirname(HERE), "mock")

# 전일 대비 +20% 이상 튀는 날 (빨간 강조 표시 확인용)
SPIKE_DAYS = {date(2026, 7, 9), date(2026, 7, 23), date(2026, 8, 5), date(2026, 8, 12)}

NOTE = (
    "목업 데이터입니다. 실제 API 연동 시 필드명 확인 필요 — "
    "구조는 공식 문서 스키마를 따랐으나 실제 응답으로 검증되지 않았습니다."
)

# ---------------------------------------------------------------- Anthropic

# 목업 단가 (USD / 100만 토큰). 실제 요금이 아니라 그럴듯한 값.
ANTHROPIC_RATES = {
    "claude-opus-5":    {"input": 15.0, "output": 75.0, "weight": 0.22},
    "claude-sonnet-5":  {"input": 3.0,  "output": 15.0, "weight": 0.50},
    "claude-haiku-4-5": {"input": 1.0,  "output": 5.0,  "weight": 0.28},
}
CACHE_READ_MULT = 0.1    # 캐시 읽기는 입력가의 10%
CACHE_WRITE_MULT = 1.25  # 5분 캐시 생성은 입력가의 125%

# (api_key_id, 표시 이름, 상태, 사용 비중)
# 예전 목업은 api_key_id 가 전부 null 이라 "서비스별" 표가 (콘솔 직접 사용) 한 줄뿐이었다.
# 그 표가 이 대시보드의 핵심이라 목업에서도 확인할 수 있어야 한다.
ANTHROPIC_KEYS = [
    ("apikey_01MockAAAAAAAAAAAAAAAAAA", "사내 리서치 봇",   "active",   0.44),
    ("apikey_01MockBBBBBBBBBBBBBBBBBB", "○○법무법인 챗봇", "active",   0.31),
    ("apikey_01MockCCCCCCCCCCCCCCCCCC", "배치 요약 파이프", "active",   0.17),
    ("apikey_01MockDDDDDDDDDDDDDDDDDD", "구 데모 키",       "archived", 0.08),
]

ANTHROPIC_TOKEN_LABEL = {
    "uncached_input_tokens": "Input Tokens",
    "output_tokens": "Output Tokens",
    "cache_read_input_tokens": "Cache Read Tokens",
    "cache_creation.ephemeral_5m_input_tokens": "Cache Write Tokens (5m)",
    "cache_creation.ephemeral_1h_input_tokens": "Cache Write Tokens (1h)",
}

# ---------------------------------------------------------------- OpenAI

# ⚠️ 목업 단가. 실제 요금표가 아니다.
OPENAI_RATES = {
    "gpt-5":      {"input": 1.25, "cached": 0.125, "output": 10.0, "weight": 0.46},
    "gpt-5-mini": {"input": 0.25, "cached": 0.025, "output": 2.0,  "weight": 0.38},
    "gpt-4.1":    {"input": 2.0,  "cached": 0.5,   "output": 8.0,  "weight": 0.16},
}

# (project_id, 이름, 상태, 사용 비중)
OPENAI_PROJECTS = [
    ("proj_MockAlpha0000000001", "prod-assistant", "active",   0.58),
    ("proj_MockBravo0000000002", "internal-tools", "active",   0.29),
    ("proj_MockCharlie00000003", "sandbox",        "archived", 0.13),
]


def days():
    d, out = START, []
    while d <= END:
        out.append(d)
        d += timedelta(days=1)
    return out


def day_factor(rng, d, i, total):
    """주말 감소 + 완만한 우상향 + 노이즈 + 스파이크."""
    f = 1.0
    if d.weekday() >= 5:            # 토·일
        f *= rng.uniform(0.35, 0.5)
    f *= 1.0 + (i / total) * 0.35   # 기간에 걸쳐 약 35% 증가 추세
    f *= rng.uniform(0.88, 1.12)    # 노이즈
    if d in SPIKE_DAYS:
        f *= rng.uniform(1.55, 2.1)  # 확실히 +20% 넘도록
    return f


def iso(d):
    return d.strftime("%Y-%m-%dT00:00:00Z")


def unix(d):
    """OpenAI 는 시각을 **unix 초 정수**로 준다 (Anthropic 은 ISO 문자열)."""
    return int(datetime(d.year, d.month, d.day, tzinfo=timezone.utc).timestamp())


# ============================================================================
# Anthropic
# ============================================================================

def build_anthropic(rng, all_days):
    """Anthropic Admin API 세 엔드포인트의 응답을 한 파일에 담는다.

    실제로는 별개 엔드포인트라 파일 안에서도 분리해 둔다:
      usage_report -> GET /v1/organizations/usage_report/messages
      cost_report  -> GET /v1/organizations/cost_report
      api_keys     -> GET /v1/organizations/api_keys
    """
    usage_buckets, cost_buckets = [], []
    total = len(all_days)

    for i, d in enumerate(all_days):
        f = day_factor(rng, d, i, total)
        usage_results, cost_results = [], []

        for model, spec in ANTHROPIC_RATES.items():
            model_base = 2_400_000 * spec["weight"] * f

            # token_type -> 그날 그 모델의 총 토큰. 비용 행은 키 축 없이 총량으로 낸다
            # (실제 cost_report 가 api_key_id 로 group_by 되지 않는 것과 같다).
            model_totals = {k: 0 for k in ANTHROPIC_TOKEN_LABEL}

            for key_id, _name, _status, kw in ANTHROPIC_KEYS:
                base = model_base * kw
                uncached_in = int(base * rng.uniform(0.85, 1.15))
                cache_read = int(base * 1.6 * rng.uniform(0.7, 1.3))
                cache_5m = int(base * 0.18 * rng.uniform(0.6, 1.4))
                cache_1h = int(base * 0.05 * rng.uniform(0.3, 1.7))
                output = int(base * 0.14 * rng.uniform(0.75, 1.25))

                model_totals["uncached_input_tokens"] += uncached_in
                model_totals["cache_read_input_tokens"] += cache_read
                model_totals["cache_creation.ephemeral_5m_input_tokens"] += cache_5m
                model_totals["cache_creation.ephemeral_1h_input_tokens"] += cache_1h
                model_totals["output_tokens"] += output

                usage_results.append({
                    "account_id": None,
                    "api_key_id": key_id,
                    "cache_creation": {
                        "ephemeral_1h_input_tokens": cache_1h,
                        "ephemeral_5m_input_tokens": cache_5m,
                    },
                    "cache_read_input_tokens": cache_read,
                    "context_window": "0-200k",
                    "inference_geo": "global",
                    "model": model,
                    "output_tokens": output,
                    "server_tool_use": {
                        "web_search_requests": int(10 * f * rng.uniform(0, 2)),
                    },
                    "service_account_id": None,
                    "service_tier": "standard",
                    "uncached_input_tokens": uncached_in,
                    "workspace_id": None,
                })

            per_type = [
                ("uncached_input_tokens", spec["input"]),
                ("output_tokens", spec["output"]),
                ("cache_read_input_tokens", spec["input"] * CACHE_READ_MULT),
                ("cache_creation.ephemeral_5m_input_tokens", spec["input"] * CACHE_WRITE_MULT),
                ("cache_creation.ephemeral_1h_input_tokens", spec["input"] * 2.0),
            ]
            for token_type, rate in per_type:
                tokens = model_totals[token_type]
                usd = tokens / 1_000_000 * rate
                if usd <= 0:
                    continue
                cost_results.append({
                    # ⚠️ 실제 API 와 동일하게 '최소 통화 단위(센트)' 문자열
                    "amount": f"{usd * 100:.5f}",
                    "context_window": "0-200k",
                    "cost_type": "tokens",
                    "currency": "USD",
                    "description": f"{model} Usage - {ANTHROPIC_TOKEN_LABEL[token_type]}",
                    "inference_geo": "global",
                    "model": model,
                    "service_tier": "standard",
                    "token_type": token_type,
                    "workspace_id": None,
                })

        nxt = d + timedelta(days=1)
        usage_buckets.append({"starting_at": iso(d), "ending_at": iso(nxt), "results": usage_results})
        cost_buckets.append({"starting_at": iso(d), "ending_at": iso(nxt), "results": cost_results})

    return {
        "_comment": NOTE,
        "_source": {
            "usage_report": "GET https://api.anthropic.com/v1/organizations/usage_report/messages",
            "cost_report": "GET https://api.anthropic.com/v1/organizations/cost_report",
            "api_keys": "GET https://api.anthropic.com/v1/organizations/api_keys",
            "amount_units": "cost_report.amount 는 센트 단위 decimal 문자열 — USD 로 쓰려면 100 으로 나눌 것",
            "group_by": ["model", "api_key_id"],
        },
        "usage_report": {"data": usage_buckets, "has_more": False, "next_page": None},
        "cost_report": {"data": cost_buckets, "has_more": False, "next_page": None},
        "api_keys": [
            {
                "id": key_id,
                "name": name,
                "status": status,
                "partial_key_hint": f"sk-ant-api03-{key_id[10:13]}...{key_id[-4:]}",
            }
            for key_id, name, status, _w in ANTHROPIC_KEYS
        ],
    }


# ============================================================================
# OpenAI
# ============================================================================

def build_openai(rng, all_days):
    """OpenAI Admin API 응답.

    ⚠️ 전부 **공개 문서 기준**이고 실응답으로 검증되지 않았다.
       Anthropic 과 다른 점 세 가지가 목업에도 그대로 들어 있다:
         1. 시각이 unix 초 정수 (start_time / end_time)
         2. 금액이 USD 실수 (amount.value) — 센트가 아니다
         3. input_tokens 가 input_cached_tokens 를 **포함**한다
       확인 절차는 docs/openai-integration.md.
    """
    usage_buckets, cost_buckets = [], []
    total = len(all_days)

    for i, d in enumerate(all_days):
        f = day_factor(rng, d, i, total)
        usage_results, cost_results = [], []

        for model, spec in OPENAI_RATES.items():
            model_base = 900_000 * spec["weight"] * f
            totals = {"input": 0, "cached": 0, "output": 0}

            for proj_id, _name, _status, pw in OPENAI_PROJECTS:
                base = model_base * pw
                cached = int(base * 0.55 * rng.uniform(0.5, 1.4))
                uncached = int(base * rng.uniform(0.85, 1.15))
                output = int(base * 0.22 * rng.uniform(0.75, 1.25))

                totals["input"] += uncached
                totals["cached"] += cached
                totals["output"] += output

                usage_results.append({
                    "object": "organization.usage.completions.result",
                    # ⚠️ 캐시를 **포함한** 총 입력 (위 3번). 어댑터가 빼서 정규화한다.
                    "input_tokens": uncached + cached,
                    "input_cached_tokens": cached,
                    "output_tokens": output,
                    "num_model_requests": int(base / 3_000 * rng.uniform(0.8, 1.2)),
                    "project_id": proj_id,
                    "user_id": None,
                    "api_key_id": None,
                    "model": model,
                    "batch": False,
                })

            for kind, label, rate in (
                ("input", "input", spec["input"]),
                ("cached", "cached input", spec["cached"]),
                ("output", "output", spec["output"]),
            ):
                usd = totals[kind] / 1_000_000 * rate
                if usd <= 0:
                    continue
                cost_results.append({
                    "object": "organization.costs.result",
                    # ⚠️ USD 실수. 100 으로 나누지 말 것 (위 2번).
                    "amount": {"value": round(usd, 6), "currency": "usd"},
                    "line_item": f"{model}, {label}",
                    "project_id": None,
                })

        nxt = d + timedelta(days=1)
        usage_buckets.append({
            "object": "bucket",
            "start_time": unix(d),
            "end_time": unix(nxt),
            "results": usage_results,
        })
        cost_buckets.append({
            "object": "bucket",
            "start_time": unix(d),
            "end_time": unix(nxt),
            "results": cost_results,
        })

    return {
        "_comment": NOTE + " OpenAI 쪽은 실키 검증 전이라 특히 주의.",
        "_source": {
            "usage": "GET https://api.openai.com/v1/organization/usage/completions",
            "costs": "GET https://api.openai.com/v1/organization/costs",
            "projects": "GET https://api.openai.com/v1/organization/projects",
            "path_note": "organization 은 **단수** — Anthropic 의 organizations 와 다름",
            "time_units": "start_time / end_time 은 unix 초 정수",
            "amount_units": "costs.amount.value 는 USD 실수 — 100 으로 나누지 말 것",
            "input_tokens_note": "input_tokens 는 input_cached_tokens 를 포함한 총 입력",
            "group_by": ["model", "project_id"],
        },
        "usage": {"object": "page", "data": usage_buckets, "has_more": False, "next_page": None},
        "costs": {"object": "page", "data": cost_buckets, "has_more": False, "next_page": None},
        "projects": [
            {"id": pid, "name": name, "status": status}
            for pid, name, status, _w in OPENAI_PROJECTS
        ],
    }


def main():
    all_days = days()
    os.makedirs(MOCK_DIR, exist_ok=True)

    # 벤더마다 rng 를 따로 준다. 한쪽 생성 로직을 고쳐도 다른 쪽 목업이 안 흔들린다.
    for name, payload in (
        ("anthropic-usage.json", build_anthropic(random.Random(SEED), all_days)),
        ("openai-usage.json", build_openai(random.Random(SEED + 1), all_days)),
    ):
        path = os.path.join(MOCK_DIR, name)
        with open(path, "w", encoding="utf-8") as fp:
            json.dump(payload, fp, indent=2, ensure_ascii=False)
            fp.write("\n")
        size = os.path.getsize(path) / 1024
        print(f"  {name}: {size:.0f} KB")

    print(f"  기간 {START} ~ {END} ({len(all_days)}일), 스파이크 {len(SPIKE_DAYS)}일")


if __name__ == "__main__":
    main()
