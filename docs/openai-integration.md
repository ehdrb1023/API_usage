# GPT(OpenAI) 연동 — 실키 붙일 때 하는 일

> **상태: 자리만 마련됨 (2026-08-26).**
> 코드는 다 있고 `.env` 에 `OPENAI_ADMIN_KEY` 를 넣으면 GPT 탭이 켜집니다.
> 다만 **경로·파라미터·응답 필드가 전부 공개 문서 기준이고 실응답으로 검증되지
> 않았습니다.** 이 문서는 그 확인 절차입니다.

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

### 1-6. `line_item` 실제 형식

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

### 1-7. 페이지네이션과 limit

- [ ] `usage` 를 `bucket_width=1h` + 7일 이상으로 받아 `has_more` / `next_page` 가 도는가
- [ ] `costs` 를 8일 이상 받았을 때 버킷 수가 실제 일수와 같은가 (`limit` 기본 7 함정)
- [ ] `projects` 가 `after` / `last_id` 로 넘어가는가 (리포트와 방식이 다름)

### 1-8. 레이트리밋

- [ ] 429 응답의 `retry-after` 헤더가 오는가
- [ ] 시간당/분당 허용 횟수를 응답 헤더에서 확인해 `.env.example` 에 적는다

Anthropic 은 시간당 90회였습니다. OpenAI 값을 모르면 미니 위젯 폴링 주기를
정할 근거가 없습니다.

---

## 2. 확인 끝난 뒤 정리

- [ ] `lib/services.ts` 의 `OPENAI_UNVERIFIED` 상수를 **지운다**
      (`unverified` 가 사라지면 화면의 경고 문구도 같이 사라집니다)
- [ ] `lib/adapters/openai.ts` · `lib/clients/openai.ts` · `lib/clients/types.ts` 의
      `⚠️ 미검증` 주석을 실제 확인 결과로 바꾼다
- [ ] `docs/api-response-notes.md` 3절을 실응답 기준으로 다시 쓴다
- [ ] `scripts/gen_mock.py` 의 `build_openai()` 를 실제 스키마에 맞춘 뒤
      `python3 scripts/gen_mock.py` 로 목업 재생성
- [ ] 단가 역산 hold-out 검증 — Anthropic 에서 했던 것과 같은 방식으로,
      하루를 빼고 나머지로 단가를 만들어 그 하루를 맞혀 본다.
      오차가 몇 % 인지 `lib/token-rates.ts` 주석에 적는다 (지금은 Anthropic 수치만 있음)

---

## 3. 설계상 이미 정해 둔 것 (바꾸려면 근거가 필요)

| 항목 | 선택 | 이유 |
|---|---|---|
| 서비스 id | `gpt` | `claude` 와 같은 결 — 벤더명이 아니라 모델 계열 |
| 보조 축 | **프로젝트** | 조직 전체 API 키 목록 엔드포인트가 없다. 과금·권한 단위도 프로젝트 |
| 입력 토큰 | 캐시를 **뺀** 값 | Claude 탭과 뜻을 맞춘다. 안 맞추면 "총 토큰" 이 탭마다 다른 뜻이 된다 |
| 총 토큰 | 요청 수 **제외** | `requests` 는 토큰이 아니다 (`OPENAI_BUILD.totalOf`) |
| 하루 경계 | **KST** | 1시간 버킷을 지원하므로 Claude 와 같은 방식으로 정확히 접힌다 |
| 비용 | 단가 역산 추정치 | `costs` 가 UTC 1일 단위뿐이라 KST 로 자를 수 없다 |
| 탭 표시 | 키 있을 때만 | 안 붙인 벤더가 "조회 실패" 로 떠 있으면 진짜 장애와 구분이 안 된다 |

## 4. 안 한 것

- **요금표 하드코딩.** 단가는 실측 비용에서 역산합니다. 공시 단가를 코드에 박으면
  가격이 바뀔 때 조용히 틀립니다.
- **프로젝트별 API 키 나열.** 프로젝트마다 호출이 하나씩 더 나가고, 지금은 보조 축이
  프로젝트라 필요하지 않습니다. 키 단위로 더 잘게 봐야 하면 그때 추가하세요.
- **Responses/Embeddings/Images 등 다른 사용량 엔드포인트.**
  `usage/completions` 만 씁니다. 다른 종류를 쓰기 시작하면 그만큼 비용이 빠집니다 —
  `costs` 총액과 토큰 추정 총액이 벌어지면 이걸 의심하세요.
