---
active: true
iteration: 1
session_id: 
max_iterations: 20
completion_promise: "NEXTGEN_DONE"
started_at: "2026-05-04T23:01:54Z"
---

Execute the next-gen CLI build per proposals/next-gen-cli.md on branch next-gen-cli. Deliver phases 0 through 7 in order. After each phase run npm run typecheck and fix errors before committing. Do not push. Stop after the final commit and output the literal token NEXTGEN_DONE only when all 7 phases are committed and typecheck is green.
