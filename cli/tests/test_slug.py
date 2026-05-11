"""Slug + id generation."""

from harness.slug import gen_id, slugify


def test_gen_id_length():
    assert len(gen_id(8)) == 8
    assert len(gen_id(4)) == 4
    # all hex
    assert all(c in "0123456789abcdef" for c in gen_id(8))


def test_slugify_basic():
    assert slugify("Hello World", "abcd") == "hello-world-abcd"


def test_slugify_punctuation():
    assert slugify("Don't break, please!", "abcd") == "dont-break-please-abcd"


def test_slugify_unicode_stripped():
    # Em-dash and other non-ASCII collapsed to nothing
    s = slugify("Move — Forward", "abcd")
    assert s == "move-forward-abcd"


def test_slugify_truncation():
    long = "a" * 100
    s = slugify(long, "1234")
    # 50-char body + dash + 4-char id = 55
    assert len(s) <= 55
    assert s.endswith("-1234")


def test_slugify_collapses_repeats():
    assert slugify("a---b", "1234") == "a-b-1234"


def test_slugify_no_suffix():
    assert slugify("foo bar") == "foo-bar"
