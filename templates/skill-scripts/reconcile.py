#!/usr/bin/env python3
"""reconcile.py — LaunchAgent entry for `harness reconcile`.

This is the cron entry that runs every 5 minutes; it shells out to the
`harness` CLI installed at `pip install -e cli/`. Keeping the LaunchAgent
thin (just a subprocess.run) lets the CLI evolve without redeploying
the plist.

Run by ~/Library/LaunchAgents/com.taylorpetrehn.idea-harness-reconcile.plist.
"""

from __future__ import annotations

import datetime
import os
import shutil
import subprocess
import sys
from pathlib import Path

HOME = Path.home()
LOG_FILE = HOME / ".claude" / "skills" / "idea-harness" / "logs" / "reconcile.log"


def main() -> int:
    LOG_FILE.parent.mkdir(parents=True, exist_ok=True)
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    harness = shutil.which("harness")
    if not harness:
        # Fallback: try the local `python3 -m harness` if the CLI is
        # installed editable from an idea-harness checkout.
        for candidate in (
            HOME / "Projects" / "idea-harness" / "cli",
            HOME / "code" / "idea-harness" / "cli",
        ):
            if (candidate / "harness").is_dir():
                harness = sys.executable
                argv = [harness, "-m", "harness", "reconcile"]
                break
        else:
            with open(LOG_FILE, "a") as logf:
                logf.write(f"\n[{stamp}] ERROR: harness CLI not on PATH; skipping\n")
            return 0  # don't fail the cron; just log and exit
    else:
        argv = [harness, "reconcile"]

    with open(LOG_FILE, "a") as logf:
        logf.write(f"\n[{stamp}] reconcile starting: {' '.join(argv)}\n")
        logf.flush()
        proc = subprocess.run(argv, stdout=logf, stderr=subprocess.STDOUT)
        end = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        logf.write(f"[{end}] reconcile exit {proc.returncode}\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
