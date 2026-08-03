<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

## Git workflow

- Codex must never push commits directly to `dev` or `main`.
- For every repository change, Codex must create a `codex/*` branch, push it, and open a pull request targeting `dev`.
- Only merge `dev` into `main` through a separate pull request after explicit user approval.
