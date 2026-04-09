# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 1.x     | ✅ Yes    |

## Reporting a Vulnerability

**Please do NOT report security vulnerabilities through public GitHub Issues.**

If you discover a security vulnerability, please report it privately:

1. Open a [GitHub Security Advisory](https://github.com/slopus/aha-cli/security/advisories/new)
2. Or email the maintainers directly (see package.json `author` field)

Include in your report:
- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

We will acknowledge your report within 48 hours and provide a fix timeline within 7 days.

## Security Considerations

- Private keys are stored in `~/.aha/access.key` with restricted file permissions
- All server communications use end-to-end encryption (TweetNaCl)
- Session tokens are never logged or transmitted in plaintext
- The daemon runs locally — your code never passes through Aha servers unencrypted

## Disclosure Policy

Once a fix is released, we will publish a security advisory with:
- CVE identifier (if applicable)
- Description of the vulnerability
- Affected versions
- Remediation steps
