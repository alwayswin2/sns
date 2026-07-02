"""
Notion DB 자동 생성 스크립트
실행: python setup_notion_db.py
"""
import os
from pathlib import Path
from dotenv import load_dotenv
from notion_client import Client

load_dotenv(Path(__file__).parent.parent / "config" / ".env")

notion = Client(auth=os.environ["NOTION_TOKEN"])
PARENT_PAGE_ID = os.environ["NOTION_PARENT_PAGE_ID"]  # DB를 만들 상위 페이지 ID


def create_payout_database():
    db = notion.databases.create(
        parent={"type": "page_id", "page_id": PARENT_PAGE_ID},
        title=[{"type": "text", "text": {"content": "에어비앤비 정산 장부"}}],
        properties={
            "게스트명": {"title": {}},
            "정산일": {"date": {}},
            "체크인": {"date": {}},
            "체크아웃": {"date": {}},
            "숙소명": {
                "select": {
                    "options": [
                        {"name": "제주", "color": "blue"},
                        {"name": "서울", "color": "green"},
                        {"name": "부산", "color": "yellow"},
                    ]
                }
            },
            "채널": {
                "select": {
                    "options": [
                        {"name": "에어비앤비", "color": "red"},
                        {"name": "쿠팡", "color": "orange"},
                        {"name": "스마트스토어", "color": "purple"},
                    ]
                }
            },
            "정산금액(원)": {"number": {"format": "won"}},
            "총입금액(문자)": {"number": {"format": "won"}},
            "예약ID": {"rich_text": {}},
            "비고": {"rich_text": {}},
        },
    )
    print(f"[OK] Notion DB 생성 완료!")
    print(f"DB ID: {db['id']}")
    print(f"→ .env 파일의 NOTION_DATABASE_ID 에 위 값을 입력하세요.")
    return db["id"]


if __name__ == "__main__":
    create_payout_database()
