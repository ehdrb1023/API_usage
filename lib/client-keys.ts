import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * `config/client-keys.json` — 팀이 직접 관리하는 **api_key_id → 표시 이름** 매핑.
 *
 * 대시보드 "서비스별 사용량" 표에서 Console 키 이름 대신 띄울 이름을 코드 수정 없이
 * 정하기 위한 파일이다. 형식·작성법은 `config/README.md` 참고.
 *
 * ⚠️ 여기는 `lib/clients/` (벤더 HTTP 클라이언트)가 아니다. 네트워크를 타지 않고
 *    로컬 파일만 읽는다. 이름이 비슷해서 헷갈리기 쉬우니 주의.
 *
 * 서버에서만 실행된다 (fs 접근). 클라이언트 컴포넌트에서 import 금지.
 */

export type ClientKeyNames = Record<string, string>;

export const CLIENT_KEYS_FILE = path.join("config", "client-keys.json");

/**
 * 매핑을 읽어 온다. **어떤 이유로든 실패하면 빈 매핑을 돌려준다** — 표시 이름은
 * 부가 정보라, 파일 하나 때문에 대시보드 전체가 죽으면 안 된다. 대신 원인을
 * 서버 콘솔에 `[client-keys]` 로 남긴다.
 *
 * 캐시하지 않는다. 파일이 작고, 저장하면 새로고침만으로 반영되는 편이 팀이 쓰기 좋다.
 */
export async function loadClientKeyNames(): Promise<ClientKeyNames> {
  const file = path.join(process.cwd(), CLIENT_KEYS_FILE);

  let text: string;
  try {
    text = await fs.readFile(file, "utf8");
  } catch (error) {
    // 파일이 아예 없는 건 정상 상태다 (아직 안 만들었거나 매핑을 안 쓰는 경우).
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
      warn(`${CLIENT_KEYS_FILE} 를 읽지 못했습니다.`, error);
    }
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    warn(
      `${CLIENT_KEYS_FILE} 의 JSON 문법이 틀렸습니다. 매핑을 전부 무시하고 ` +
        `Console 키 이름으로 표시합니다.`,
      error,
    );
    return {};
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    warn(
      `${CLIENT_KEYS_FILE} 는 { "api_key_id": "표시할 이름" } 형태의 객체여야 합니다.`,
    );
    return {};
  }

  const names: ClientKeyNames = {};
  for (const [apiKeyId, name] of Object.entries(parsed as Record<string, unknown>)) {
    // 값이 문자열이 아니거나 비었으면 그 줄만 버린다. 나머지 매핑은 살린다.
    if (typeof name !== "string" || name.trim() === "") {
      warn(
        `${CLIENT_KEYS_FILE}: "${apiKeyId}" 의 값이 비어 있거나 문자열이 아닙니다. ` +
          `이 항목만 건너뜁니다.`,
      );
      continue;
    }
    names[apiKeyId] = name.trim();
  }

  return names;
}

function warn(message: string, error?: unknown) {
  const detail = error instanceof Error ? ` (${error.message})` : "";
  console.warn(`[client-keys] ${message}${detail}`);
}
