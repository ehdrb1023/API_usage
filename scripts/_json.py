#!/usr/bin/env python3
"""JSON 처리 헬퍼.

jq 의존성을 없애기 위한 것 (이 환경에 jq 가 없고 sudo 도 불가).
표준 라이브러리만 사용한다.

subcommands:
  page-info <file>          -> "<has_more>\\t<next_page>" 출력
  merge-pages <out> <meta_json> <page_file...>
                            -> 각 페이지의 data 배열을 이어붙여 <out> 에 저장,
                               버킷 개수를 stdout 으로 출력
  jsonl-to-json <in> <out>  -> JSONL 을 JSON 배열로 변환, 레코드 수를 stdout 으로 출력
"""
import json
import sys


def page_info(path):
    with open(path, encoding="utf-8") as f:
        doc = json.load(f)
    has_more = "true" if doc.get("has_more") else "false"
    next_page = doc.get("next_page") or ""
    print(f"{has_more}\t{next_page}")


def merge_pages(out_path, meta_json, page_paths):
    buckets = []
    for p in page_paths:
        with open(p, encoding="utf-8") as f:
            doc = json.load(f)
        buckets.extend(doc.get("data") or [])

    meta = json.loads(meta_json)
    meta["pages_fetched"] = len(page_paths)

    merged = {
        "data": buckets,
        "has_more": False,
        "next_page": None,
        "_meta": meta,
    }
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(merged, f, indent=2, ensure_ascii=False)
        f.write("\n")
    print(len(buckets))


def jsonl_to_json(in_path, out_path):
    records = []
    with open(in_path, encoding="utf-8") as f:
        for lineno, line in enumerate(f, 1):
            line = line.strip()
            if not line:
                continue
            try:
                records.append(json.loads(line))
            except json.JSONDecodeError as e:
                # 스트림이 중간에 끊긴 경우를 조용히 넘기지 않는다.
                print(f"경고: {lineno}행 파싱 실패: {e}", file=sys.stderr)
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(records, f, indent=2, ensure_ascii=False)
        f.write("\n")
    print(len(records))


def main():
    if len(sys.argv) < 2:
        print(__doc__, file=sys.stderr)
        return 2
    cmd = sys.argv[1]
    if cmd == "page-info":
        page_info(sys.argv[2])
    elif cmd == "merge-pages":
        merge_pages(sys.argv[2], sys.argv[3], sys.argv[4:])
    elif cmd == "jsonl-to-json":
        jsonl_to_json(sys.argv[2], sys.argv[3])
    else:
        print(f"알 수 없는 명령: {cmd}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
