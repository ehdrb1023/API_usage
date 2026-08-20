# API 비용 대시보드

Claude(Anthropic Admin API) 와 Vercel 의 사용량·비용을 한 화면에서 본다.
지금은 **목업 데이터**로 동작하며, 환경변수 하나로 실제 API 로 전환된다.

## 실행

```bash
npm install
npm run dev      # http://localhost:3000
```

API 키 없이 바로 뜬다 (`.env` 의 `DATA_SOURCE=mock` 이 기본값).

## 목업 ↔ 실제 API 전환

`.env` 의 값 하나만 바꾸면 된다.

```bash
DATA_SOURCE=mock   # mock/*.json 사용 (기본)
DATA_SOURCE=api    # 실제 API 호출
```

분기는 **`lib/data-source.ts` 한 파일**에만 있다. 목업 파일이 실제 응답 스키마
그대로 생겼기 때문에 두 경로가 같은 어댑터를 타고, 화면 코드는 전혀 바뀌지 않는다.

`api` 로 두고 키가 없으면 화면이 깨지는 대신 무엇이 비었는지 알려주는 에러 페이지가 뜬다.

## 구조

```
mock/                      목업 데이터 (실제 API 스키마와 동일한 모양)
  anthropic-usage.json       usage_report + cost_report
  vercel-usage.json          FOCUS v1.3 billing charges

config/
  client-keys.json         ★ 서비스별 표 표시 이름 (api_key_id → 이름). 팀이 직접 관리
  README.md                  ↑ 작성법·우선순위·api_key_id 확인 방법

lib/
  data-source.ts           ★ 목업/실API 스위치 — 교체 지점은 여기 하나
  client-keys.ts           config/client-keys.json 로더 (벤더 클라이언트 아님)
  adapters/anthropic.ts    Anthropic 응답 → 정규화 모델
  adapters/vercel.ts       Vercel 응답    → 정규화 모델
  analytics.ts             기간 슬라이스, MoM, 급증일 판정
  types.ts                 UI 가 보는 정규화 모델
  format.ts                숫자·통화·날짜 포맷

components/                탭 · 기간선택 · 카드 · 라인차트 · 표
scripts/gen_mock.py        목업 재생성 (시드 고정, 결정적)
scripts/fetch_*.sh         실제 API 응답을 responses/ 에 떠보는 CLI
docs/api-response-notes.md 두 API 의 실제 응답 구조 정리
```

## 화면에서 할 수 있는 것

- **탭** — Claude / Vercel. **기간** — 7일 / 30일 / 이번 달.
- **서비스별 사용량 표의 행을 클릭**하면 위쪽 카드·차트·일별 상세가 그 API 키
  하나만의 수치로 바뀐다. 급증일(전일 대비 +20%)도 그 키 기준으로 다시 계산된다 —
  전체 합계로는 안 보이던 급증이 특정 거래처에서만 잡히는 경우가 있다.
  같은 행을 다시 누르거나 **"전체 보기로 돌아가기"** 를 누르면 해제된다.
  이때 **API 를 다시 부르지 않는다** — `usage_report` 를 이미 `group_by[]=api_key_id`
  로 받아 뒀으므로 메모리에 있는 데이터를 거르기만 한다 (`filterSeriesByAltKey`).
- 모델별·서비스별 두 표는 키를 선택해도 **전체 기준**을 유지한다. 키×모델 교차표는
  만들지 않기 때문이다 (선택 중에는 화면에 그렇게 적힌다).

## 데이터에서 주의할 점

세 가지는 실제 API 로 넘어갈 때도 그대로 유효하다.

1. **Anthropic `cost_report.amount` 는 센트 단위 문자열이다.** `"123.45"` = $1.2345.
   `lib/adapters/anthropic.ts` 에서 100 으로 나눈다. 빠뜨리면 금액이 100배가 된다.
2. **Anthropic 에는 `total_tokens` 필드가 없다.** 입력 + 캐시읽기 + 캐시생성 + 출력을
   직접 합산한다.
3. **Vercel 의 프로젝트는 `Tags.ProjectName` 에 중첩되어 있다.** 최상위 필드가 아니다.

날짜는 전부 UTC 일 경계다. KST 와 9시간 차이가 난다.

## 목업 데이터

`2026-07-01 ~ 2026-08-14` (45일). 30일보다 길게 만든 이유는 **전월 동기 대비**를
계산하려면 전월 같은 기간(7/1–7/14)이 필요하기 때문이다.

재생성:

```bash
python3 scripts/gen_mock.py
```

시드가 고정되어 있어 매번 같은 값이 나온다. 전일 대비 +20% 이상 급증하는 날이
의도적으로 섞여 있다 (빨간색 강조 확인용).
