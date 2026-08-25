# 미니 위젯 (`/mini`) — 항상 켜두는 창

`/mini` 는 "오늘 얼마 썼나" 만 보여주는 작은 페이지다. 브라우저 앱 모드로 띄우고
Windows 에서 항상 위로 고정하면, 스크린샷의 트레이 숫자처럼 늘 눈에 둘 수 있다.

## 띄우기

```bash
# 1) 데이터 서버가 필요하다 (WSL 쪽에서)
npm run dev

# 2) 다른 터미널에서 — Windows 쪽 브라우저 창이 뜬다
npm run mini
```

배포본이 있으면 서버 없이도 된다.

```bash
npm run mini -- https://<배포주소>/mini
```

창 크기·위치를 바꾸려면 인자를 그대로 넘긴다 (기본값은 오른쪽 아래).

```bash
npm run mini -- http://localhost:3000/mini -Width 340 -Height 240 -X -360 -Y -320
```

`-X`/`-Y` 가 음수면 화면 오른쪽·아래에서부터 잰 거리다. `-NoTopMost` 를 주면
항상 위 고정만 뺀다.

## 부팅할 때 자동으로 띄우기

`Win+R` → `shell:startup` → 아래 내용을 `api-usage-mini.cmd` 로 저장한다.
(`\\wsl$\...` 경로는 배포본을 쓰면 필요 없다 — 그때는 `-Url` 만 배포 주소로.)

```bat
@echo off
powershell -NoProfile -ExecutionPolicy Bypass -File "\\wsl$\Ubuntu\home\martin1023\API_usage\scripts\mini\mini-window.ps1" -Url "https://<배포주소>/mini"
```

## 왜 이렇게 하나

- **앱 모드(`--app=`)** — 주소창·탭·북마크가 사라진 창이 된다. 브라우저 기본 기능이라
  추가 설치가 없다.
- **항상 위** — 브라우저에는 없는 기능이라 `user32.dll` 의 `SetWindowPos` 를 직접
  부른다. AutoHotkey 같은 걸 깔 필요가 없다.
- **전용 프로필(`--user-data-dir`)** — 평소 쓰는 창과 섞이지 않아야 어느 창을 고정할지
  고를 수 있다. 덤으로 위젯이 저장하는 표시 항목 설정도 평소 프로필과 분리된다.

## 트레이 아이콘은 왜 아닌가

작업표시줄 트레이에 숫자 아이콘을 올리려면 Windows 네이티브 앱(예: pystray)을
따로 만들어 Windows 쪽에서 실행해야 한다 — WSL 안에서는 트레이에 접근할 수 없다.
같은 정보를 훨씬 적은 부품으로 볼 수 있어서 앱 모드 창을 택했다. 트레이가 꼭
필요해지면 `/api/live` 를 그대로 폴링하는 작은 Windows 앱을 붙이면 된다.
