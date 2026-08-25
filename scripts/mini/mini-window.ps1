<#
.SYNOPSIS
  /mini 를 테두리 없는 작은 창으로 띄우고 항상 위에 고정한다.

.DESCRIPTION
  브라우저를 앱 모드(--app=)로 띄우면 주소창·탭·북마크가 없는 창이 된다.
  거기까지는 브라우저가 해 주지만 "항상 위" 는 브라우저에 없는 기능이라
  user32.dll 의 SetWindowPos 를 직접 부른다. AutoHotkey 같은 추가 설치가 필요 없다.

  ⚠️ WSL 에서 `npm run dev` 로 띄운 서버를 볼 거라면 그 서버가 켜져 있어야 한다.
     WSL2 는 localhost 를 Windows 쪽으로 넘겨주므로 주소는 그대로 localhost:3000 이다.
     Vercel 에 배포했다면 -Url 로 배포 주소를 넘기면 서버 없이도 뜬다.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File mini-window.ps1
  powershell -ExecutionPolicy Bypass -File mini-window.ps1 -Url https://my-app.vercel.app/mini -Width 320
#>

param(
  [string]$Url = "http://localhost:3000/mini",
  [int]$Width = 300,
  [int]$Height = 190,
  # 기본 위치는 화면 오른쪽 아래 (작업표시줄 위). 음수면 오른쪽·아래에서부터 잰다.
  [int]$X = -320,
  [int]$Y = -290,
  [switch]$NoTopMost
)

$ErrorActionPreference = "Stop"
# WSL 터미널로 넘어가는 한글이 깨지지 않도록.
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

# ---------------------------------------------------------------- 브라우저 찾기

$candidates = @(
  "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
  "${env:ProgramFiles}\Microsoft\Edge\Application\msedge.exe",
  "${env:ProgramFiles}\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe"
)
$browser = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $browser) { throw "Edge 나 Chrome 을 찾지 못했습니다. -Url 을 일반 브라우저에서 여세요." }

# ---------------------------------------------------------------- 위치 계산

Add-Type -AssemblyName System.Windows.Forms
$screen = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
if ($X -lt 0) { $X = $screen.Right + $X }
if ($Y -lt 0) { $Y = $screen.Bottom + $Y }

# ---------------------------------------------------------------- 띄우기

# 전용 프로필을 쓰는 이유: 평소 쓰는 브라우저 창과 섞이지 않아야 창을 골라 고정할 수
# 있고, 위젯이 저장하는 표시 항목(localStorage)도 평소 프로필과 분리된다.
$profileDir = Join-Path $env:LOCALAPPDATA "api-usage-mini"

$browserArgs = @(
  "--app=$Url",
  "--window-size=$Width,$Height",
  "--window-position=$X,$Y",
  "--user-data-dir=$profileDir",
  "--no-first-run",
  "--no-default-browser-check"
)
$proc = Start-Process -FilePath $browser -ArgumentList $browserArgs -PassThru

if ($NoTopMost) { exit 0 }

# ---------------------------------------------------------------- 항상 위 고정

Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class Win32 {
  [DllImport("user32.dll")]
  public static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
}
"@

$HWND_TOPMOST  = [IntPtr](-1)
$SWP_NOSIZE    = 0x0001
$SWP_NOMOVE    = 0x0002
$SWP_NOACTIVATE = 0x0010

# 창이 만들어질 때까지 기다린다. 앱 모드는 보통 1초 안쪽인데, 브라우저가 완전히
# 꺼져 있던 상태면 프로필 초기화 때문에 더 걸린다.
$hwnd = [IntPtr]::Zero
foreach ($i in 1..40) {
  Start-Sleep -Milliseconds 250
  $proc.Refresh()
  if ($proc.MainWindowHandle -ne [IntPtr]::Zero) { $hwnd = $proc.MainWindowHandle; break }

  # Edge/Chrome 은 기존 프로세스에 창만 붙이는 경우가 있어 PID 가 달라질 수 있다.
  $alt = Get-Process -Name (Get-Item $browser).BaseName -ErrorAction SilentlyContinue |
         Where-Object { $_.MainWindowTitle -and $_.MainWindowHandle -ne [IntPtr]::Zero } |
         Sort-Object StartTime -Descending | Select-Object -First 1
  if ($alt) { $hwnd = $alt.MainWindowHandle; break }
}

if ($hwnd -eq [IntPtr]::Zero) {
  Write-Warning "창을 찾지 못해 '항상 위' 고정을 건너뜁니다. 창 자체는 떠 있습니다."
  exit 0
}

[void][Win32]::SetWindowPos($hwnd, $HWND_TOPMOST, 0, 0, 0, 0, $SWP_NOSIZE -bor $SWP_NOMOVE -bor $SWP_NOACTIVATE)
Write-Host "미니 위젯을 항상 위로 고정했습니다. ($Url)"
