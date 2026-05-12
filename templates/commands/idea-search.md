---
description: Search ideas by title substring or filter. Args are passed through to `harness ideas list`.
argument-hint: "[--status X] [--project Y] [--score-gte N]"
allowed-tools: ["Bash"]
---

Run `harness ideas list $ARGUMENTS --json | jq -r 'select(.title | ascii_downcase | contains("'"$QUERY"'"))'` style search — but the simple form below is enough for v1:

```bash
harness ideas list $ARGUMENTS
```

When the user wants a substring match on title (not just a status/project filter), do `harness ideas list --json | jq '...'` with their query inside the jq filter. Otherwise pass the filters straight through. Surface ideas with `awaiting-review`, `needs-critic-review`, or `needs-detail` status first.
