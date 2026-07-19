"""Gmail OAuth 토큰이 만료/취소되었을 때 재인증하여 config/gmail_token.json을 갱신하는 스크립트.
브라우저가 열리며 Google 로그인 및 동의 화면이 뜬다.
"""
from pathlib import Path
from google_auth_oauthlib.flow import InstalledAppFlow

SCOPES = ["https://www.googleapis.com/auth/gmail.readonly"]
CONFIG_DIR = Path(__file__).parent.parent / "config"
CREDENTIALS_PATH = CONFIG_DIR / "gmail_credentials.json"
TOKEN_PATH = CONFIG_DIR / "gmail_token.json"

if __name__ == "__main__":
    flow = InstalledAppFlow.from_client_secrets_file(str(CREDENTIALS_PATH), SCOPES)
    creds = flow.run_local_server(port=0)
    TOKEN_PATH.write_text(creds.to_json())
    print(f"토큰 갱신 완료: {TOKEN_PATH}")
    print("이 파일 내용을 GMAIL_TOKEN_JSON 환경변수로 Railway에 등록하세요.")
