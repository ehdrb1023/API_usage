# GPT(OpenAI) 연동 — 실키 붙일 때 하는 일

> **상태: 실키 검증 완료 (2026-08-27).**
> `node scripts/verify_openai.mjs` 19/19 통과. 경로·필드명·페이지네이션·금액 단위·
> `group_by=api_key_id` 전부 실응답으로 확인했습니다.
>
> 같은 날 실측 데이터로 **파서 결함 4건을 찾아 고쳤습니다** (§1-6 참고). 고친 뒤
> 60일치 기준 단가 조인 매칭률이 **금액 기준 100%** 입니다.
>
> **남은 것**: 단가 역산의 오차 폭을 아직 측정하지 못했습니다 (Anthropic 은
> hold-out 검증으로 ±0.1% 확인). §2 마지막 항목.

## 왜 별도 문서인가 — 틀려도 티가 안 나기 때문

이 연동의 위험은 "에러가 난다" 가 아닙니다. **틀린 채로 그럴듯한 숫자가 뜨는 것**입니다.

- 금액 단위를 잘못 읽으면 100배 차이가 납니다 (Anthropic 은 센트, OpenAI 는 USD).
- `line_item` 파싱이 실패하면 단가가 조용히 블렌디드 하나로 떨어집니다.
  화면은 멀쩡히 그려지고, 모델별 비용 비율만 틀립니다.
- `costs` 의 `limit` 기본값이 7이라 안 올리면 8일째부터 데이터가 사라집니다.
  차트에는 "그날 안 썼다" 로 보입니다.

그래서 **첫 200 응답을 받은 직후 원문 대조**가 필수입니다.

---

## 0. 준비

1. Admin 키 발급 — Platform → Settings → Organization → **Admin keys**
   (조직 Owner 권한 필요. 프로젝트 키 `sk-proj-…` 로는 401/403)
2. `.env` 에 `OPENAI_ADMIN_KEY=sk-admin-…` 입력.
   조직이 여럿이면 `OPENAI_ORG_ID` 도 채웁니다.
3. **개발 서버를 끕니다.** 원문 덤프와 앱 폴링이 겹치면 쿼터가 섞입니다.

4. **먼저 자동 검증을 돌립니다.** 아래 체크리스트를 대부분 대신 봐 줍니다.

```bash
node scripts/verify_openai.mjs
```

경로 4개를 실제로 두드려 필드명·단위·페이지네이션·`group_by=api_key_id` 동작 여부를
항목별로 ✅/❌ 로 찍습니다. 통과하지 못한 항목만 아래 체크리스트에서 손으로 확인하세요.
(⚠️ 이 스크립트는 `lib/` 를 import 하지 않습니다 — 앱과 같은 코드를 쓰면 앱이 틀렸을 때
검증도 같이 틀리기 때문입니다.)

원문 전체를 눈으로 보고 싶으면:

```bash
DAYS=7 bash scripts/fetch_openai.sh
```

`responses/openai_usage.json` · `openai_costs.json` · `openai_projects.json` 이 생깁니다.
(`responses/` 는 `.gitignore` 대상이라 커밋되지 않습니다.)

---

## 1. 체크리스트 — 위에서부터, 하나씩 지우기

틀릴 가능성이 높은 순서입니다. 위쪽이 틀리면 아래는 볼 것도 없습니다.

### 1-1. 경로 — 단수/복수

- [ ] `/v1/organization/usage/completions` 가 200 인가
      (404 면 `organizations` 복수일 가능성 — Anthropic 과 헷갈린 지점)
- [ ] `/v1/organization/costs` 200
- [ ] `/v1/organization/projects` 200

**고칠 곳:** `lib/clients/openai.ts` 의 `OPENAI_*_PATH` 상수 3개.

### 1-2. 배열 파라미터 표기

- [ ] `group_by=model&group_by=project_id` (반복형)이 동작하는가

400 이 나면 Anthropic 처럼 `group_by[]=model` 대괄호형일 수 있습니다.

**고칠 곳:** `lib/clients/openai.ts` 의 `buildQuery()` — `query.append(key, …)` 를
`query.append(\`${key}[]\`, …)` 로. `scripts/fetch_openai.sh` 도 같이 바꿔야 합니다
(두 곳이 어긋나면 덤프와 앱이 다른 응답을 봅니다).

### 1-3. 시각 표기

- [ ] `start_time` 이 unix 초 정수로 받아들여지는가 (ISO 문자열이면 400)
- [ ] 응답 버킷의 `start_time` / `end_time` 도 정수인가

**고칠 곳:** `lib/adapters/openai.ts` 의 `toIso()`, `lib/clients/openai.ts` 의 `toUnixSeconds()`.

### 1-4. 금액 단위 — **가장 위험**

- [ ] `costs` 응답의 `amount.value` 를 며칠치 합산해 **Platform 청구 화면과 대조**

$0.01 수준이 아니라 **100배 차이**가 나는지만 보면 됩니다.
100배 크게 나오면 이미 센트로 오고 있는 것이고, 그러면 어댑터에서 나눠야 합니다.

**고칠 곳:** `lib/adapters/openai.ts` 의 `toCostRows()`.
(테스트도 함께: `lib/adapters/__tests__/openai.test.ts` 의 "금액 단위")

### 1-5. `input_tokens` 에 캐시가 포함되는가 — **두 번째로 위험**

- [ ] 같은 행에서 `input_cached_tokens <= input_tokens` 인가

성립하면 문서대로(포함)이고, 지금 코드가 맞습니다.
`input_cached_tokens > input_tokens` 인 행이 나오면 **이미 빠져 있는 것**이므로
`inputTokens = input_tokens` 로 고쳐야 합니다.

지금 코드는 음수 방지로 `Math.max(0, …)` 를 걸어 둬서 **틀려도 에러가 안 납니다.**
입력 토큰이 0 으로 뭉개질 뿐입니다 — 그래서 이 확인이 필요합니다.

**고칠 곳:** `lib/adapters/openai.ts` 의 `toUsageRows()`.

### 1-6. `line_item` 실제 형식 — ✅ 확인 완료, 파서 고침

**2026-08-27 실측 34종.** 형식은 `"<모델>[ <모달리티>], <방향>"` 입니다.

```
"gpt-5.6-terra, output"                 모달리티 없음(텍스트 전용)
"gpt-5.6-terra, cached input"           캐시 읽기
"gpt-5.6-terra, cache writes"           캐시 생성 — 읽기와 단가가 다르다
"gpt-image-1 image, output"             모달리티가 모델명 뒤에 붙는다
"gpt-image-2-2026-04-21 text, input"    날짜가 붙기도 한다
"whisper"                               쉼표 없음 + quantity_unit 이 duration_seconds
```

여기서 **결함 4건**이 드러났고 전부 고쳤습니다.

1. **모달리티가 모델명에 섞였다** — `"gpt-image-1 image"` 라는 없는 모델이 생김
2. **캐시 쓰기/읽기를 한 덩어리로 봤다** — 단가가 다른데 합쳐짐 (절대규칙 3번 위반)
3. **usage 와 costs 의 모델 이름이 다르다** — 아래 참고
4. **`whisper` 는 토큰이 아니다** — `quantity_unit` 이 초 단위

#### 모델 이름이 양쪽에서 다르다 — 방향도 일정하지 않다

```
usage "gpt-image-1-2025-04-23"   costs "gpt-image-1"             날짜가 usage 에만
usage "gpt-image-2"              costs "gpt-image-2-2026-04-21"  날짜가 costs 에만
usage "gpt-4o-2024-08-06"        costs "gpt-4o-2024-08-06"       양쪽 같음
```

한쪽만 맞추면 다른 쪽이 깨지므로 **양쪽에서 끝의 `-YYYY-MM-DD` 를 뗍니다**
(`normalizeModel`). 안 맞추면 단가 조인이 실패해 조용히 블렌디드로 떨어지고,
모델별 표에 같은 모델이 두 줄(토큰만/비용만)로 갈립니다.

#### 덤으로 알아낸 것

- `costs` 응답에 **`quantity` + `quantity_unit`** 이 있습니다. 단가 = 금액 ÷ 수량으로
  바로 나오므로 역산 정확도를 더 올릴 여지가 있습니다 (아직 안 씀).
- `costs` 에서 **`group_by=api_key_id` 가 동작합니다** (문서에 없음). 키별 비용을
  안분 추정이 아니라 실측으로 낼 수 있습니다 (아직 안 씀).
- `usage` 가 **`input_uncached_tokens`** 를 직접 줍니다. 빼서 만들 필요가 없습니다.
- 입력 쪽 모달리티 필드는 **캐시를 제외한 값**입니다 (실측: 27444-8448=18996).

<details><summary>원래 체크리스트 (참고용)</summary>


- [ ] 원문에서 `line_item` 값들을 전부 수집한다

```bash
python3 -c "
import json;d=json.load(open('responses/openai_costs.json'))
print(sorted({r.get('line_item') for b in d['data'] for r in b['results']}))
"
```

지금 파서는 `\"모델명, 종류\"` 를 가정하고 쉼표 앞을 모델, 뒤에서
`cach`/`output`/`input` 을 찾습니다.

- [ ] 수집한 값들이 이 규칙에 맞는가
- [ ] 안 맞으면 파서를 고치고, 실제 값 목록을 `docs/api-response-notes.md` 3절에 적는다

**고칠 곳:** `lib/adapters/openai.ts` 의 `parseLineItem()`.

</details>

### 1-7. 페이지네이션과 limit

- [ ] `usage` 를 `bucket_width=1h` + 7일 이상으로 받아 `has_more` / `next_page` 가 도는가
- [ ] `costs` 를 8일 이상 받았을 때 버킷 수가 실제 일수와 같은가 (`limit` 기본 7 함정)
- [ ] `projects` 가 `after` / `last_id` 로 넘어가는가 (리포트와 방식이 다름)

### 1-8. API 키 이름 — 보조 축의 라벨

GPT 탭의 보조 축은 **API 키**입니다 (Claude 탭과 같습니다). 사용량 자체는
`group_by=api_key_id` 로 쪼개지지만, **이름은 프로젝트마다 따로 받아야** 합니다 —
OpenAI 에는 조직 전체 키를 주는 엔드포인트가 없습니다.

- [ ] usage 응답 행에 `api_key_id` 가 실제로 들어오는가
      (안 오면 `group_by` 가 안 먹은 것이고, 전부 프로젝트 단위로 떨어집니다)
- [ ] `/v1/organization/projects/{id}/api_keys` 가 200 인가
- [ ] 거기서 온 `id` 가 usage 의 `api_key_id` 와 **같은 형식**인가
      (다르면 이름이 하나도 안 붙고 표에 id 만 뜹니다)

**고칠 곳:** `lib/clients/openai.ts` 의 `openAiProjectApiKeysPath()`,
`lib/services.ts` 의 `openaiKeyNames()`.

### 1-9. 레이트리밋

- [ ] 429 응답의 `retry-after` 헤더가 오는가
- [ ] 시간당/분당 허용 횟수를 응답 헤더에서 확인해 `.env.example` 에 적는다

Anthropic 은 시간당 90회였습니다. OpenAI 값을 모르면 미니 위젯 폴링 주기를
정할 근거가 없습니다.

---

## 2. 검증 결과 (2026-08-27)

| 항목 | 결과 |
|---|---|
| 조회 API 검증 | ✅ `node scripts/verify_openai.mjs` **19/19** |
| 파서 결함 | ✅ 실측으로 4건 발견·수정 (§1-6) |
| 단가 조인 매칭률 | ✅ 60일 기준 **금액 100%** |
| 비용 추정 오차 (hold-out) | ✅ **합계 0.68%**, 일별 중앙값 **0.0%** |
| 키별 안분 오차 | ✅ 실측 대조 **-0.00%** |
| 목업 | ✅ 실제 스키마로 갱신 |
| 레이트리밋 | ✅ 아래 참고 |

### 레이트리밋 — Anthropic 과 다르다

**레이트리밋 헤더가 아예 없고**, 연속 25회를 20초에 몰아쳐도 429 가 나지 않았다.
Anthropic 의 시간당 90회 같은 제약은 관측되지 않았다.

> 그래서 `LIVE_REFRESH_SECONDS` 를 정할 때 **GPT 는 제약이 아니다.** 이 값은
> Anthropic 쪽 90회/시간에 맞춰 정하면 된다. 쿼터는 벤더별로 따로 센다.

⚠️ "관측되지 않았다" 는 "없다" 가 아니다. 더 세게 두드리면 나올 수 있다.

### 안 바꾸기로 한 것 — 재 보고 내린 결정

실측 중에 개선 여지를 둘 발견했지만 **둘 다 넣지 않았다.**

- `costs` 응답에 `quantity` + `quantity_unit` 이 있어 단가를 금액÷수량으로 바로 낼 수
  있다 → 하지만 지금 역산 오차가 이미 0.68% 라 바꿀 이유가 없다.
- `costs` 가 `group_by=api_key_id` 를 지원한다(문서에 없음) → 키별 비용을 실측으로
  낼 수 있지만, 안분 오차가 -0.00% 라 마찬가지다.

**측정을 먼저 했기 때문에 불필요한 복잡도를 안 들였다.** 나중에 오차가 커지면
(새 모달리티·새 과금 축이 생기면) 이 두 가지가 준비된 카드다.

### 그래도 남은 것

- [ ] 화면의 "비용은 추정치" 문구는 **유지한다.** 오차가 작아도 추정은 추정이다.
- [ ] 새 모델·모달리티가 등장하면 hold-out 을 다시 돌려 오차를 재측정할 것.
      `docs/api-response-notes.md` 3절도 그때 함께 갱신.

## 3. 설계상 이미 정해 둔 것 (바꾸려면 근거가 필요)

| 항목 | 선택 | 이유 |
|---|---|---|
| 서비스 id | `gpt` | `claude` 와 같은 결 — 벤더명이 아니라 모델 계열 |
| 보조 축 | **API 키** | `usage/completions` 가 `group_by=api_key_id` 를 지원한다. 이름만 프로젝트별로 따로 받는다 |
| 키 이름 표기 | `프로젝트 / 키` | 키 이름은 프로젝트끼리 흔히 겹친다 |
| `api_key_id` 가 빈 행 | **프로젝트로** 떨어뜨린다 | 전부 "콘솔" 한 덩어리로 뭉치는 것보다 낫다 |
| 입력 토큰 | 캐시를 **뺀** 값 | Claude 탭과 뜻을 맞춘다. 안 맞추면 "총 토큰" 이 탭마다 다른 뜻이 된다 |
| 총 토큰 | 요청 수 **제외** | `requests` 는 토큰이 아니다 (`OPENAI_BUILD.totalOf`) |
| 하루 경계 | **KST** | 1시간 버킷을 지원하므로 Claude 와 같은 방식으로 정확히 접힌다 |
| 비용 | 단가 역산 추정치 | `costs` 가 UTC 1일 단위뿐이라 KST 로 자를 수 없다 |
| 탭 표시 | 키 있을 때만 | 안 붙인 벤더가 "조회 실패" 로 떠 있으면 진짜 장애와 구분이 안 된다 |

## 4. 안 한 것

- **요금표 하드코딩.** 단가는 실측 비용에서 역산합니다. 공시 단가를 코드에 박으면
  가격이 바뀔 때 조용히 틀립니다.
- **Responses/Embeddings/Images 등 다른 사용량 엔드포인트.**
  `usage/completions` 만 씁니다. 다른 종류를 쓰기 시작하면 그만큼 비용이 빠집니다 —
  `costs` 총액과 토큰 추정 총액이 벌어지면 이걸 의심하세요.
