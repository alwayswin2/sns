import re
from dataclasses import dataclass
from typing import Optional


@dataclass
class PayoutItem:
    guest_name: str
    property_name: str
    checkin: str        # "YYYY-MM-DD"
    checkout: str       # "YYYY-MM-DD"
    amount: int         # 음수 가능 (공제 항목)
    reservation_id: str # 숙소 예약번호
    guest_code: str     # HM2ANY8Y2X 형태


@dataclass
class PayoutEmail:
    total_amount: int
    payout_date: str    # "YYYY-MM-DD"
    items: list[PayoutItem]


def _parse_date(year: str, month: str, day: str) -> str:
    return f"{year}-{month.zfill(2)}-{day.zfill(2)}"


def parse_payout_email(body: str) -> Optional[PayoutEmail]:
    """에어비앤비 정산 메일 본문 파싱"""

    # 총액: "지급 총액:   ₩68,873 KRW"
    total_match = re.search(r"지급\s*총액[:\s]*[₩-]?([\d,]+)\s*KRW", body)
    if not total_match:
        # 제목 줄: "₩68,873 KRW의 금액이 오늘 지급"
        total_match = re.search(r"[₩]([\d,]+)\s*KRW의\s*금액", body)
    if not total_match:
        return None
    total_amount = int(total_match.group(1).replace(",", ""))

    # 지급 예정일: "2026년 7월 9일까지 입금"
    date_match = re.search(r"(\d{4})년\s*(\d{1,2})월\s*(\d{1,2})일까지\s*입금", body)
    if not date_match:
        date_match = re.search(r"(\d{4})년\s*(\d{1,2})월\s*(\d{1,2})일", body)
    payout_date = ""
    if date_match:
        payout_date = _parse_date(date_match.group(1), date_match.group(2), date_match.group(3))

    items = _parse_items_simple(body)

    return PayoutEmail(
        total_amount=total_amount,
        payout_date=payout_date,
        items=items,
    )


def _parse_items_simple(body: str) -> list[PayoutItem]:
    """단순 방식 파싱 — 라인 단위로 처리 (빈 줄 다수 포함 구조 대응)"""
    lines = [l.strip() for l in body.splitlines()]
    # 빈 줄 제거한 non-empty 라인만 추출
    nlines = [(idx, l) for idx, l in enumerate(lines) if l]

    # "세부 정보" 이후부터만 처리
    start = 0
    for i, (idx, l) in enumerate(nlines):
        if l == "세부 정보":
            start = i + 1
            break

    items = []
    i = start
    while i < len(nlines):
        _, line = nlines[i]

        # 게스트명 + 금액: "윤주 김   ₩72,498 KRW" / "윤주 김   -₩3,625 KRW"
        amount_match = re.match(r"^([가-힣a-zA-Z\s]+?)\s{2,}(-?)[₩]?([\d,]+)\s*KRW$", line)
        if amount_match:
            guest_name = amount_match.group(1).strip()
            sign = -1 if amount_match.group(2) == "-" else 1
            amount = sign * int(amount_match.group(3).replace(",", ""))

            checkin = checkout = property_name = reservation_id = guest_code = ""

            # 이후 최대 6개 non-empty 라인에서 정보 추출
            for j in range(i + 1, min(i + 7, len(nlines))):
                _, jline = nlines[j]

                # 날짜: "숙소 • 2026. 7. 1. - 2026. 7. 2."
                date_match = re.search(
                    r"(\d{4})\.\s*(\d{1,2})\.\s*(\d{1,2})\.\s*-\s*(\d{4})\.\s*(\d{1,2})\.\s*(\d{1,2})\.",
                    jline
                )
                if date_match:
                    checkin = _parse_date(date_match.group(1), date_match.group(2), date_match.group(3))
                    checkout = _parse_date(date_match.group(4), date_match.group(5), date_match.group(6))

                # 숙소명 + 예약ID: "오픈특가할인 | 빌라 드 망미 | ... (1700811717804874362)"
                id_match = re.search(r"\((\d{10,})\)", jline)
                if id_match:
                    reservation_id = id_match.group(1)
                    prop_full = re.sub(r"\s*\(\d+\)\s*$", "", jline).strip()
                    parts = [p.strip() for p in prop_full.split("|")]
                    property_name = parts[1] if len(parts) > 1 else parts[0]

                # 게스트코드: 대문자+숫자 8자 이상 단독 라인
                if re.match(r"^[A-Z0-9]{8,}$", jline):
                    guest_code = jline
                    i = j  # 다음 순회는 게스트코드 다음부터
                    break

            if checkin and reservation_id:
                items.append(PayoutItem(
                    guest_name=guest_name,
                    property_name=property_name,
                    checkin=checkin,
                    checkout=checkout,
                    amount=amount,
                    reservation_id=reservation_id,
                    guest_code=guest_code,
                ))
        i += 1

    return items


def parse_sms(sms_text: str) -> Optional[dict]:
    """은행 입금 문자 파싱 — 입금액 + 날짜 추출"""
    amount_match = re.search(r"([\d,]+)원", sms_text)
    date_match = re.search(r"(\d{2})/(\d{2})", sms_text)

    if not amount_match:
        return None

    amount = int(amount_match.group(1).replace(",", ""))
    date = ""
    if date_match:
        import datetime
        year = datetime.date.today().year
        date = f"{year}-{date_match.group(1)}-{date_match.group(2)}"

    return {"amount": amount, "date": date, "raw": sms_text}
