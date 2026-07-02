"""Notion DB의 모든 항목을 삭제(archive)하고 processed_emails.json을 초기화"""
import os
import json
from pathlib import Path
from dotenv import load_dotenv

load_dotenv(Path(__file__).parent.parent / "config" / ".env")

from notion_client import Client

notion = Client(auth=os.environ["NOTION_TOKEN"])
DATABASE_ID = os.environ["NOTION_DATABASE_ID"]


def delete_all_rows():
    deleted = 0
    has_more = True
    next_cursor = None

    while has_more:
        kwargs = {"database_id": DATABASE_ID, "page_size": 100}
        if next_cursor:
            kwargs["start_cursor"] = next_cursor

        result = notion.databases.query(**kwargs)
        pages = result.get("results", [])

        for page in pages:
            notion.pages.update(page["id"], archived=True)
            deleted += 1
            print(f"  삭제: {page['id']}")

        has_more = result.get("has_more", False)
        next_cursor = result.get("next_cursor")

    return deleted


if __name__ == "__main__":
    print("Notion DB 항목 삭제 중...")
    count = delete_all_rows()
    print(f"총 {count}건 삭제 완료")

    log_path = Path(__file__).parent.parent / "logs" / "processed_emails.json"
    log_path.write_text("[]", encoding="utf-8")
    print("processed_emails.json 초기화 완료")
    print("\n이제 python src/gmail_watcher.py 를 실행하면 재처리됩니다.")
