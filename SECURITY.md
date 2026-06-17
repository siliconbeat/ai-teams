# Security Policy

## Supported Versions

Security fixes are handled on the default branch. If you run AI Teams in production, deploy from the latest tagged release or the latest reviewed commit on `main`.

## Reporting a Vulnerability

Please do not open public issues for vulnerabilities that expose tokens, credentials, private repositories, or remote code execution paths.

Report security issues privately through GitHub Security Advisories for this repository. Include:

- Affected version or commit.
- A clear reproduction path.
- Expected impact.
- Any relevant logs with secrets redacted.

## Deployment Notes

- Treat `AI_TEAMS_AUTH_TOKEN`, `AI_TEAMS_AGENT_TOKEN`, `AI_TEAMS_ENCRYPTION_KEY`, database credentials, and webhook secrets as sensitive.
- Do not mount host home directories, SSH keys, Docker sockets, or production secret directories into Agent workspaces.
- Prefer isolated workspaces for Agents, especially when using `CLAUDE_PERMISSION_MODE=bypassPermissions`.
