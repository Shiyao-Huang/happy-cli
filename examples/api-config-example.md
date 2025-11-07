# API Configuration Example

This directory contains example configuration files for Happy CLI.

## Files

- **`API_CONFIG.template`** - Template configuration file with placeholders
- **`api-config-example.md`** - This file, explaining how to use the template

## Quick Start

### 1. Copy the Template

```bash
# Copy to your project directory
cp examples/API_CONFIG.template /Users/swmt/Documents/auto_claude_proxy/APIs

# OR copy to your home directory
cp examples/API_CONFIG.template ~/.happy/APIs

# OR copy to current directory
cp examples/API_CONFIG.template ./APIs
```

### 2. Edit the Configuration

Open the copied file and replace placeholders with your actual API keys:

```bash
# Edit the file
nano /Users/swmt/Documents/auto_claude_proxy/APIs

# Replace these placeholders:
# - YOUR_MINIMAX_API_KEY_HERE
# - YOUR_ZHIPU_API_KEY_HERE
# - YOUR_MOONSHOT_API_KEY_HERE
```

### 3. Set Proper Permissions

```bash
# Restrict access to the configuration file
chmod 600 /Users/swmt/Documents/auto_claude_proxy/APIs
```

### 4. Verify Configuration

```bash
# Rebuild and relink Happy CLI
npm run build
npm link

# Test the configuration
happy --seeall    # Should show all 12 models (5 built-in + 7 API)
happy --to MM     # Switch to MiniMax
happy --to GLM    # Switch to GLM
happy --to KIMI   # Switch to Kimi
```

## Security Checklist

- [ ] API keys are not hardcoded in source code
- [ ] Configuration file is not in version control
- [ ] File permissions are set to 600 (owner read/write only)
- [ ] API keys are kept secret
- [ ] Different keys used for development vs production
- [ ] API keys are rotated regularly

## Common Issues

### "Model not found" Error

**Cause**: Configuration file not found or invalid format

**Solution**:
1. Verify file exists at one of the expected locations
2. Check JSON format is valid (use `jq` or online validator)
3. Ensure all required fields are present
4. Rebuild Happy CLI: `npm run build && npm link`

### "Authentication failed" Error

**Cause**: Invalid or expired API key

**Solution**:
1. Verify API key is correct
2. Check key has not expired
3. Ensure key has proper permissions
4. Confirm account has sufficient credits

### Model Shows Wrong ID

**Cause**: Provider detection logic failing

**Solution**:
1. Check `ANTHROPIC_BASE_URL` is correct
2. Verify URL includes proper domain (bigmodel.cn for GLM, moonshot.cn for Kimi, etc.)
3. Clear cache: `rm -f ~/.happy/model-config.json`
4. Rebuild: `npm run build && npm link`

## Provider-Specific Notes

### MiniMax
- Model ID is always `MiniMax-M2`
- API key format: JWT token starting with `eyJ...`
- Endpoint: `https://api.minimaxi.com/anthropic`

### GLM (Zhipu AI)
- Model IDs: `glm-4.6` (Sonnet), `glm-4.5-air` (Haiku)
- API key format: String with dots (e.g., `xxxxx.yyyyy.zzzzz`)
- Endpoint: `https://open.bigmodel.cn/api/anthropic`

### Kimi (Moonshot AI)
- Model ID is always `kimi-k2-thinking`
- API key format: String starting with `sk-`
- Endpoint: `https://api.moonshot.cn/anthropic/`

## Example Output

After successful configuration, you should see:

```bash
$ happy --to MM
✓ Switched to model "MM (MiniMax)"
   Model ID: MiniMax-M2
   Cost: $0.001/1K input, $0.001/1K output

$ happy --to GLM
✓ Switched to model "GLM"
   Model ID: glm-4.6
   Cost: $0.001/1K input, $0.001/1K output

$ happy --to KIMI
✓ Switched to model "KIMI (Kimi)"
   Model ID: kimi-k2-thinking
   Cost: $0.001/1K input, $0.001/1K output
```

## Additional Resources

- [Full API Configuration Guide](../API_CONFIGURATION.md)
- [Model Management](../MODEL_MANAGEMENT.md)
- [Token Monitoring](../TOKEN_MONITORING.md)

## Support

If you encounter issues:

1. Check the troubleshooting section in the main [API Configuration Guide](../API_CONFIGURATION.md)
2. Verify your API key with the provider's documentation
3. Check Happy CLI logs for detailed error messages
4. Open an issue on GitHub with your configuration (remember to remove API keys!)
