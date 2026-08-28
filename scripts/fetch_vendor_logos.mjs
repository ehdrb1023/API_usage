#!/usr/bin/env node
/**
 * 벤더 로고(파비콘)를 `public/vendors/` 에 내려받는다.
 *
 *   node scripts/fetch_vendor_logos.mjs
 *
 * ── 왜 미리 받아 두나 ──────────────────────────────────────────────────────
 * 화면에서 `https://vendor.com/favicon.ico` 를 직접 부르면
 *   1. 벤더 서버가 우리 접속을 보게 되고 (어떤 API 를 쓰는지 새어 나간다)
 *   2. 그 서버가 죽으면 아이콘이 깨지고
 *   3. 사내망·오프라인에서 안 뜬다
 * 그래서 **한 번 받아서 레포에 두고** 정적 파일로 서빙한다.
 *
 * 실패해도 괜찮다 — 화면은 로고가 없으면 글자 이니셜로 떨어진다.
 * 새 벤더를 `config/vendors.json` 에 추가한 뒤 다시 돌리면 된다.
 */

import { mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import path from "node:path";

const OUT_DIR = path.join("public", "vendors");

const { vendors } = JSON.parse(await readFile(path.join("config", "vendors.json"), "utf8"));

await mkdir(OUT_DIR, { recursive: true });
const existing = new Set(await readdir(OUT_DIR).catch(() => []));

/**
 * 파비콘을 찾는 순서. 위에서부터 되는 걸 쓴다.
 * `/favicon.ico` 만 보면 요즘 사이트 상당수가 없어서 빈손이 된다.
 */
const candidates = (v) => [
  // vendors.json 에 `logoUrl` 을 적어 두면 그게 1순위다 (자동 탐색이 실패할 때).
  v.logoUrl,
  `https://${v.domain}/favicon.ico`,
  `https://${v.domain}/favicon.png`,
  `https://${v.domain}/favicon-32x32.png`,
  `https://${v.domain}/apple-touch-icon.png`,
  // 요즘 사이트가 자주 쓰는 하위 경로들.
  `https://${v.domain}/favicon/favicon.ico`,
  `https://${v.domain}/static/favicon.ico`,
  `https://${v.domain}/assets/favicon.ico`,
  `https://${v.domain}/images/favicon.ico`,
  `https://www.${v.domain}/favicon.ico`,
  `https://www.${v.domain}/apple-touch-icon.png`,
].filter(Boolean);

const EXT = { "image/png": "png", "image/x-icon": "ico", "image/vnd.microsoft.icon": "ico", "image/svg+xml": "svg", "image/jpeg": "jpg", "image/webp": "webp" };

let ok = 0, skipped = 0, failed = [];

for (const v of vendors) {
  if (!v.domain) { failed.push(`${v.id} (domain 없음)`); continue; }
  if ([...existing].some((f) => f.startsWith(`${v.id}.`))) { skipped++; continue; }

  let saved = false;
  for (const url of candidates(v)) {
    try {
      const res = await fetch(url, {
        redirect: "follow",
        signal: AbortSignal.timeout(8000),
        // 일부 사이트가 기본 UA 를 막는다.
        headers: { "user-agent": "Mozilla/5.0 (compatible; api-usage-dashboard/1.0)" },
      });
      if (!res.ok) continue;

      const type = (res.headers.get("content-type") ?? "").split(";")[0].trim();
      const ext = EXT[type];
      // HTML 에러 페이지를 200 으로 주는 사이트가 있다. 이미지가 아니면 버린다.
      if (!ext) continue;

      const buf = Buffer.from(await res.arrayBuffer());
      // 1x1 추적 픽셀이나 빈 파일 방지.
      if (buf.length < 100) continue;

      await writeFile(path.join(OUT_DIR, `${v.id}.${ext}`), buf);
      console.log(`  ✅ ${v.id.padEnd(14)} ${ext.padEnd(4)} ${String(buf.length).padStart(7)}B  ${url}`);
      ok++;
      saved = true;
      break;
    } catch {
      // 다음 후보로 넘어간다.
    }
  }
  if (!saved) failed.push(`${v.id} (${v.domain})`);
}

console.log(`\n받음 ${ok} · 이미 있음 ${skipped} · 실패 ${failed.length}`);
if (failed.length) {
  console.log("실패한 벤더 — 로고 없이 이니셜로 표시됩니다:");
  failed.forEach((f) => console.log(`  ${f}`));
  console.log(`\n직접 넣으려면 ${OUT_DIR}/<벤더id>.png 로 저장하세요.`);
}
