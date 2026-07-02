import os
import base64
import json
from pathlib import Path
from google.oauth2.credentials import Credentials
from google.auth.transport.requests import Request
from googleapiclient.discovery import build

from email_parser import parse_payout_email
from notion_db import add_payout_row

SCOPES = ["https://www.googleapis.com/auth/gmail.readonly"]
TOKEN_PATH = Path(__file__).parent.parent / "config" / "gmail_token.json"


def get_gmail_service():
    creds = None

    # 환경변수에 토큰 JSON이 있으면 우선 사용 (Railway 배포 환경)
    token_json = os.environ.get("GMAIL_TOKEN_JSON")
    if token_json:
        creds = Credentials.from_authorized_user_info(json.loads(token_json), SCOPES)
    elif TOKEN_PATH.exists():
        creds = Credentials.from_authorized_user_file(str(TOKEN_PATH), SCOPES)

    if not creds or not creds.valid:
        if creds and creds.expired and creds.refresh_token:
            creds.refresh(Request())
            # 갱신된 토큰을 파일에도 저장 (로컬 환경)
            if not os.environ.get("GMAIL_TOKEN_JSON"):
                TOKEN_PATH.write_text(creds.to_json())
        else:
            raise RuntimeError("Gmail 인증 필요: 로컬에서 gmail_token.json 생성 후 GMAIL_TOKEN_JSON 환경변수에 등록하세요.")

    return build("gmail", "v1", credentials=creds)


def fetch_payout_emails(service, max_results: int = 10):
    query = "from:automated@airbnb.com subject:지급"
    result = service.users().messages().list(
        userId="me", q=query, maxResults=max_results
    ).execute()
    return result.get("messages", [])


def get_email_body(service, msg_id: str) -> str:
    msg = service.users().messages().get(
        userId="me", id=msg_id, format="full"
    ).execute()

    payload = msg["payload"]
    parts = payload.get("parts", [payload])

    for part in parts:
        if part.get("mimeType") == "text/plain":
            data = part["body"].get("data", "")
            return base64.urlsafe_b64decode(data).decode("utf-8")
    return ""


def process_new_emails(processed_ids_path: Path = None):
    """새 정산 메일 처리 → Notion 기록"""
    if processed_ids_path is None:
        processed_ids_path = Path(__file__).parent.parent / "logs" / "processed_emails.json"

    processed = set()
    if processed_ids_path.exists():
        processed = set(json.loads(processed_ids_path.read_text()))

    service = get_gmail_service()
    messages = fetch_payout_emails(service)

    newly_processed = []
    for msg in messages:
        msg_id = msg["id"]
        if msg_id in processed:
            continue

        body = get_email_body(service, msg_id)
        payout = parse_payout_email(body)

        if payout:
            for item in payout.items:
                if item.amount < 0:
                    continue
                add_payout_row(
                    payout_date=payout.payout_date,
                    guest_name=item.guest_name,
                    reservation_id=item.reservation_id,
                    property_name=item.property_name,
                    checkin=item.checkin,
                    checkout=item.checkout,
                    amount=item.amount,
                    total_deposit=payout.total_amount,
                )
            print(f"[OK] 메일 {msg_id} → {len(payout.items)}건 Notion 기록 완료")
        else:
            print(f"[SKIP] 메일 {msg_id} 파싱 실패")

        newly_processed.append(msg_id)

    processed.update(newly_processed)
    processed_ids_path.write_text(json.dumps(list(processed), ensure_ascii=False, indent=2))
    return len(newly_processed)


if __name__ == "__main__":
    from dotenv import load_dotenv
    load_dotenv(Path(__file__).parent.parent / "config" / ".env")
    count = process_new_emails()
    print(f"처리 완료: {count}건")
