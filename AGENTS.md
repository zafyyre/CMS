<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

## Git workflow

- Codex may commit and push changes directly to `dev`.
- Codex must never push commits directly to `main`.
- To move changes from `dev` to `main`, Codex must open a pull request targeting `main` and wait for explicit user approval before merging it.
