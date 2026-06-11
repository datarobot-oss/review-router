# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in this project, please report it
responsibly. **Do not open a public GitHub issue.**

Email: oss-community-management@datarobot.com

Please include:

- Description of the vulnerability
- Steps to reproduce
- Potential impact

We will acknowledge your report within 7 business days and work with you
to address the issue before any public disclosure.

## Security Design

This action uses `pull_request_target` to support fork PRs. It never checks out
or executes PR code. See [docs/security/pull-request-target.md](docs/security/pull-request-target.md)
for the full security analysis.
