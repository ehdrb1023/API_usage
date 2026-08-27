-- 결제·영수증·요금제 스키마
--
-- 목적은 하나다: **월별로 "요금제로 나간 돈" 과 "API 로 나간 돈" 을 나란히 놓는 것.**
-- 그래서 모든 테이블이 `kind` 를 중심으로 돈다.
--
-- 적용:
--   psql "$SUPABASE_DB_URL" -f supabase/migrations/0001_billing.sql
--   (또는 Supabase 대시보드 → SQL Editor 에 붙여넣기)
--
-- ⚠️ 이 스키마는 **조직 내부 재무 데이터**다. 고객사 프로젝트 DB 에 넣지 말 것.
--    전용 프로젝트나 최소한 전용 스키마에 둔다.

create schema if not exists billing;

-- ============================================================ 카드

-- 어떤 카드로 냈는지. 영수증에는 끝 4자리만 오므로 **4자리가 곧 식별자**다.
--
-- ⚠️ 4자리는 유일하지 않다. 서로 다른 카드가 같은 4자리를 가질 수 있다. 그런 일이
--    생기면 `label` 로 사람이 구분해야 하고, 그래서 unique 를 걸지 않았다.
--    지금은 4411 하나뿐이라 문제가 없지만 카드가 늘면 확인이 필요하다.
create table if not exists billing.cards (
  id           bigint generated always as identity primary key,
  last4        text        not null check (last4 ~ '^[0-9]{4}$'),
  label        text        not null,          -- "법인 신한 001", "개인 국민"
  holder       text,                          -- 명의자
  issuer       text,                          -- 카드사
  is_corporate boolean     not null default true,
  active       boolean     not null default true,
  note         text,
  created_at   timestamptz not null default now()
);

comment on table billing.cards is
  '영수증의 끝 4자리를 사람이 아는 카드 이름으로 잇는다. 4자리는 유일하지 않다.';

-- ============================================================ 영수증

-- 결제 메일에서 뽑아낸 실제 청구 건. **대시보드의 추정 비용과 다른 세계다** —
-- 이쪽은 실제로 빠져나간 돈이라 손대면 안 된다.
create table if not exists billing.receipts (
  id              bigint generated always as identity primary key,

  -- 중복 판정 키 (lib/billing/types.ts 의 receiptKey()).
  -- ⚠️ **메일함이 키에 없다.** 메일함을 갈아타는 동안 같은 영수증이 두 주소로
  --    들어와도 한 건으로 합쳐져야 하기 때문이다. 넣으면 매출이 두 번 계상된다.
  dedupe_key      text        not null unique,

  vendor          text        not null,
  kind            text        not null check (kind in (
                    'subscription',   -- 월 구독. 쓰든 안 쓰든 나간다
                    'api_usage',      -- API 후불. 쓴 만큼 나간다
                    'prepaid_topup',  -- API 선불 충전. 나간 시점 ≠ 쓰는 시점
                    'credit_note',    -- 환불. amount 가 음수
                    'failed',         -- 결제 실패. 합계에서 뺀다
                    'unknown'         -- 규칙이 못 가름. 사람이 봐야 한다
                  )),

  paid_on         date        not null,       -- 본문에 적힌 결제일 (수신일 아님)
  amount          numeric(12,4) not null,     -- 환불이면 음수
  currency        text        not null default 'USD',

  receipt_number  text,
  invoice_number  text,
  line_item       text,                       -- "Max plan - 20x" 등 원문
  period_start    date,                       -- 구독에만 있다
  period_end      date,

  card_last4      text check (card_last4 ~ '^[0-9]{4}$'),
  payment_method  text,                       -- "Link", "- 4411" 원문

  -- ── 출처 ── 메일함을 갈아타도 과거 이력의 출처를 설명할 수 있어야 한다.
  source_mailbox    text not null,
  source_message_id text not null,
  source_sender     text not null,
  source_subject    text,
  attachments       text[] not null default '{}',

  collected_at    timestamptz not null default now()
);

create index if not exists receipts_paid_on_idx  on billing.receipts (paid_on desc);
create index if not exists receipts_vendor_idx   on billing.receipts (vendor, kind);
-- 사람이 봐야 할 것만 빠르게 뽑는다.
create index if not exists receipts_unknown_idx  on billing.receipts (kind)
  where kind = 'unknown';

comment on column billing.receipts.dedupe_key is
  '벤더가 매긴 번호가 있으면 그것, 없으면 (벤더·날짜·금액·카드). 메일함은 일부러 뺐다.';

-- ============================================================ 요금제

-- 지금 붙어 있는 월 구독 목록. 영수증과 따로 두는 이유:
--   1. 아직 청구가 안 된 요금제도 알아야 한다 (이번 달 예상액)
--   2. 해지한 요금제의 과거 영수증은 남아야 하지만 "지금 내는 것" 에서는 빠져야 한다
create table if not exists billing.subscriptions (
  id            bigint generated always as identity primary key,
  vendor        text        not null,
  plan          text        not null,          -- "Max plan - 20x", "ChatGPT Pro"
  monthly_amount numeric(12,4) not null,
  currency      text        not null default 'USD',
  billing_day   smallint    check (billing_day between 1 and 31),
  started_on    date        not null,
  ended_on      date,                          -- null 이면 사용 중
  card_id       bigint      references billing.cards (id),
  note          text,
  created_at    timestamptz not null default now()
);

create index if not exists subscriptions_active_idx on billing.subscriptions (vendor)
  where ended_on is null;

-- ============================================================ 메일 수집 이력

-- 못 읽은 메일을 **조용히 버리지 않기 위한** 표. 파서가 실패하면 여기 남고,
-- 새 벤더나 바뀐 템플릿을 사람이 발견할 수 있다.
create table if not exists billing.unparsed_mail (
  id            bigint generated always as identity primary key,
  source_mailbox text       not null,
  message_id    text        not null unique,
  sender        text        not null,
  subject       text,
  received_at   timestamptz,
  reason        text        not null,
  seen_at       timestamptz not null default now()
);

-- ============================================================ 월별 비교

-- **이 대시보드가 답하려는 질문이 이 뷰 하나다.**
-- "이번 달 요금제로 얼마, API 로 얼마 썼나."
--
-- ⚠️ 선불 충전(prepaid_topup)은 **나간 시점과 쓰는 시점이 다르다.** $10 을 충전해
--    석 달에 걸쳐 쓰면 충전한 달에 $10 이 통째로 잡힌다. 현금흐름으로는 맞고
--    사용량 대비로는 틀리다 — 그래서 api_usage 와 합치지 않고 따로 세운다.
--
-- ⚠️ 결제 실패(failed)는 나간 돈이 아니라 경보다. 합계에서 뺀다.
create or replace view billing.monthly as
select
  date_trunc('month', paid_on)::date                                as month,
  vendor,
  sum(amount) filter (where kind = 'subscription')                  as subscription_usd,
  sum(amount) filter (where kind = 'api_usage')                     as api_usage_usd,
  sum(amount) filter (where kind = 'prepaid_topup')                 as prepaid_topup_usd,
  sum(amount) filter (where kind = 'credit_note')                   as credit_note_usd,
  sum(amount) filter (where kind not in ('failed', 'unknown'))      as total_usd,
  count(*)    filter (where kind = 'unknown')                       as unknown_count,
  count(*)    filter (where kind = 'failed')                        as failed_count
from billing.receipts
group by 1, 2;

comment on view billing.monthly is
  '월별 요금제 vs API 비교. 선불 충전은 시점이 어긋나므로 api_usage 와 합치지 않는다.';

-- ============================================================ 접근 제어

-- 내부 재무 데이터다. anon·authenticated 에게 열지 않는다 —
-- RLS 를 켜고 정책을 **하나도 만들지 않으면** service_role 만 읽고 쓸 수 있다.
alter table billing.cards         enable row level security;
alter table billing.receipts      enable row level security;
alter table billing.subscriptions enable row level security;
alter table billing.unparsed_mail enable row level security;

revoke all on all tables in schema billing from anon, authenticated;
