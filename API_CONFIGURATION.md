# API Configuration Guide

## Overview

Happy CLI supports multiple AI model providers through configuration files. This guide explains how to set up API configurations for different providers.

## Configuration File Location

The configuration file should be placed at one of these locations (in order of priority):

1. `/Users/swmt/Documents/auto_claude_proxy/APIs` (project-specific)
2. `~/.happy/APIs` (user home directory)
3. `./APIs` (current directory)

## Supported Providers

### 1. MiniMax
- **Website**: https://api.minimaxi.com
- **API Endpoint**: `https://api.minimaxi.com/anthropic`
- **Model**: MiniMax-M2

### 2. GLM (Zhipu AI)
- **Website**: https://open.bigmodel.cn
- **API Endpoint**: `https://open.bigmodel.cn/api/anthropic`
- **Models**: glm-4.6, glm-4.5-air

### 3. Kimi (Moonshot AI)
- **Website**: https://api.moonshot.cn
- **API Endpoint**: `https://api.moonshot.cn/anthropic/`
- **Model**: kimi-k2-thinking

## Configuration Format

The configuration file uses JSON format with environment variables. Multiple provider configurations can be in the same file.

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "https://api.provider.com/anthropic",
    "ANTHROPIC_AUTH_TOKEN": "your_api_key_here",
    "API_TIMEOUT_MS": "3000000",
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": 1,
    "ANTHROPIC_MODEL": "provider-specific-model-id",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "provider-specific-model-id",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "provider-specific-model-id",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "provider-specific-model-id"
  }
}
```

## Required Fields

| Field | Description | Example |
|-------|-------------|---------|
| `ANTHROPIC_BASE_URL` | Provider's API endpoint | `https://api.minimaxi.com/anthropic` |
| `ANTHROPIC_AUTH_TOKEN` | Your API key (NEVER share or hardcode) | `your_actual_api_key` |
| `ANTHROPIC_MODEL` | Default model ID (MiniMax) | `MiniMax-M2` |
| `ANTHROPIC_DEFAULT_SONNET_MODEL` | Sonnet-tier model (GLM) | `glm-4.6` |
| `ANTHROPIC_DEFAULT_HAIKU_MODEL` | Haiku-tier model (Kimi) | `kimi-k2-thinking` |

## Example Configurations

### MiniMax Configuration
```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "https://api.minimaxi.com/anthropic",
    "ANTHROPIC_AUTH_TOKEN": "YOUR_MINIMAX_API_KEY",
    "API_TIMEOUT_MS": "3000000",
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": 1,
    "ANTHROPIC_MODEL": "MiniMax-M2",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "MiniMax-M2",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "MiniMax-M2",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "MiniMax-M2"
  }
}
```

### GLM Configuration
```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "https://open.bigmodel.cn/api/anthropic",
    "ANTHROPIC_AUTH_TOKEN": "YOUR_ZHIPU_API_KEY",
    "API_TIMEOUT_MS": "3000000",
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": 1,
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "glm-4.5-air",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "glm-4.6",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "glm-4.6"
  }
}
```

### Kimi Configuration
```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "https://api.moonshot.cn/anthropic/",
    "ANTHROPIC_AUTH_TOKEN": "YOUR_MOONSHOT_API_KEY",
    "API_TIMEOUT_MS": "3000000",
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": 1,
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "kimi-k2-thinking",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "kimi-k2-thinking",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "kimi-k2-thinking"
  }
}
```

## Complete Example with Multiple Providers

You can include multiple JSON blocks in a single file:

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "https://api.minimaxi.com/anthropic",
    "ANTHROPIC_AUTH_TOKEN": "YOUR_MINIMAX_API_KEY",
    "API_TIMEOUT_MS": "3000000",
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": 1,
    "ANTHROPIC_MODEL": "MiniMax-M2",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "MiniMax-M2",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "MiniMax-M2",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "MiniMax-M2"
  }
}

{
  "env": {
    "ANTHROPIC_BASE_URL": "https://open.bigmodel.cn/api/anthropic",
    "ANTHROPIC_AUTH_TOKEN": "YOUR_ZHIPU_API_KEY",
    "API_TIMEOUT_MS": "3000000",
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": 1,
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "glm-4.5-air",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "glm-4.6",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "glm-4.6"
  }
}

{
  "env": {
    "ANTHROPIC_BASE_URL": "https://api.moonshot.cn/anthropic/",
    "ANTHROPIC_AUTH_TOKEN": "YOUR_MOONSHOT_API_KEY",
    "API_TIMEOUT_MS": "3000000",
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": 1,
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "kimi-k2-thinking",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "kimi-k2-thinking",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "kimi-k2-thinking"
  }
}
```

## Security Best Practices

### ✅ DO:
- Store API keys in environment variables or secure key management systems
- Use file permissions to restrict access to the configuration file (chmod 600)
- Keep the configuration file outside of version control (.gitignore)
- Rotate API keys regularly
- Use different keys for development and production

### ❌ DON'T:
- **NEVER** hardcode API keys in the source code
- **NEVER** commit API keys to version control
- **NEVER** share your configuration file with others
- **NEVER** paste API keys in chat or public forums
- **DON'T** use production keys for testing

## How to Get API Keys

### MiniMax
1. Visit: https://api.minimaxi.com
2. Sign up for an account
3. Navigate to API Keys section
4. Generate a new API key
5. Copy the key (starts with `eyJ...`)

### GLM (Zhipu AI)
1. Visit: https://open.bigmodel.cn
2. Create an account
3. Go to API Management
4. Create a new API key
5. Copy the key

### Kimi (Moonshot AI)
1. Visit: https://api.moonshot.cn
2. Register for an account
3. Go to API Keys
4. Generate a new key
5. Copy the key (starts with `sk-`)

## Setting Up

1. **Create the configuration file** at one of the locations mentioned above
2. **Replace placeholder values** with your actual API keys
3. **Save the file** and ensure proper permissions
4. **Rebuild Happy CLI** if needed:
   ```bash
   npm run build
   npm link
   ```
5. **Test the configuration**:
   ```bash
   happy --to MM    # Test MiniMax
   happy --to GLM   # Test GLM
   happy --to KIMI  # Test Kimi
   ```

## Troubleshooting

### Model not found
- Ensure the configuration file exists in one of the specified locations
- Verify the JSON format is valid
- Check that all required fields are present
- Run `happy --seeall` to see all loaded models

### Authentication errors
- Verify your API key is correct
- Ensure the API key has proper permissions
- Check if the API key has exceeded its quota
- Confirm the `ANTHROPIC_BASE_URL` is correct

### Model ID mismatch
- Ensure the correct model ID is specified for your provider
- Check the provider's documentation for valid model IDs
- Verify the model ID matches the `ANTHROPIC_DEFAULT_*` fields

## Model Aliases

Once configured, you can use these aliases to switch models:

| Provider | Aliases | Model ID |
|----------|---------|----------|
| MiniMax | `MiniMax`, `MM` | `MiniMax-M2` |
| GLM | `GLM`, `glm` | `glm-4.6` |
| Kimi | `Kimi`, `KIMI`, `kimi` | `kimi-k2-thinking` |

## Additional Resources

- [Happy CLI Documentation](./README.md)
- [Model Management Guide](./MODEL_MANAGEMENT.md)
- [Token Monitoring Guide](./TOKEN_MONITORING.md)
