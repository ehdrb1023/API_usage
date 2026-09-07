# quota — 설치·테스트 안내

Claude Code 정액권(Max·Pro)을 **얼마나 썼고 얼마나 남았는지** 보는 터미널 도구다.
이 문서를 그대로 따라 하면 된다. 10분 안 걸린다.

---

## 먼저 알아둘 것

**아무것도 밖으로 안 나간다.** 이 도구는 당신 PC의 파일 두 곳만 읽는다.

| 읽는 것 | 무엇 |
|---|---|
| `~/.claude/projects/**/*.jsonl` | Claude Code가 남기는 세션 로그 (토큰 수) |
| `~/.claude/.credentials.json` | Claude Code 로그인 토큰 (한도 퍼센트 조회용) |

Anthropic 서버에 한도를 물어보는 것 말고는 네트워크를 안 쓴다.
우리 서버로도, 어디로도 데이터를 보내지 않는다. 기록은 당신 PC의 `~/.claude-quota/`에만 쌓인다.

**API 키는 필요 없다.** 이미 Claude Code로 로그인해 있으면 그걸 그대로 쓴다.

---

## 1. 준비물 확인

터미널에서:

```bash
node -v
```

**v22.18.0 이상**이어야 한다. 낮으면 [nodejs.org](https://nodejs.org)에서 최신 LTS를 받거나 `nvm install 22` 로 올린다.

더 정확히 보려면:

```bash
node -e "console.log(process.version, typeof require('node:module').registerHooks, process.features.typescript)"
```

`v22.x.x function strip` 처럼 나오면 된다. `undefined` 가 보이면 Node를 올려야 한다.

그리고 Claude Code에 로그인되어 있어야 한다. 평소에 쓰고 있으면 이미 되어 있다.

```bash
ls ~/.claude/.credentials.json
```

파일이 보이면 OK.

---

## 2. 설치

```bash
git clone https://github.com/ehdrb1023/API_usage.git
cd API_usage
npm link
```

끝이다. **`npm install` 안 해도 된다** — 이 도구는 외부 패키지를 하나도 안 쓴다.

`npm link`는 `quota` 라는 명령을 어느 폴더에서든 칠 수 있게 링크만 거는 것이다.

> `npm link` 에서 권한 오류가 나면 건너뛰고, 대신 아래처럼 쓴다.
> `node ~/API_usage/bin/quota.mjs meter`
> (아래 모든 `quota` 를 이걸로 바꿔 읽으면 된다)

---

## 3. 첫 실행

```bash
quota
```

오늘 사용량 전체가 뜬다. 세션별·프로젝트별·모델별·도구별.

```bash
quota meter
```

작은 계기판. 지금 세션과 한도만 본다.

```bash
quota web
```

브라우저가 열리고 5초마다 갱신된다. 창을 작게 줄여 구석에 두면 계기판처럼 쓸 수 있다.

---

## 4. 하루 테스트 — 이게 본 테스트다

`quota` 는 "얼마나 썼나"는 바로 보여주지만 **"얼마나 남았나"는 못 보여준다.**
Anthropic이 "9% 썼다"만 알려주고 "총 몇 개 중 9%"인지는 안 알려주기 때문이다.

그래서 직접 잰다. **시간 간격을 두고 두 번 이상** 기록하면 계산이 된다.

```bash
# 아침, 일 시작할 때
quota snap

# ... 평소대로 작업 ...

# 저녁, 마칠 때
quota snap

# 결과
quota report
```

`quota snap` 은 화면에 별거 안 뜬다. 기록만 남긴다. 그게 정상이다.

**간격이 중요하다.** 5분 뒤에 또 찍으면 퍼센트가 안 움직여서 그 기록은 버려진다.
최소 2~3시간은 벌려야 한다. 하루에 2~4번이면 충분하다.

---

## 5. 봐줬으면 하는 것

테스트하면서 이것들을 확인해주면 좋겠다.

**동작**
- [ ] `quota` 가 에러 없이 뜨는가
- [ ] 세션 이름이 실제 하던 작업과 맞는가
- [ ] `quota web` 이 브라우저에서 열리고 숫자가 5초마다 바뀌는가
- [ ] `quota report` 에서 `유효 구간` 이 1개 이상 잡히는가

**숫자**
- [ ] 한도 퍼센트가 Claude Code의 `/usage` 결과와 같은가
- [ ] 세션별 토큰 합이 전체와 맞는가 (`quota` 화면에서 눈으로)

**느낌**
- [ ] 뭐가 안 읽히는지, 뭐가 없는지
- [ ] 터미널(`quota meter --watch`)과 브라우저(`quota web`) 중 어느 쪽이 쓸 만한지

---

## 6. 재는 동안 지킬 것 두 가지

정확한 숫자를 얻으려면:

1. **claude.ai 웹사이트·데스크톱 앱을 안 쓴다.** 같은 한도를 먹는데 로컬 로그에는 안 남아서 계산이 어긋난다.
2. **다른 PC에서 Claude Code를 안 쓴다.** 같은 이유다. 다른 PC 기록은 자동으로 걸러지지만 그 구간은 버려진다.

어겨도 망가지지는 않는다. `quota report` 가 구간별로 사유를 남기니 나중에 골라낼 수 있다.

---

## 7. 명령어 전부

```bash
quota                  # 오늘 보드
quota 7d | 30d         # 구간 보드
quota 7d --watch       # 10초마다 갱신

quota meter            # 계기판 (작은 창용)
quota meter --watch    # 5초마다 갱신
quota meter --list     # 세션 목록
quota meter <검색어>    # 그 세션에 고정 (제목 일부나 id 앞자리)

quota web              # 브라우저 계기판
quota web --port 5000  # 포트 바꾸기

quota snap             # 기록 남기기
quota report           # 1%당 토큰 · 남은 양 추정

quota --help
```

---

## 8. 잘 안 될 때

| 증상 | 원인 · 조치 |
|---|---|
| `quota: command not found` | `npm link` 를 안 했거나 실패. `node ~/API_usage/bin/quota.mjs` 로 직접 실행 |
| `Cannot find module` / 문법 오류 | Node 버전이 낮다. `node -v` 확인 후 22.18 이상으로 |
| `한도 조회 불가 — 인증 만료` | Claude Code를 한 번 실행하면 토큰이 갱신된다 |
| 세션이 하나도 안 보임 | 오늘(한국시간 자정 기준) 작업 기록이 없는 것. `quota 7d` 로 넓혀본다 |
| `quota web` 에서 브라우저가 안 열림 | 터미널에 찍힌 주소를 직접 붙여넣기 |
| 숫자가 이상함 | 그대로 캡처해서 보내달라 — 그게 제일 중요한 제보다 |

---

## 9. 지울 때

```bash
npm unlink -g api-usage-dashboard   # 명령만 제거
rm -rf ~/.claude-quota              # 쌓인 기록 제거
rm -rf ~/API_usage                  # 코드 제거
```

`~/.claude/` 는 Claude Code 것이니 건드리지 않는다.

---

## 참고

배경과 한계(왜 토큰 총량을 못 얻는지, 캐시읽기 문제)는 `docs/subscription-quota.md`.
