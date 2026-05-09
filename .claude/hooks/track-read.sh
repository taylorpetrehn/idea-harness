#!/usr/bin/env bash
# Copyright 2026 Anthropic PBC
# SPDX-License-Identifier: Apache-2.0
# Records which evidence files (screenshots, console logs) the agent has opened this session.
# verify-gate.sh consults this list before allowing a test to be marked passing.
log="${VERIFY_READ_LOG:-./.claude/.evidence-reads}"
path=$(cat | python3 -c 'import json,sys; print(json.load(sys.stdin).get("tool_input",{}).get("file_path",""))' 2>/dev/null)
case "$path" in
  *screenshots/*|*-console.txt|*-result.txt|*.png) [ -f "$path" ] && echo "$path" >> "$log" ;;
esac
exit 0
