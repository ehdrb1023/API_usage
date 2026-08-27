# speciai.kr 서브도메인 운영

**앞으로 새로 만드는 서비스는 전부 `speciai.kr` 아래 서브도메인으로 붙인다.**
(예: `api.speciai.kr`)

## 0. 지금 상태 (2026-08-27 실측)

| | |
|---|---|
| apex | `speciai.kr` → A `76.76.21.21` (Vercel) |
| 네임서버 | `ns1~4.hosting.co.kr` — **hosting.kr 이 DNS 를 갖고 있다** |
| Vercel 팀 | `kimlawtech's projects` (`team_C0AdBRyMHlgH9ZIS4AbT253T`) |
| apex 를 서빙하는 프로젝트 | `trend` (`www`·`speciai.ai.kr` 도 여기로 리다이렉트) |
| 이미 붙은 서브도메인 | `linktalk.speciai.kr` → `speciai-kakao-bot` |

> ⚠️ **기존 서비스 대부분은 `speciai.team` 을 쓰고 있습니다** — `cowork`, `studio`,
> `lawsync`, `agent`, `114`, `devcowork` 등. 새 정책은 `.kr` 이므로 지금은 두 도메인이
> 섞여 있는 상태입니다. 옮길지 그대로 둘지는 별도 결정이 필요합니다
> (§6 참고 — 그냥 옮기면 기존 링크가 깨집니다).

## 1. 이름 규칙

- 소문자·숫자·하이픈만. **한 단계만** (`a.b.speciai.kr` 금지 — 와일드카드 인증서가
  한 단계까지만 덮습니다)
- 서비스가 하는 일로 짓는다. 회사 내부 코드명 말고
- 짧게. `api`, `cost`, `crm`, `board`

## 2. 붙이는 절차

### 2-1. Vercel 쪽 (자동)

```bash
node scripts/attach_subdomain.mjs <서브도메인> <프로젝트>
node scripts/attach_subdomain.mjs api api-usage
```

붙이기 전에 상태만 보려면 `--check` 를 붙입니다.

스크립트가 먼저 확인하는 것:

1. `speciai.kr` 가 이 팀에 있는가
2. **대상 프로젝트가 같은 팀에 있는가** ← 여기서 제일 많이 걸립니다 (§4)
3. 그 서브도메인을 다른 프로젝트가 이미 쓰고 있지 않은가

### 2-2. DNS 쪽 (수동 — 자동화 불가)

hosting.kr 은 공개 API 가 없고 구글 계정 로그인이라 **자동화가 안 됩니다.**
스크립트가 넣을 값을 정확히 찍어 주니 그대로 옮겨 적으면 됩니다.

```
로그인 : https://hosting.kr  →  구글 계정으로 로그인 → speciai250331@gmail.com
경로   : 마이페이지 → 도메인 → speciai.kr → DNS 설정

타입   : CNAME
호스트 : api                    ← 앞부분만
값     : cname.vercel-dns.com.  ← 끝 점 포함
TTL    : 3600
```

> ⚠️ **호스트 칸에 `api.speciai.kr` 를 통째로 넣지 마세요.** hosting.kr 이 apex 를
> 자동으로 붙여서 `api.speciai.kr.speciai.kr` 이 됩니다. 앞부분(`api`)만 넣습니다.

> ⚠️ **apex(`speciai.kr` 자체)는 CNAME 이 아니라 A 레코드 `76.76.21.21`** 입니다.
> DNS 규격상 apex 에는 CNAME 을 못 답니다. 서브도메인만 CNAME 입니다.

### 2-3. 확인

전파는 보통 5~30분입니다.

```bash
nslookup -type=CNAME api.speciai.kr        # cname.vercel-dns.com 이 나와야 함
node scripts/attach_subdomain.mjs api api-usage --check
```

## 3. 새 서비스 만들 때 순서

1. Vercel 프로젝트를 **`kimlawtech's projects` 팀에** 만든다 (§4)
2. 배포한다
3. **공개해도 되는 서비스인지 판단한다** (§5) — 아니면 보호부터 켠다
4. `attach_subdomain.mjs` 실행
5. hosting.kr 에 CNAME 추가
6. `--check` 로 확인

## 4. 가장 흔한 함정 — 팀이 다르면 안 붙습니다

**Vercel 도메인은 팀에 묶여 있습니다.** `speciai.kr` 는 `kimlawtech's projects` 팀
소유이므로, **다른 팀에 있는 프로젝트에는 붙일 수 없습니다.**

이 레포가 지금 딱 그 상태입니다:

```
.vercel/project.json → api-usage,  팀 team_6eAGhw1JOZdjD9cr6n3VMSSp
.env VERCEL_TEAM_ID  →             팀 team_C0AdBRyMHlgH9ZIS4AbT253T  (speciai.kr 소유)
                                   ↑ 서로 다름
```

현재 토큰으로 `team_6eAGhw…` 를 조회하면 **403** 입니다 — 접근 권한이 없습니다.

**다만 팀이 달라도 붙일 수는 있습니다.** Vercel 은 다른 팀 소유 도메인이어도
`_vercel` TXT 레코드로 소유권을 증명하면 서브도메인을 받아 줍니다. 그때는 CNAME
전에 TXT 를 먼저 넣어야 하고, 스크립트가 그 값을 출력합니다
("먼저 아래 검증 레코드를 넣어야 합니다").

정리하면 선택지는 셋입니다.

- **그 팀 토큰으로 붙인다** — `api-usage` 가 있는 팀 scope 로 토큰을 발급해
  `.env` 의 `VERCEL_API_TOKEN`·`VERCEL_TEAM_ID` 를 바꾸고, TXT 검증 레코드를 거쳐
  붙인다. 프로젝트를 안 건드려도 됩니다.
- **프로젝트를 도메인이 있는 팀으로** — `kimlawtech's projects` 에서 새로 만들어
  배포하고 `.vercel/project.json` 을 다시 링크한다. 다른 서비스 61개가 전부 이 팀에
  있으므로 장기적으로는 이쪽이 깔끔합니다.
- **도메인을 프로젝트가 있는 팀으로** — `speciai.kr` 를 통째로 옮긴다. 이미 붙어 있는
  `speciai.kr`·`www`·`linktalk` 이 전부 영향을 받으므로 **권합니다: 하지 마세요.**

## 5. ⚠️ 공개 전에 — 이 대시보드는 인증이 없습니다

`api.speciai.kr` 를 그냥 붙이면 **주소를 아는 사람 누구나** 다음을 봅니다.

- 조직 전체 AI 지출액
- **거래처별 API 키 이름** — 실제로 `lawsync`, `devcowork`, `legalmask`, `yulam`,
  `Gccity`, `crm` 같은 **고객사·프로젝트 이름이 그대로 화면에 뜹니다**
- 모델별·일자별 사용 패턴

법률 쪽 고객사 이름이 섞여 있어 그냥 공개할 성격이 아닙니다. 붙이기 전에 셋 중
하나를 정하세요.

### ⚠️ Vercel 기본값이 함정입니다

실측 결과(2026-08-27), Vercel 프로젝트의 기본 보호 설정은 이렇습니다.

```
ssoProtection: { "deploymentType": "all_except_custom_domains" }
                                    ^^^^^^^^^^^^^^^^^^^^^^^^^^
```

**프리뷰 배포만 막고 커스텀 도메인은 엽니다.** 즉 서브도메인을 붙이는 순간
보호 밖으로 나갑니다. 대시보드에서 "Standard Protection" 으로 보이는 게 이 값입니다.

커스텀 도메인까지 덮으려면 `deploymentType` 이 **`all`** 이어야 합니다.

```bash
node scripts/attach_subdomain.mjs <서브도메인> <프로젝트> --protect
```

대시보드로 하려면 Settings → Deployment Protection → Vercel Authentication →
**All Deployments** 를 고릅니다.

| 방법 | 커스텀 도메인 보호 | 비고 |
|---|---|---|
| Standard Protection (기본) | ❌ **안 됨** | 프리뷰만 막습니다 |
| Vercel Authentication + All Deployments | ✅ | 팀 멤버 로그인 필요. **내부용 정답** |
| Password Protection + All Deployments | ✅ | 비밀번호 공유. 팀 밖 사람도 줄 때 |
| 앱에 인증 추가 | ✅ | 코드 작업. 외부에 일부만 열 때 |

확인:

```bash
node scripts/attach_subdomain.mjs <서브도메인> <프로젝트> --check
# → "접근 보호: SSO={...}" 줄에서 deploymentType 을 봅니다

## 6. `speciai.team` 은 어떻게 하나

기존 서비스 대부분이 `.team` 에 있습니다. 새 정책이 `.kr` 이라고 해서 **그냥 옮기면
안 됩니다** — 기존 링크·북마크·외부 참조가 전부 깨집니다.

옮긴다면 순서는 이렇습니다.

1. `.kr` 서브도메인을 **추가**로 붙인다 (둘 다 동작하게)
2. 한동안 둘 다 유지하며 참조를 `.kr` 로 바꾼다
3. `.team` 쪽을 `.kr` 로 **301 리다이렉트**로 전환한다 (Vercel 프로젝트 도메인 설정에서
   redirect 대상 지정)
4. 충분히 지난 뒤에만 뗀다

지금 당장은 **새로 만드는 것만 `.kr`** 로 하고 기존 것은 두는 게 안전합니다.
