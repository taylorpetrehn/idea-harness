"""harness capture "<title>" — write a new idea.md at status: captured."""

from __future__ import annotations

import argparse
import sys

from ..slug import gen_id, slugify
from ..state import SPECS_DIR, Idea, now_iso


def cmd_capture(args: argparse.Namespace) -> int:
    title = args.title.strip()
    if not title:
        sys.stderr.write("[harness] empty title; nothing captured.\n")
        return 2

    idea_id = gen_id(8)
    slug = slugify(title, idea_id)
    spec_dir = SPECS_DIR / slug
    if spec_dir.exists():
        sys.stderr.write(
            f"[harness] {spec_dir} already exists — pick a different title or remove the directory first.\n"
        )
        return 1

    captured_at = now_iso()
    fm: dict[str, object] = {
        "id": idea_id,
        "slug": slug,
        "title": title,
        "status": "captured",
        "source": args.source,
        "captured_at": captured_at,
        "last_touched": captured_at,
        "loop_count": 0,
    }
    if args.project:
        fm["project"] = args.project

    body_parts = ["", "## Raw Idea", "", title, ""]
    if args.notes:
        body_parts += ["## Notes", "", args.notes.strip(), ""]
    body_parts += ["## Brainstorm", "", "<!-- Filled by the brainstormer. -->", ""]
    body = "\n".join(body_parts)

    idea = Idea(path=spec_dir / "idea.md", frontmatter=fm, body=body)
    idea.save()
    sys.stdout.write(f"captured: {slug}\n")
    sys.stdout.write(f"  path:   {idea.path}\n")
    sys.stdout.write(f"  status: captured\n")
    if args.project:
        sys.stdout.write(f"  project: {args.project}\n")
    return 0
