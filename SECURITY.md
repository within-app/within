# Security Policy

## Reporting a Vulnerability

**Please do not open a public GitHub issue for security vulnerabilities.**

Within uses GitHub's built-in **private vulnerability reporting** feature.
To report a security issue, go to the repository's **Security** tab and click
**"Report a vulnerability"**. This opens a private advisory that only the
maintainers can see.

GitHub's private vulnerability reporting docs:
https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing/privately-reporting-a-security-vulnerability

## What to Include

A useful report includes:

- A description of the vulnerability and its potential impact.
- Steps to reproduce or a minimal proof-of-concept.
- The version or commit hash where you observed the issue.
- Any suggested mitigations you have in mind.

## Response

Bug reports are welcome; there is no guaranteed response time. Reports are
reviewed on a best-effort basis.

## Scope

Within is a self-hosted personal journal. The attack surface that matters most:

- Authentication and session handling.
- SQL injection / data exfiltration paths.
- Path traversal or SSRF in media upload / export routes.
- Secrets or credentials inadvertently exposed in the repository.

Out of scope: spam, social engineering, physical security, or issues in
third-party dependencies that have an upstream fix already published.
