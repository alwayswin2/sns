import os
from pathlib import Path
from dotenv import load_dotenv

load_dotenv(Path(__file__).parent.parent / "config" / ".env")

from fastapi import FastAPI, Request, HTTPException, Header
from fastapi.responses import JSONResponse
from email_parser import parse_sms
from notion_db import add_deposit_row
from gmail_watcher import process_new_emails

app = FastAPI(title="에어비앤비 정산 자동화")

WEBHOOK_SECRET = os.environ.get("WEBHOOK_SECRET", "")


@app.get("/")
def health():
    return {"status": "ok", "service": "airbnb-payout-automation"}


@app.post("/webhook/sms")
async def receive_sms(request: Request, x_secret: str = Header(default="")):
    """MacroDroid에서 은행 입금 문자 수신"""
    if WEBHOOK_SECRET and x_secret != WEBHOOK_SECRET:
        raise HTTPException(status_code=401, detail="인증 실패")

    import json as _json
    raw = await request.body()
    for enc in ("utf-8", "cp949", "euc-kr"):
        try:
            body = _json.loads(raw.decode(enc))
            sms_text = body.get("text", "")
            break
        except Exception:
            sms_text = ""
    if not sms_text:
        sms_text = raw.decode("utf-8", errors="ignore")

    if not sms_text:
        raise HTTPException(status_code=400, detail="문자 내용 없음")

    print(f"[SMS 수신] text={repr(sms_text)}")
    parsed = parse_sms(sms_text)
    if not parsed:
        return JSONResponse({"status": "skip", "reason": "입금 문자 아님", "received": sms_text})

    # Notion에 임시 기록
    add_deposit_row(
        deposit_date=parsed["date"],
        total_amount=parsed["amount"],
        raw_sms=parsed["raw"],
    )

    # 동시에 새 정산 메일도 처리
    try:
        processed = process_new_emails()
        return JSONResponse({
            "status": "ok",
            "sms_amount": parsed["amount"],
            "emails_processed": processed,
        })
    except Exception as e:
        return JSONResponse({
            "status": "partial",
            "sms_amount": parsed["amount"],
            "email_error": str(e),
        })


@app.post("/webhook/check-emails")
async def check_emails(x_secret: str = Header(default="")):
    """수동으로 메일 확인 트리거"""
    if WEBHOOK_SECRET and x_secret != WEBHOOK_SECRET:
        raise HTTPException(status_code=401, detail="인증 실패")

    count = process_new_emails()
    return {"status": "ok", "processed": count}


if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", 8000))
    uvicorn.run("main:app", host="0.0.0.0", port=port, reload=True)
