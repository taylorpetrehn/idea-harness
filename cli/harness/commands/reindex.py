"""harness reindex — rebuild ~/.claude/plans/index.sqlite from disk."""

from __future__ import annotations

import argparse
import sys

from .. import index as index_mod


def cmd_reindex(args: argparse.Namespace) -> int:
    count = index_mod.rebuild()
    sys.stdout.write(f"indexed {count} ideas at {index_mod.INDEX_PATH}\n")
    return 0
