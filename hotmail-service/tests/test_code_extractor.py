from app.code_extractor import extract_code, make_preview


def test_extract_code_prefers_keyworded_numeric_match() -> None:
    text = "Reference 998877. Your verification code is 123456. Do not share it."

    code, rule = extract_code(text)

    assert code == "123456"
    assert rule == "numeric_code"


def test_extract_code_handles_alphanumeric_codes() -> None:
    text = "Use security code AB12CD34 to continue."

    code, rule = extract_code(text)

    assert code == "AB12CD34"
    assert rule == "alnum_code"


def test_extract_code_from_outlook_list_summary() -> None:
    text = "未读 noreply@tm.openai.com 你的 ChatGPT 代码为 422883 0:38 输入此临时验证码以继续： 422883"

    code, rule = extract_code(text)

    assert code == "422883"
    assert rule == "numeric_code"


def test_extract_code_does_not_treat_year_as_code() -> None:
    text = "Detectamos um novo acesso à sua conta 01/11/2025 Sem localização"

    code, rule = extract_code(text)

    assert code is None
    assert rule is None


def test_make_preview_truncates_long_text() -> None:
    preview = make_preview("x" * 300, limit=20)
    assert preview == ("x" * 19) + "…"
