# Contributing

Thanks for helping improve AI Teams.

## Development

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

Before opening a pull request, run:

```bash
git diff --check
```

## Local Runtime

Start the Server and Web console first:

```bash
pnpm dev:server
pnpm dev:web
```

Then open `http://localhost:5173`, sign in with `dev-token`, add or approve an Agent in `员工管理`, copy the Agent Token, and start the Agent:

```bash
AI_TEAMS_AGENT_TOKEN=<agent-token> EMPLOYEE_ID=alice EMPLOYEE_NAME=Alice DEFAULT_WORKSPACE=$PWD pnpm --filter @csdwd/ai-teams-agent dev
```

## Pull Requests

- Keep changes scoped to the issue being solved.
- Add or update tests for behavior changes.
- Do not commit local runtime state, databases, logs, `.ai-teams/`, `.claude/`, `.playwright-mcp/`, or `.superpowers/`.
- Redact tokens, private URLs, local absolute paths, and customer data from issues, tests, docs, and screenshots.
