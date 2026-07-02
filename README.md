# 에어비앤비 정산 자동화

## 구조
```
은행 입금 문자 (MacroDroid) ──→ /webhook/sms
에어비앤비 정산 메일 (Gmail) ──→ 자동 폴링
                                    ↓
                              Notion 정산 장부
```

## 설치

```bash
cd workspace/sns
pip install -r requirements.txt
```

## 설정

1. `config/.env.example` → `config/.env` 복사 후 값 입력
2. Notion Integration 토큰 발급: https://www.notion.so/my-integrations
3. Gmail API 자격증명 파일 → `config/gmail_credentials.json`

## Notion DB 생성

.env에 `NOTION_PARENT_PAGE_ID` 추가 후:
```bash
python src/setup_notion_db.py
```
출력된 DB ID를 .env의 `NOTION_DATABASE_ID`에 입력

## 서버 실행

```bash
python src/main.py
```

## MacroDroid 설정

- 트리거: SMS 수신 (발신자: 하나은행)
- 액션: HTTP 요청
  - URL: http://서버주소:8000/webhook/sms
  - Method: POST
  - Header: X-Secret: {WEBHOOK_SECRET 값}
  - Body: {"text": "[SMS내용]"}
