# 설치 안내서 (비개발자용)

에어비앤비 정산 메일을 Notion 장부에 자동으로 기록하는 시스템입니다.
Google Apps Script 하나로 동작하며, **서버도 결제도 필요 없습니다.**

전체 소요 시간: 약 20분.

---

## 준비물

1. 정산 메일을 받는 **구글 계정** (지금 Gmail 을 쓰는 그 계정)
2. **Notion 통합(Integration) 토큰**
3. **Notion 데이터베이스 ID** (기존 "에어비앤비 정산 장부")

---

## 1단계 — Notion 토큰 준비

기존 시스템에서 쓰던 값을 그대로 쓰면 됩니다. 새로 만들려면:

1. https://www.notion.so/my-integrations 접속
2. **New integration** → 이름 아무거나(예: `정산 자동화`) → 저장
3. **Internal Integration Secret** 값을 복사 (`ntn_` 또는 `secret_` 으로 시작)
4. Notion 에서 정산 장부 페이지 열기 → 우측 상단 `···` → **연결 추가** → 방금 만든 통합 선택

> 이 단계를 빼먹으면 나중에 "could not find database" 오류가 납니다.

**데이터베이스 ID 찾기**: 장부를 브라우저에서 열면 주소가
`https://www.notion.so/xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx?v=...` 형태입니다.
`?v=` 앞의 32자리가 데이터베이스 ID 입니다.

---

## 2단계 — Apps Script 프로젝트 만들기

1. https://script.google.com 접속 (정산 메일 받는 계정으로 로그인)
2. **새 프로젝트** 클릭
3. 좌측 상단 프로젝트 이름을 `에어비앤비 정산 자동화` 로 변경

### 파일 넣기

기본으로 있는 `코드.gs` 파일 하나를 지우고, 아래 9개 파일을 만듭니다.
왼쪽 **파일** 옆 `+` → **스크립트**를 눌러 이름을 입력하고,
이 저장소 `gas/` 폴더의 같은 이름 파일 내용을 복사해 붙여 넣으세요.

| 만들 파일 이름 | 내용을 가져올 파일 |
|---|---|
| `Config` | `gas/Config.gs` |
| `AirbnbParser` | `gas/AirbnbParser.gs` |
| `ProcessingState` | `gas/ProcessingState.gs` |
| `NotionService` | `gas/NotionService.gs` |
| `GmailService` | `gas/GmailService.gs` |
| `Monitoring` | `gas/Monitoring.gs` |
| `Main` | `gas/Main.gs` |
| `SmsWebhook` | `gas/SmsWebhook.gs` |
| `Tests` | `gas/Tests.gs` |

> 파일 이름에 `.gs` 는 붙이지 않아도 됩니다. 자동으로 붙습니다.

### 매니페스트 설정

1. 좌측 톱니바퀴(**프로젝트 설정**) → **"appsscript.json" 매니페스트 파일 표시** 체크
2. 좌측 파일 목록에 생긴 `appsscript.json` 을 열어
   `gas/appsscript.json` 내용으로 통째로 교체

---

## 3단계 — 비밀값 입력 (Script Properties)

1. 좌측 톱니바퀴(**프로젝트 설정**)
2. 아래로 스크롤 → **스크립트 속성** → **스크립트 속성 추가**
3. 아래 값을 하나씩 넣습니다.

| 속성 이름 | 값 | 필수 |
|---|---|---|
| `NOTION_TOKEN` | 1단계에서 복사한 통합 토큰 | 필수 |
| `NOTION_DATABASE_ID` | 정산 장부 데이터베이스 ID (32자리) | 필수 |
| `ALERT_EMAIL` | 오류 알림을 받을 이메일 주소 | 권장 |
| `SMS_WEBHOOK_SECRET` | 아무도 모르는 긴 문자열 (직접 정하세요) | SMS 쓸 때만 |

**절대 코드 파일에 이 값들을 적지 마세요.** 코드에는 값이 하나도 들어있지 않습니다.

### 선택 설정

| 속성 이름 | 값 | 설명 |
|---|---|---|
| `AMOUNT_FIELD_MODE` | `total` (기본) 또는 `item` | `입금액` 칸에 넣을 값. 아래 설명 참고 |
| `PROPERTY_MAP` | `{"1700811717804874362":"빌라 드 망미"}` | 예약ID → 숙소명 고정. 메일 제목이 바뀌어도 장부가 흔들리지 않습니다 |

> **`AMOUNT_FIELD_MODE` 에 대해 (그냥 두면 기본값 `total` 입니다)**
>
> 정산 메일 한 건은 보통 이렇게 생겼습니다:
> ```
> 숙소              +167,559   ← 숙박비 몫
> 공동 호스트 분배    −8,377    ← 공동 호스트에게 나가는 몫
> ─────────────────────────
> 지급 총액          159,182   ← 실제 통장에 들어온 돈
> ```
> - `total` (기본): `입금액` 에 **159,182**(실제 입금액)을 넣습니다.
>   칸 이름과 의미가 맞고, 통장 대사가 됩니다. 기존 장부와도 일관됩니다.
> - `item`: `입금액` 에 **167,559**(숙박비 몫)을 넣습니다. 게스트별 매출을 보고 싶을 때만.
>
> **한 메일에 정산 대상 게스트가 2명 이상이면** 총액을 행마다 넣을 수 없으므로
> (합계가 부풀려집니다) 기록하지 않고 `MANUAL_REVIEW` 알림을 보냅니다.
> 실제로 이런 메일은 2026-06-26 건 1개뿐이었습니다.

---

## 4단계 — 첫 실행과 권한 승인

1. 상단 함수 선택 상자에서 **`testConnection`** 선택 → **실행**
2. 처음이면 권한 요청 창이 뜹니다:
   - **권한 검토** → 계정 선택
   - "Google에서 확인하지 않은 앱입니다" 화면이 나오면
     → 좌측 하단 **고급** → **(안전하지 않음) …(으)로 이동**
   - 요청 권한 확인 후 **허용**
   > 본인이 만든 스크립트이므로 정상입니다. 메일은 **읽기 전용** 권한만 요청합니다.
3. 하단 **실행 로그**에 다음처럼 나오면 성공입니다:
   ```
   "gmail": "정상 — 최근 30일 정산 메일 N건"
   "notion": "정상 — 속성 10개: 입금액, 이메일ID, ..."
   ```
   `실패` 가 보이면 3단계 값(특히 Notion 연결 추가)을 다시 확인하세요.

---

## 5단계 — 기록 없이 미리 확인 (권장)

실제로 Notion 에 쓰기 전에, 파싱 결과만 눈으로 확인합니다.

1. 함수 선택 → **`dryRunRecent`** → 실행
2. 로그에 메일별로 `status`, `total`, `guests` 가 나옵니다.
3. `status` 가 전부 `SUCCESS` / `SKIPPED_EXPECTED` 인지 확인하세요.
   - `PARSE_ERROR` 가 있으면 그 메일을 열어보고 알려주세요(파서 수정 필요).
   - `MANUAL_REVIEW` 는 정상입니다(전 항목 음수, 외화 섞임, 다건 메일 등 사람이 볼 건).

---

## 6단계 — 자동 실행 켜기

1. 함수 선택 → **`setupTriggers`** → 실행
2. 로그에 `트리거 설정 완료` 가 나오면 끝입니다.

이렇게 설정됩니다:

| 무엇 | 언제 |
|---|---|
| 정산 메일 처리 | **4시간마다** |
| 상태 점검 | 매일 **오전 9시** |
| Gmail↔Notion 대사 | 매일 **오전 4시** |

> 실행 간격을 바꾸려면 `Config.gs` 의 `TRIGGER_INTERVAL_HOURS` 값을 고치고
> `setupTriggers` 를 다시 실행하세요. 기존 트리거는 자동으로 정리됩니다.

좌측 **시계 아이콘(트리거)** 에서 등록된 트리거를 확인할 수 있습니다.

---

## 7단계 — 첫 처리 실행

1. 함수 선택 → **`processNewPayoutEmails`** → 실행
2. 로그 마지막 줄에 요약이 나옵니다:
   ```
   scanned=48 candidate=48 duplicate=0 parsed=43 inserted_rows=43
   manual_review=3 skipped_expected=2 errors=0
   ```

숫자의 뜻:

| 항목 | 뜻 |
|---|---|
| `scanned` | 훑어본 메일 수 |
| `candidate` | 처음 보는 메일 수 |
| `duplicate` | 이미 처리된 메일 |
| `parsed` | 정상 파싱된 정산 메일 |
| **`inserted_rows`** | **Notion 에 실제로 만들어진 행 수** |
| `manual_review` | 사람 확인이 필요한 메일 |
| `skipped_expected` | 장부 대상이 아닌 메일(정상) |
| `errors` | 오류 |

> 기존 시스템의 "10건 처리됨"과 달리, **훑어본 수와 실제 기록한 행 수가 따로 나옵니다.**

---

## 8단계 — SMS 웹훅 (MacroDroid 쓰는 경우만)

입금 문자를 안 쓰면 이 단계는 건너뛰어도 됩니다.

### 배포하기

1. 우측 상단 **배포** → **새 배포**
2. 톱니바퀴 → **웹 앱** 선택
3. 설정:
   - 설명: `SMS webhook`
   - **다음 사용자로 실행**: `나`
   - **액세스 권한이 있는 사용자**: `모든 사용자`
4. **배포** → 나오는 **웹 앱 URL** 복사
   (`https://script.google.com/macros/s/AKfy.../exec` 형태)

### MacroDroid 설정 변경

기존 HTTP 요청 액션에서:

- **URL**: 위에서 복사한 웹 앱 URL 로 교체
- **Method**: `POST`
- **Content-Type**: `application/json`
- **헤더**: 기존 `X-Secret` 헤더는 **삭제**
- **본문**:
  ```json
  {"secret": "3단계에서 정한 SMS_WEBHOOK_SECRET 값", "text": "[SMS내용]"}
  ```

> Apps Script 웹 앱은 임의 헤더를 읽을 수 없어 인증값을 본문에 담습니다.

### 확인

브라우저에서 웹 앱 URL 을 그냥 열면 아래처럼 나오면 정상입니다:
```json
{"status":"ok","service":"airbnb-payout-automation (Apps Script)","lastSuccessfulRun":"..."}
```

> **문자만으로는 장부에 아무것도 쓰지 않습니다.** 입금 문자는 "지금 메일을 확인하라"는
> 신호로만 쓰이고, 기록의 근거는 언제나 정산 메일입니다.

---

## 평소 확인 방법

### 잘 돌고 있는지 보기
함수 선택 → **`getSystemStatus`** → 실행. 로그에 나옵니다:
- `lastSuccessfulRun` — 마지막 성공 실행 시각
- `hoursSinceLastRun` — 몇 시간 전인지
- `lastError` — 마지막 오류

### 실행 기록 보기
좌측 **실행** 메뉴에서 모든 실행 이력과 로그를 볼 수 있습니다.

### 오류 알림
문제가 생기면 `ALERT_EMAIL` 로 메일이 옵니다. 메일에는 이런 내용이 들어갑니다:
발생 시각, 상태, 사유, Gmail 메일ID, 메일 제목, 지급 총액, 항목 수, 재시도 가능 여부.
**토큰이나 비밀값은 알림에 절대 포함되지 않습니다.**

### 누락 검사 직접 하기
함수 선택 → **`reconcileRecentPayouts`** → 실행.
최근 30일 Gmail 정산 메일과 Notion 을 대조해 빠진 게 있으면 찾아 복구합니다.

---

## 상태 코드 읽는 법

| 상태 | 뜻 | 조치 |
|---|---|---|
| `SUCCESS` | 정상 기록 | 없음 |
| `SKIPPED_DUPLICATE` | 이미 기록된 메일 | 없음 |
| `SKIPPED_EXPECTED` | 장부 대상 아님(호스트→게스트 지급, 초안 알림) | 없음 |
| `MANUAL_REVIEW` | 사람 확인 필요(전 항목 음수 / 항목합≠총액 / 게스트 2명 이상) | **행을 만들지 않습니다.** 메일을 열어보고 필요하면 직접 기록 |
| `PARSE_ERROR` | 파싱 실패 — **메일 형식이 바뀌었을 수 있음** | 알려주세요 |
| `NOTION_ERROR` | Notion 기록 실패 | 대개 자동 재시도됨. 반복되면 토큰 확인 |
| `SYSTEM_ERROR` | 그 외 오류 | 실행 로그 확인 |

`PARSE_ERROR` / `NOTION_ERROR` 가 난 메일은 **처리 완료로 표시하지 않습니다.**
다음 실행에서 자동으로 다시 시도합니다.

---

## 자주 겪는 문제

**"could not find database" 오류**
→ 1단계 마지막의 Notion **연결 추가**를 안 한 경우입니다.

**"Script Property 누락: NOTION_TOKEN"**
→ 3단계 값을 저장하지 않았거나 이름 철자가 다릅니다(대소문자 구분).

**메일은 오는데 아무 일도 안 일어남**
→ 좌측 **트리거** 메뉴 확인. 비어 있으면 `setupTriggers` 실행.

**Notion 에 행이 두 번 생김**
→ 설계상 생기지 않지만, 만약 생기면 알려주세요.
   같은 메일ID + 같은 항목키는 한 번만 기록됩니다.

---

## 테스트 (개발자용)

로컬에서 Node.js 로 GAS 코드를 그대로 돌려볼 수 있습니다.

```bash
node tools/run_gas_tests.js          # 파서/검증 단위 테스트 (62개)
node tools/run_integration_tests.js  # 처리 루프 통합 테스트 (78개)

# 실제 Gmail 메일과 현재 Notion 장부를 대조 (읽기 전용, 미리 뽑아둔 데이터 필요)
node tools/shadow_validate.js <데이터 디렉터리>
```

Apps Script 편집기에서는 `runAllTests` 함수를 실행하면 됩니다.
두 방식 모두 실제 Gmail/Notion 을 건드리지 않습니다.
