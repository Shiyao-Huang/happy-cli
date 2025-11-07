# Security Guide

## Overview

This document outlines security best practices for using Happy CLI, particularly when configuring API keys and sensitive credentials.

## API Key Management

### ⚠️ CRITICAL: Never Hardcode API Keys

**API keys must NEVER be:**
- Hardcoded in source code
- Committed to version control
- Shared in chat or public forums
- Pasted in documentation

### ✅ Secure Configuration

API keys should only be stored in:
1. **Local configuration files** (with restricted permissions)
2. **Environment variables** (for production)
3. **Secure key management systems** (enterprise)

## Configuration File Security

### File Location

API configuration files should be placed in:
- `~/.happy/APIs` (recommended for user-specific)
- `/Users/swmt/Documents/auto_claude_proxy/APIs` (for project-specific)
- `./APIs` (for local development)

**File must be excluded from version control!**

### File Permissions

Set restrictive permissions on your configuration file:

```bash
# Restrict access to owner only
chmod 600 ~/.happy/APIs

# Verify permissions
ls -la ~/.happy/APIs
# Should show: -rw------- (600)
```

### Version Control

Ensure your `.gitignore` includes:

```gitignore
# API Configuration (contains sensitive API keys)
APIs
~/.happy/APIs
**/APIs
```

## Provider-Specific Security

### MiniMax
- **API Key Format**: JWT token starting with `eyJ...`
- **Obtain From**: https://api.minimaxi.com
- **Security**: Treat as password - never share

### GLM (Zhipu AI)
- **API Key Format**: String with dots
- **Obtain From**: https://open.bigmodel.cn
- **Security**: Unique to your account

### Kimi (Moonshot AI)
- **API Key Format**: String starting with `sk-`
- **Obtain From**: https://api.moonshot.cn
- **Security**: Keep confidential

## Best Practices

### 1. Development vs Production
```bash
# Development: Use local config
~/.happy/APIs

# Production: Use environment variables
export ANTHROPIC_AUTH_TOKEN="your_key_here"
```

### 2. Key Rotation
- Rotate API keys regularly (every 30-90 days)
- Monitor usage for anomalies
- Revoke compromised keys immediately

### 3. Access Control
- Use different keys for different environments
- Restrict key permissions to minimum required
- Monitor API usage regularly

### 4. Local Storage
- Encrypt configuration files at rest
- Use OS keychain when possible
- Regular backups (encrypted)

## Code Security

### Source Code Review

Our code follows these security principles:

1. **No hardcoded credentials**
   - All API keys loaded from external files
   - Documented in `modelManager.ts:178-187`

2. **Configuration is local only**
   - Files not included in repository
   - Listed in `.gitignore`

3. **Explicit file paths**
   - No hidden configuration
   - Clear search paths documented

### Example: Secure Loading

```typescript
// modelManager.ts - Secure API loading
private loadFromApisConfig(): void {
    // SECURITY NOTE:
    // - API keys loaded from external configuration files only
    // - NO API keys are hardcoded in source code
    // - Configuration files should be placed in ~/.happy/ or project directory
}
```

## Monitoring & Auditing

### What to Monitor
- Unusual API usage patterns
- Failed authentication attempts
- Geographic anomalies
- Time-based anomalies

### Happy CLI Audit Commands
```bash
# Check which model is active
happy --to

# View token usage statistics
happy --stats

# List all configured models
happy --seeall
```

## Incident Response

### If API Key is Compromised

1. **Immediately revoke the key** via provider dashboard
2. **Generate a new key**
3. **Update configuration file**
4. **Rotate any other keys that may be affected**
5. **Monitor for unauthorized usage**
6. **Review audit logs**

### If Configuration File is Leaked

1. **All keys in file are compromised**
2. **Revoke all keys immediately**
3. **Generate new keys**
4. **Check .gitignore** to prevent future leaks
5. **Review git history** for any commits containing keys

## Compliance

### Data Protection
- API keys are PII (Personally Identifiable Information)
- Treat as sensitive personal data
- Follow your organization's data handling policies
- Comply with GDPR, CCPA, etc. as applicable

### Industry Standards
- Follow OWASP guidelines
- Implement principle of least privilege
- Regular security audits
- Keep dependencies updated

## Security Tools

### Recommended Tools
```bash
# File encryption
gpg -c ~/.happy/APIs

# Keychain storage (macOS)
security add-generic-password -s happy-cli -a your-username

# Secret management (enterprise)
hashicorp-vault
aws-secrets-manager
azure-key-vault
```

## Reporting Security Issues

### Do NOT Report
- Vulnerabilities in public forums
- Security issues in chat
- API keys in issue reports

### DO Report
- Security issues via GitHub Security tab
- Use private vulnerability reports
- Include minimal reproduction steps
- Remove all sensitive data from reports

## Additional Resources

### Documentation
- [API Configuration Guide](./API_CONFIGURATION.md)
- [Model Management](./MODEL_MANAGEMENT.md)
- [Token Monitoring](./TOKEN_MONITORING.md)

### Provider Security
- MiniMax: https://api.minimaxi.com/docs
- GLM: https://open.bigmodel.cn/dev/api
- Kimi: https://platform.moonshot.cn/docs

## Quick Security Checklist

Before using Happy CLI:

- [ ] API keys obtained from official providers
- [ ] Configuration file created in secure location
- [ ] File permissions set to 600
- [ ] `.gitignore` includes APIs entries
- [ ] No API keys in source code
- [ ] No API keys in git history
- [ ] Different keys for dev/prod
- [ ] Plan for key rotation
- [ ] Monitor usage regularly
- [ ] Know how to revoke keys

## Contact

For security questions:
- Review: [API_CONFIGURATION.md](./API_CONFIGURATION.md)
- Check: [examples/api-config-example.md](./examples/api-config-example.md)
- Issues: GitHub Security tab

---

**Remember: Security is everyone's responsibility. When in doubt, ask!**
