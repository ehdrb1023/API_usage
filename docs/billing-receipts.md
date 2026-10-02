# 영수증 자동 정리 — 결제 메일 → JSON

증빙용이다. 매달 "요금제로 얼마, API 로 얼마" 를 답하고, 각 건마다 **어느 카드로
냈는지**와 **원본 영수증 PDF** 를 갖고 있는 게 목표다.

## 지금 상태 (2026-08-27)

| | |
|---|---|
| 메일함 | `speciai250331@gmail.com` — 확인됨. **바뀔 수 있다** (아래 참고) |
| 확인된 벤더 | Anthropic(구독·환불·결제실패), OpenAI(충전), Stripe 재판매사(Deep Infra·Meshy) |
| 확인된 카드 | 끝 **4411** 하나 (OpenAI·Deep Infra 공통) |
| 파서 | `lib/billing/parse-receipt.ts` — 실제 메일 본문으로 20개 테스트 통과 |
| 저장소 | **JSON 파일** (`data/billing/`, gitignore) — 아래 참고 |
| 수집 | Claude 스케줄 루틴 (Gmail MCP) — 아래 절차 |

## 메일함을 바꾸려면

**코드를 고치지 않는다.** `config/billing-sources.json` 만 손댄다.

```jsonc
{
  "mailboxes": [
    { "address": "speciai250331@gmail.com",
      "active": false,              // ← 끄기만 한다. 지우지 않는다
      "until": "2026-09-30" },      // ← 갈아탄 날
    { "address": "새주소@gmail.com",
      "active": true,
      "since": "2026-10-01" }
  ]
}
```

**옛 주소를 지우지 마세요.** 지우면 과거 영수증의 `source_mailbox` 가 설명 없는
문자열이 됩니다. 껐다는 기록이 남아 있어야 "이때부터 저 주소로 왔다" 를 알 수 있습니다.

### 갈아타는 동안 중복이 안 나는 이유

전환기에 같은 영수증이 두 주소로 들어올 수 있습니다. 중복 판정 키
(`receiptKey()`)에 **메일함을 일부러 넣지 않았습니다** — 넣으면 서로
다른 건으로 보여 그 달 지출이 두 배가 됩니다. 키는 벤더가 매긴 영수증 번호이고,
번호가 없는 OpenAI 충전 메일만 (벤더·날짜·금액·카드)로 대체합니다.

> ⚠️ 그 대체 키의 한계: **같은 날 같은 금액을 같은 카드로 두 번 충전하면 한 건으로
> 합쳐집니다.** OpenAI 충전 메일에 그 둘을 구분할 정보가 아예 없어서 고칠 방법이
> 없습니다. 월 합계가 벤더 청구서와 안 맞으면 여기를 먼저 의심하세요.

### 다른 계정 메일을 읽으려면

지금 Claude 에 연결된 Gmail 은 speciai250331@gmail.com **하나뿐**입니다. 설정 파일에
주소를 적는다고 읽히지 않습니다. 둘 중 하나가 필요합니다.

1. 그 계정을 Claude 에 추가로 연결한다
2. 그 계정에서 speciai250331 로 **자동 전달**을 건다 — 이쪽이 간단합니다. 전달해도
   원래 보낸사람이 헤더에 남아서 벤더 규칙이 그대로 동작합니다

## 새 벤더가 생기면

`config/billing-sources.json` 의 `vendorRules` 에 한 줄 추가합니다.

- **Stripe 를 쓰는 업체면 아무것도 안 해도 됩니다** — 이미 있는 `stripe.com` 규칙에
  걸리고, 업체 이름은 본문 `Receipt from X` 에서 읽습니다.
- 자체 템플릿을 쓰는 벤더면 `lib/billing/parse-receipt.ts` 의 `TEMPLATES` 에
  파서를 추가하고 `TemplateId` 에 이름을 넣습니다.

못 읽은 메일은 버리지 않고 `data/billing/unparsed.json` 에 쌓입니다. 거기가 곧
"새 벤더 발견 목록" 입니다.

## 돌리는 법

```bash
# 1) Gmail 검색어 확인 (config/billing-sources.json 에서 만들어집니다)
node --import ./lib/clients/__tests__/ts-resolve.mjs scripts/collect_receipts.mjs --query

# 2) Claude 가 그 검색어로 메일을 긁어 아래 형식의 JSON 으로 덤프
#    [{ messageId, mailbox, sender, subject, date, plaintextBody, attachments? }]

# 3) 파싱·중복제거·저장·집계
node --import ./lib/clients/__tests__/ts-resolve.mjs scripts/collect_receipts.mjs mails.json

# 저장된 것만 다시 보기
node --import ./lib/clients/__tests__/ts-resolve.mjs scripts/collect_receipts.mjs --summary
```

### 왜 스크립트가 Gmail 을 직접 안 읽나

Gmail 접근은 Claude 쪽 연동(MCP)이라 Node 스크립트에서 부를 수 없습니다. 앱에 Gmail
API 를 직접 붙이려면 Google Cloud 프로젝트 + OAuth 동의화면 + 리프레시 토큰 관리가
따라오는데, 월 5~10건 읽자고 치르기엔 비쌉니다. 그래서 **역할을 나눴습니다** —
메일을 긁는 건 Claude, 파싱·저장·집계는 스크립트입니다.

## 수집 절차 (Claude 루틴)

주 1회 정도면 충분합니다 — 결제는 월 단위라 자주 돌 이유가 없습니다.

1. `config/billing-sources.json` 을 읽고 `gmailQuery()` 로 검색어를 만든다
   → `{from:mail.anthropic.com from:tm.openai.com from:stripe.com} newer_than:90d`
2. Gmail 에서 스레드를 검색하고, 각 메시지를 `PLAIN_TEXT` 로 받는다
3. `parseMail()` 에 넣는다
   - 성공 → `data/billing/receipts.json` 에 추가. `receiptKey()` 가 같은 건이 이미
     있으면 **건너뛴다**
   - 실패 → `data/billing/unparsed.json` 에 사유와 함께 남긴다
4. 새로 들어온 `card_last4` 가 `data/billing/cards.json` 에 없으면 **사람에게 묻는다.**
   자동으로 만들지 않는다 — 카드 이름은 추측할 수 없다
5. `kind = 'unknown'` 이 생겼으면 보고한다
6. 증빙 PDF 는 첨부 파일명이 `attachments` 에 남는다. 파일 자체가 필요하면
   Gmail 첨부를 따로 내려받는다

### 이 절차가 지키는 것

- **조용한 0 을 만들지 않는다.** 설정 파일이 깨졌거나 활성 메일함이 하나도 없으면
  `loadBillingConfig()` 가 **던집니다** (표시 이름 매핑과 달리 빈 값으로 넘어가지
  않습니다). 돈 문제에서 "0건입니다" 는 위험한 답입니다.
- **못 가른 건 `unknown` 으로 남깁니다.** 넘겨짚어 `api_usage` 로 떨어뜨리면
  요금제 합계가 조용히 작아지고 아무도 모릅니다.
- **결제 실패는 합계에서 뺍니다.** 나간 돈이 아니라 경보입니다. 다만 지우지는
  않습니다 — 2026-07 에 실제로 카드 한도로 구독이 정지된 적이 있습니다.

## 월별 비교 읽는 법

월별 집계는 `receipts.json` 을 `kind` 로 갈라 더하면 나옵니다. 칸은 넷입니다.

| `kind` | 뜻 |
|---|---|
| `subscription` | 요금제. **쓰든 안 쓰든 나간 돈** |
| `api_usage` | API 후불. 쓴 만큼 |
| `prepaid_topup` | API 선불 충전 |
| `credit_note` | 환불 (음수) |

`failed` 와 `unknown` 은 합계에 넣지 않습니다.

> ⚠️ **선불 충전을 API 사용액과 더하지 마세요.** $10 을 충전해 석 달에 걸쳐 쓰면
> 충전한 달에 $10 이 통째로 잡힙니다. 현금흐름으로는 맞지만 "이 달에 API 를 얼마나
> 썼나" 의 답은 아닙니다. 그 답은 대시보드의 사용량 쪽(Anthropic·OpenAI Admin API)에
> 있고, **그쪽은 추정치입니다.** 둘을 나란히 놓는 게 이 프로젝트의 요점이지 둘을
> 합치는 게 아닙니다.

## 선불 잔액 — "언제 또 충전하나"

`--summary` 를 돌리면 월별 표 아래에 같이 나옵니다.

```
  벤더             주머니   넣은돈      쓴돈      남은돈   소진예상
  Anthropic       API      500.00   353.52   146.48   약 11일
  Anthropic       구독     200.00      ?        ?      —
  OpenAI          API       30.00    27.03     2.97   약 3일
```

### ⚠️ 주머니가 두 개다. 절대 합치지 말 것

2026-08-27 실측으로 Anthropic 선불이 **서로 다른 두 곳**으로 들어가는 걸 확인했습니다.

| 품목 | 주머니 | 무엇을 태우나 | 소진 추적 |
|---|---|---|---|
| `One-time credit purchase` | **API** | API 키 트래픽 | ✅ Admin API 로 보임 |
| `Prepaid extra usage, Individual plan` | **구독** | claude.ai · Claude Code 초과분 | ❌ **볼 방법 없음** |

구독 주머니는 Admin API 에 아예 안 잡힙니다. 그래서 `?` 로 둡니다 —
**0 이 아니라 "모른다"** 는 뜻입니다. 0 으로 두면 "$200 이 그대로 남아 있다" 는
틀린 말이 됩니다.

### ⚠️ 시작 잔액을 모른다

메일함에서 보이는 **첫 충전 이전**에 남아 있던 돈은 알 수 없습니다. 그래서 위
잔액은 "첫 충전 이후로 넣은 돈 − 그 뒤로 쓴 돈" 이고, 실제 잔액은 그 **이상**입니다.
정확한 값이 필요하면 벤더 콘솔의 잔액 화면이 정답입니다.

### 조회 못 하는 벤더

Deep Infra 처럼 사용량 API 가 없는 곳은 넣은 돈만 압니다. 이때도 `?` 입니다 —
`spentByVendor` 에 **키를 아예 넣지 않는 것**으로 "모름" 을 표현합니다. 0 을 넣으면
안 쓴 것처럼 보입니다.
