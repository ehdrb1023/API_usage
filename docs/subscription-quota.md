# 구독 사용량 한도 — 조사 노트

**"이번 주 얼마나 남았나"** 를 어디서 얻고, 왜 토큰 개수로는 못 주는지.
2026-09-04 실측. 구현은 보류 상태다 — 아래 "만들려면" 절 참고.

---

## 0. 먼저 — 돈이 나가는 통로가 둘이다

이 둘을 섞으면 이후 논의가 전부 어긋난다.

| | API (Admin key) | 구독 (Max·Pro) |
|---|---|---|
| 요금 | **쓴 만큼 청구** | 매달 정액 |
| 한도 | **없음** (종량제) | 5시간·주간 한도 |
| 넘기면 | 계속 나감 | **막힌다** (돈은 안 늘어남) |
| 쓰는 주체 | 우리 서비스의 API 키 | Claude Code, claude.ai |
| 보는 법 | Admin key | Claude Code OAuth 토큰 |
| 화면 | 대시보드 본문 전부 | `components/QuotaBars.tsx` |

**Admin key 로는 구독 한도를 못 얻는다.** 다른 물건이다.
Admin API 는 종량제 사용분만 보고, 구독으로 쓴 것은 **장부에 한 줄도 안 올라간다**
— 정액제라 토큰당 과금을 안 하니 기록할 이유가 없다.

실측(2026-08 하루): Admin API $2.46 / 구독 사용분 320M 토큰. 두 자릿수 배 차이다.

---

## 1. 출처 — Claude Code 의 `/usage`

```
GET https://api.anthropic.com/api/oauth/usage
Authorization: Bearer <accessToken>
anthropic-beta: oauth-2025-04-20
```

토큰은 `~/.claude/.credentials.json` 의 `claudeAiOauth.accessToken`.
**Admin key 가 아니다.** Claude Code 가 로그인할 때 받은 OAuth 토큰이고,
만료 약 8시간·갱신은 Claude Code 가 한다.

구현: `lib/quota.ts`. 화면: `components/QuotaBars.tsx`.

### 실측 응답 (2026-09-04, Max 20x 계정)

```jsonc
{
  "five_hour": {
    "utilization": 60,
    "resets_at": "2026-09-04T10:39:59Z",
    "limit_dollars": null,      // ← 전부 null
    "used_dollars": null,
    "remaining_dollars": null
  },
  "seven_day": { "utilization": 40, "resets_at": "2026-09-06T09:59:59Z", /* 동일하게 null */ },
  "extra_usage": { "is_enabled": false, "monthly_limit": null, "used_credits": null },
  "limits": [
    { "kind": "session",       "percent": 60, "resets_at": "...", "scope": null },
    { "kind": "weekly_all",    "percent": 40, "resets_at": "...", "scope": null },
    { "kind": "weekly_scoped", "percent": 58, "scope": { "model": { "display_name": "Fable" } } }
  ]
}
```

응답 최상위에는 코드네임 필드(`tangelo`·`nimbus_quill`·`iguana_necktie` 등)가 여럿 있고
대부분 `null` 이다. **`limits` 배열만 쓴다** — 최상위와 같은 값인데 모델별 한도까지
들고 있고 항목이 늘어도 그대로 따라온다.

### 왜 토큰 개수가 없나

`limit_dollars`·`used_dollars`·`remaining_dollars` 가 **전부 null 로 온다.**
정액제라 상한을 공개하지 않는 구조다. 여기서 더 캘 것이 없다.

그리고 **한도 자체가 고정도 아니다.** 2026-09 실측으로 계정 화면에
"9월 13일까지 주간 Claude Code 한도가 50% 더 높아집니다" 가 떠 있었다.
100% 의 크기가 움직이므로, 토큰으로 환산해 두면 그날부터 틀린 숫자가 된다.

**퍼센트가 벤더가 주는 그대로이고 흔들리지 않는 유일한 값이다.**

---

## 2. 그래도 토큰 수를 알고 싶다면 — 로컬 로그 역산

Claude Code 는 호출마다 사용량을 로컬에 남긴다.

```
~/.claude/projects/**/*.jsonl
```

한 줄이 한 메시지고, `message.usage` 에 토큰이 있다.

```jsonc
{
  "timestamp": "2026-09-04T07:22:01.033Z",
  "message": {
    "model": "claude-opus-5",
    "usage": {
      "input_tokens": 2,
      "cache_creation_input_tokens": 69181,
      "cache_read_input_tokens": 26448,
      "output_tokens": 355
    }
  }
}
```

창 시작 시각(`resets_at` − 창 길이) 이후만 합치면 **그 창에서 실제 태운 양**이 나온다.

### 실측 (2026-09-04 17:23 KST)

주간 창 8/30 18:59 KST ~ , 로그 337MB / 198파일 스캔:

| 모델 | 입력 | 캐시읽기 | 캐시생성 | 출력 | 호출 |
|---|---:|---:|---:|---:|---:|
| claude-opus-5 | 26.4K | 3.33B | 75.5M | 11.8M | 13,182 |
| claude-sonnet-5 | 844 | 32.2M | 2.7M | 12.3K | 422 |
| **합계** | **27.2K** | **3.36B** | **78.2M** | **11.8M** | **13,614** |

5시간 창(9/4 14:39 KST ~): 152.0M 캐시읽기 / 2.9M 캐시생성 / 456.1K 출력 / 397회.

### 역산 결과

```
주간   3.45B 토큰 = 40%  →  1%당 86.3M  →  남은 60% ≈ 5.2B
5시간  155M 토큰  = 60%  →  1%당 2.6M   →  남은 40% ≈ 104M
```

같은 시점의 소진 속도:

```
[5시간] 60% · 경과 2.7h/5h · 22.0%/시간
        리셋(19:39)까지 50%p 필요 / 남은 건 40%p
        ⚠ 리셋 전 소진 예상 19:12 KST

[주간]  40% · 경과 118h/168h · 0.3%/시간
        ✓ 리셋까지 여유
```

---

## 3. ⚠️ 이 숫자를 그대로 믿으면 안 되는 이유 셋

**1. 분모가 뭔지 모른다.** 캐시읽기를 어떻게 세는지에 따라 **40배** 갈린다.

```
캐시읽기 포함    남은 5.2B 토큰
캐시읽기 제외    남은 135M 토큰
```

캐시읽기는 단가가 1/10 수준이라 같은 무게로 셀 리 없다. 실제 한도는 비용 환산일
가능성이 높지만 확인할 방법이 없다.

**2. 계정 전체 vs 이 PC.** 퍼센트는 **계정 단위**고 로그는 **이 PC 것뿐**이다.
한 계정을 여러 기기에서 쓰면 이 PC 몫이 전체보다 작으므로 한도를 실제보다
**작게** 잡는다.

**3. 한도가 변한다.** 프로모션으로 100% 의 크기가 움직인다 (위 1절).

### 확정하는 법 — 두 번 재서 기울기를 본다

분모가 무엇이든 상관없어진다.

```
17:23   60%   155M
19:00   ??%   ???
        ────────────
        Δ토큰 / Δ퍼센트 = 1%당 실제 소비량
```

한 번 재면 "이번 창의 평균", 두 번 재면 **"지금 이 순간의 속도"** 다.
"몇 시에 막히나" 가 정확해지는 건 후자다.

**지금은 매번 읽고 버려서 기울기를 모른다.** 스냅샷을 쌓는 것이 이 조사의 결론이다.

---

## 4. 왜 배포본에서 안 보이나

`hasQuotaSource()` 가 자격증명 파일 유무를 보고, 없으면 한도 카드를 아예 안 만든다.
Vercel 서버에는 `~/.claude/.credentials.json` 이 없다.

**파일이 없는 게 문제가 아니라 인증이 여행을 못 가는 것이다.** accessToken 은 8시간이면
죽고, 서버에는 갱신해 줄 주체가 없다.

| 방법 | 문제 |
|---|---|
| accessToken 을 env 에 | 8시간 뒤 죽는다 |
| refreshToken 을 env 에 넣고 서버가 갱신 | 갱신 시 refreshToken 도 교체된다 → **저장소 필요**. 30일마다 사람이 재시드. 문서화 안 된 내부 플로우 |
| **Claude Code 가 도는 PC 가 결과를 밀어 넣는다** | **저장소만 필요.** 토큰이 PC 를 안 떠나고 갱신 문제가 사라진다 |

셋 다 저장소가 필요한데 마지막만 토큰 문제가 없다. **마지막을 권한다.**

---

## 5. 만들려면 (보류 중)

```
1. 저장소        Vercel Blob (JSON 하나). Edge Config 는 쓰기가 API 경유라 절차가 하나 더 붙는다
2. 수신          POST /api/quota + 공유 시크릿 검증
3. 로컬 푸셔      /usage 퍼센트 + 로그 토큰 합을 5분마다 POST
4. 화면          "N분 전 기준" 표기 — PC 가 꺼져 있으면 값이 늙는다. 정직하게 드러낸다
```

만들면 세 가지가 한꺼번에 풀린다 — 남은 양 추정 / 소진 속도 / 다른 기기에서 보기.
`components/QuotaBars.tsx` 는 그대로 쓴다.

**한계 둘은 만들어도 남는다.**
- 한도는 **계정 단위**다. 계정 3개를 다 보려면 각 계정으로 Claude Code 가 도는 기기 3대에서 밀어야 한다
- 이 엔드포인트는 Anthropic 에만 있다. **ChatGPT Pro 구독 한도는 조회할 방법이 없다**

---

## 6. 재현 명령

현재 퍼센트 (값은 안 찍는다):

```bash
node --import ./lib/clients/__tests__/ts-resolve.mjs -e "
const { getQuota } = await import('./lib/quota.ts');
const q = await getQuota();
for (const w of q.windows) console.log(w.label, w.usedPercent + '%', w.resetsAt);
"
```

원본 응답 전체:

```bash
node -e "
const fs=require('fs'),os=require('os'),p=require('path');
const t=JSON.parse(fs.readFileSync(p.join(os.homedir(),'.claude','.credentials.json'),'utf8')).claudeAiOauth.accessToken;
fetch('https://api.anthropic.com/api/oauth/usage',{headers:{authorization:'Bearer '+t,'anthropic-beta':'oauth-2025-04-20'}})
  .then(r=>r.json()).then(d=>console.log(JSON.stringify(d,null,2)));
"
```

창 구간 토큰 합계는 위 2절 방식으로 `~/.claude/projects/**/*.jsonl` 를 훑는다.
`resets_at` 에서 창 길이(5h / 168h)를 빼면 창 시작 시각이다.
