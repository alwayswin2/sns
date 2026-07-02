import os
from notion_client import Client
from datetime import datetime


notion = Client(auth=os.environ["NOTION_TOKEN"])
DATABASE_ID = os.environ["NOTION_DATABASE_ID"]


def add_payout_row(
    payout_date: str,        # "2026-07-08"
    guest_name: str,         # "HMGANYRYZK"
    reservation_id: str,     # "170089..."
    property_name: str,      # "제주"
    checkin: str,            # "2026-07-01"
    checkout: str,           # "2026-07-02"
    amount: int,             # 72498
    total_deposit: int,      # 68873 (문자 기준 총입금액)
    note: str = "",
):
    notion.pages.create(
        parent={"database_id": DATABASE_ID},
        properties={
            "정산일": {
                "date": {"start": payout_date}
            },
            "게스트명": {
                "title": [{"text": {"content": guest_name}}]
            },
            "예약ID": {
                "rich_text": [{"text": {"content": reservation_id}}]
            },
            "숙소명": {
                "select": {"name": property_name}
            },
            "체크인": {
                "date": {"start": checkin}
            },
            "체크아웃": {
                "date": {"start": checkout}
            },
            "입금액": {
                "number": total_deposit
            },
            "채널": {
                "select": {"name": "에어비앤비"}
            },
            "비고": {
                "rich_text": [{"text": {"content": note}}]
            },
        },
    )


def add_deposit_row(
    deposit_date: str,    # "2026-07-08"
    total_amount: int,    # 68873
    raw_sms: str,         # 원문 문자
):
    """은행 입금 문자 단독 기록 (이메일 매칭 전 임시 저장)"""
    notion.pages.create(
        parent={"database_id": DATABASE_ID},
        properties={
            "정산일": {
                "date": {"start": deposit_date}
            },
            "게스트명": {
                "title": [{"text": {"content": "(입금 확인 대기)"}}]
            },
            "총입금액(문자)": {
                "number": total_amount
            },
            "채널": {
                "select": {"name": "에어비앤비"}
            },
            "비고": {
                "rich_text": [{"text": {"content": f"[SMS] {raw_sms}"}}]
            },
        },
    )
