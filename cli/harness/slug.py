"""Slug + id generation. Mirrors the rules used by harvest.py."""

from __future__ import annotations

import re
import secrets


def gen_id(length: int = 8) -> str:
    """8-char hex like `openssl rand -hex 4`."""
    return secrets.token_hex(max(2, length // 2))[:length]


def slugify(title: str, id_suffix: str | None = None) -> str:
    """Lowercase kebab-case, max 50 chars, suffix is first 4 chars of id."""
    s = title.lower()
    s = re.sub(r"[^a-z0-9\s-]+", "", s)
    s = re.sub(r"\s+", "-", s).strip("-")
    s = re.sub(r"-{2,}", "-", s)
    s = s[:50].rstrip("-")
    if id_suffix:
        return f"{s}-{id_suffix[:4]}"
    return s
