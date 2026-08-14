#!/usr/bin/env python3
"""mock/ 목업 데이터 생성기 (결정적 — 시드 고정이라 매번 같은 결과).

필드명은 임의로 지어낸 게 아니라, docs/api-response-notes.md 에 정리한
Anthropic Admin API / Vercel FOCUS billing charges 의 실제 문서 스키마를 따른다.
그래야 나중에 목업 → 실제 API 교체 시 어댑터를 거의 안 고쳐도 된다.

기간: 2026-07-01 ~ 2026-08-14 (45일)
  - "최근 7일"  : 08-08 ~ 08-14
  - "최근 30일" : 07-16 ~ 08-14
  - "이번 달"   : 08-01 ~ 08-14
  - "전월 동기" : 07-01 ~ 07-14   ← 전월 대비 증감률 계산에 필요해서 30일보다 길게 생성
"""
import json
import os
import random
from datetime import date, timedelta

SEED = 20260814
START = date(2026, 7, 1)
END = date(2026, 8, 14)

HERE = os.path.dirname(os.path.abspath(__file__))
MOCK_DIR = os.path.join(os.path.dirname(HERE), "mock")

# 전일 대비 +20% 이상 튀는 날 (빨간 강조 표시 확인용)
SPIKE_DAYS = {date(2026, 7, 9), date(2026, 7, 23), date(2026, 8, 5), date(2026, 8, 12)}

NOTE = (
    "목업 데이터입니다. 실제 API 연동 시 필드명 확인 필요 — "
    "구조는 공식 문서 스키마를 따랐으나 실제 응답으로 검증되지 않았습니다. "
    "docs/api-response-notes.md 의 '남은 검증 항목' 참고."
)

# 목업 단가 (USD / 100만 토큰). 실제 요금이 아니라 그럴듯한 값.
MODEL_RATES = {
    "claude-opus-5":   {"input": 15.0, "output": 75.0, "weight": 0.22},
    "claude-sonnet-5": {"input": 3.0,  "output": 15.0, "weight": 0.50},
    "claude-haiku-4-5": {"input": 1.0, "output": 5.0,  "weight": 0.28},
}
CACHE_READ_MULT = 0.1    # 캐시 읽기는 입력가의 10%
CACHE_WRITE_MULT = 1.25  # 5분 캐시 생성은 입력가의 125%

VERCEL_PROJECTS = [
    ("prj_8Kq2mNvR4tXwL9pC", "api-usage-dashboard", 1.0),
    ("prj_3Fh7bWzY6sQeT1nD", "marketing-site", 0.55),
    ("prj_5Jm9cPxV2rUiO8kA", "internal-tools", 0.30),
]

# (ServiceName, ServiceCategory, ConsumedUnit, PricingUnit, 일 기준량, USD 단가)
VERCEL_SERVICES = [
    ("Build Execution",    "Compute",    "build-minutes", "build-minute", 42.0,      0.0080),
    ("Function Invocations", "Compute",  "invocations",   "million invocations", 180000.0, 0.0000006),
    ("Fast Data Transfer", "Networking", "GB",            "GB",           23.0,      0.1500),
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


def build_anthropic(rng, all_days):
    """Anthropic Admin API 두 엔드포인트의 응답을 한 파일에 담는다.

    실제로는 별개 엔드포인트라 파일 안에서도 분리해 둔다:
      usage_report -> GET /v1/organizations/usage_report/messages
      cost_report  -> GET /v1/organizations/cost_report
    """
    usage_buckets, cost_buckets = [], []
    total = len(all_days)

    for i, d in enumerate(all_days):
        f = day_factor(rng, d, i, total)
        usage_results, cost_results = [], []

        for model, spec in MODEL_RATES.items():
            base = 2_400_000 * spec["weight"] * f
            uncached_in = int(base * rng.uniform(0.85, 1.15))
            cache_read = int(base * 1.6 * rng.uniform(0.7, 1.3))
            cache_5m = int(base * 0.18 * rng.uniform(0.6, 1.4))
            cache_1h = int(base * 0.05 * rng.uniform(0.3, 1.7))
            output = int(base * 0.14 * rng.uniform(0.75, 1.25))

            usage_results.append({
                "account_id": None,
                "api_key_id": None,
                "cache_creation": {
                    "ephemeral_1h_input_tokens": cache_1h,
                    "ephemeral_5m_input_tokens": cache_5m,
                },
                "cache_read_input_tokens": cache_read,
                "context_window": "0-200k",
                "inference_geo": "global",
                "model": model,
                "output_tokens": output,
                "server_tool_use": {"web_search_requests": int(40 * f * rng.uniform(0, 2))},
                "service_account_id": None,
                "service_tier": "standard",
                "uncached_input_tokens": uncached_in,
                "workspace_id": None,
            })

            # cost_report: token_type 별로 행이 나뉜다. amount 는 '센트' decimal 문자열.
            per_type = [
                ("uncached_input_tokens", uncached_in, spec["input"]),
                ("output_tokens", output, spec["output"]),
                ("cache_read_input_tokens", cache_read, spec["input"] * CACHE_READ_MULT),
                ("cache_creation.ephemeral_5m_input_tokens", cache_5m, spec["input"] * CACHE_WRITE_MULT),
                ("cache_creation.ephemeral_1h_input_tokens", cache_1h, spec["input"] * 2.0),
            ]
            label = {
                "uncached_input_tokens": "Input Tokens",
                "output_tokens": "Output Tokens",
                "cache_read_input_tokens": "Cache Read Tokens",
                "cache_creation.ephemeral_5m_input_tokens": "Cache Write Tokens (5m)",
                "cache_creation.ephemeral_1h_input_tokens": "Cache Write Tokens (1h)",
            }
            for token_type, tokens, rate in per_type:
                usd = tokens / 1_000_000 * rate
                if usd <= 0:
                    continue
                cost_results.append({
                    # ⚠️ 실제 API 와 동일하게 '최소 통화 단위(센트)' 문자열
                    "amount": f"{usd * 100:.5f}",
                    "context_window": "0-200k",
                    "cost_type": "tokens",
                    "currency": "USD",
                    "description": f"{model} Usage - {label[token_type]}",
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
            "amount_units": "cost_report.amount 는 센트 단위 decimal 문자열 — USD 로 쓰려면 100 으로 나눌 것",
            "group_by": ["model", "description"],
        },
        "usage_report": {"data": usage_buckets, "has_more": False, "next_page": None},
        "cost_report": {"data": cost_buckets, "has_more": False, "next_page": None},
    }


def build_vercel(rng, all_days):
    """Vercel FOCUS v1.3 billing charges. 실제로는 JSONL 이지만 여기선 배열로 담는다."""
    charges = []
    total = len(all_days)

    for i, d in enumerate(all_days):
        f = day_factor(rng, d, i, total)
        nxt = d + timedelta(days=1)

        for pid, pname, pweight in VERCEL_PROJECTS:
            for svc, cat, cunit, punit, base, rate in VERCEL_SERVICES:
                qty = base * pweight * f * rng.uniform(0.85, 1.15)
                if cunit == "invocations":
                    qty = round(qty)
                    pricing_qty = qty / 1_000_000
                    cost = qty * rate
                else:
                    qty = round(qty, 3)
                    pricing_qty = qty
                    cost = qty * rate

                charges.append({
                    "BilledCost": round(cost, 6),
                    # 크레딧으로 상쇄된 부분을 흉내내기 위해 일부는 EffectiveCost 를 낮춘다
                    "EffectiveCost": round(cost * (0.0 if d.weekday() == 6 else 1.0), 6),
                    "BillingCurrency": "USD",
                    "ChargeCategory": "Usage",
                    "ChargePeriodStart": iso(d),
                    "ChargePeriodEnd": iso(nxt),
                    "ConsumedQuantity": qty,
                    "ConsumedUnit": cunit,
                    "PricingCategory": "Standard",
                    "PricingCurrency": "USD",
                    "PricingQuantity": round(pricing_qty, 6),
                    "PricingUnit": punit,
                    "RegionId": "icn1",
                    "RegionName": "Seoul",
                    "ServiceCategory": cat,
                    "ServiceName": svc,
                    "ServiceProviderName": "Vercel",
                    "Tags": {"ProjectId": pid, "ProjectName": pname},
                })

    return {
        "_comment": NOTE,
        "_source": {
            "endpoint": "GET https://api.vercel.com/v1/billing/charges?from=&to=&teamId=",
            "format": "실제 응답은 FOCUS v1.3 JSONL — 여기서는 배열(charges)로 감쌌음",
            "cost_fields": "BilledCost = 청구 기준액, EffectiveCost = 크레딧·할인 반영 상각 원가",
            "project_grouping": "Tags.ProjectName (최상위 아님, 중첩 경로)",
        },
        "charges": charges,
    }


def main():
    rng = random.Random(SEED)
    all_days = days()
    os.makedirs(MOCK_DIR, exist_ok=True)

    for name, payload in (
        ("anthropic-usage.json", build_anthropic(rng, all_days)),
        ("vercel-usage.json", build_vercel(rng, all_days)),
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
