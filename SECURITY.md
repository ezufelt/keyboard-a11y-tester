# Security Policy

## Supported Versions

This project is pre-1.0 (`0.x`). Only the latest release on `main` is supported;
there are no maintained backport branches.

## Reporting a Vulnerability

Please **do not** open a public GitHub issue for security vulnerabilities.

Instead, report privately using one of:

- [GitHub private vulnerability reporting](https://github.com/ezufelt/keyboard-a11y-tester/security/advisories/new)
  (preferred — go to the Security tab and click "Report a vulnerability")
- Email everett@zufelt.ca

Please include steps to reproduce, the affected version/commit, and the potential
impact. You should expect an initial response within a few days. If the report is
confirmed, a fix will be prioritized and a GitHub Security Advisory published once
a patch is available.

## Scope

This tool drives a real, sandboxed Chromium instance against user-supplied URLs.
Reports about the tool executing arbitrary code, escaping its Playwright/CDP
sandbox, or leaking data between runs are in scope. Reports about the behavior of
third-party websites the tool is pointed at are not.
