from __future__ import annotations

import re
from dataclasses import dataclass


KEYWORD_PATTERN = re.compile(r"(code|验证码|verification|otp|security)", re.IGNORECASE)
WHITESPACE_PATTERN = re.compile(r"\s+")
DATE_PATTERN = re.compile(
    r"\b(?:\d{1,2}[/-]\d{1,2}[/-]\d{2,4}|\d{4}[/-]\d{1,2}[/-]\d{1,2})\b",
    re.IGNORECASE,
)


@dataclass(frozen=True, slots=True)
class RegexRule:
    name: str
    pattern: re.Pattern[str]
    base_score: int


RULES = (
    RegexRule(
        name="numeric_code",
        pattern=re.compile(r"(?<!\d)(\d{4,8})(?!\d)"),
        base_score=100,
    ),
    RegexRule(
        name="alnum_code",
        pattern=re.compile(r"\b([A-Z0-9]{4,10})\b"),
        base_score=70,
    ),
)


def normalize_text(value: str | None) -> str:
    if not value:
        return ""
    return WHITESPACE_PATTERN.sub(" ", value).strip()


def make_preview(value: str | None, limit: int = 240) -> str | None:
    normalized = normalize_text(value)
    if not normalized:
        return None
    if len(normalized) <= limit:
        return normalized
    return normalized[: limit - 1] + "…"


def extract_code(text: str | None) -> tuple[str | None, str | None]:
    normalized = normalize_text(text)
    if not normalized:
        return None, None

    best: tuple[int, str, str] | None = None
    upper_text = normalized.upper()

    for rule in RULES:
        search_text = upper_text if rule.name == "alnum_code" else normalized
        for match in rule.pattern.finditer(search_text):
            code = match.group(1)

            if rule.name == "alnum_code":
                if code.isdigit():
                    continue
                if not any(character.isalpha() for character in code):
                    continue
                if not any(character.isdigit() for character in code):
                    continue
                if len(code) < 4 or len(code) > 10:
                    continue

            if rule.name == "numeric_code" and _looks_like_date_token(normalized, match.start(), match.end(), code):
                continue

            score = rule.base_score
            score += _keyword_bonus(search_text, match.start(), match.end())

            if best is None or score > best[0]:
                best = (score, code, rule.name)

    if best is None:
        return None, None
    return best[1], best[2]


def _keyword_bonus(text: str, start: int, end: int) -> int:
    bonus = 0
    for keyword_match in KEYWORD_PATTERN.finditer(text):
        distance = min(abs(keyword_match.start() - end), abs(start - keyword_match.end()))
        bonus = max(bonus, max(0, 120 - min(distance, 120)))
    return bonus


def _looks_like_date_token(text: str, start: int, end: int, code: str) -> bool:
    if re.fullmatch(r"(19|20)\d{2}", code):
        return True

    context_start = max(0, start - 16)
    context_end = min(len(text), end + 16)
    context = text[context_start:context_end]

    if DATE_PATTERN.search(context):
        return True

    if re.search(rf"\b{re.escape(code)}[/-]\d{{1,2}}\b", context):
        return True
    if re.search(rf"\b\d{{1,2}}[/-]{re.escape(code)}\b", context):
        return True

    return False
