# Getting Started with Token Monitoring

## Quick Start

### 1. Basic Usage

Replace your existing `query()` calls with `createMonitoredQuery()`:

```typescript
// Before
import { query } from '@/claude/sdk'

const q = query({
    prompt: 'Your prompt here',
    options: { model: 'claude-3-5-sonnet' }
})

for await (const message of q) {
    // handle messages
}
```

```typescript
// After
import { createMonitoredQuery } from '@/claude/sdk'

const { query, tokenMonitor } = createMonitoredQuery({
    prompt: 'Your prompt here',
    options: { model: 'claude-3-5-sonnet' }
})

for await (const message of query) {
    // handle messages
}

// Get usage statistics
const stats = tokenMonitor.getStats()
console.log(`Cost: $${stats.totalCost}`)
```

### 2. View Real-time Statistics

Run the dashboard to see live token usage:

```bash
# Compile first
npm run build

# Start dashboard
node dist/commands/dashboard.js
```

### 3. Switch Models

```typescript
import { getModelManager } from '@/claude/sdk'

const modelManager = getModelManager()

// List available models
console.log(modelManager.getAllProfiles())

// Switch to a different model
modelManager.switchModel('claude-3-5-haiku')

// Auto-switch based on cost
modelManager.autoSwitch('cheap')  // Switch to cheaper model
```

## Common Use Cases

### Use Case 1: Track Costs Per Request

```typescript
import { createMonitoredQuery } from '@/claude/sdk'

const requests = [
    'Generate a Python script',
    'Explain machine learning',
    'Write unit tests'
]

for (const prompt of requests) {
    const { query, tokenMonitor } = createMonitoredQuery({
        prompt,
        options: { maxTurns: 1 }
    })

    for await (const message of query) {
        if (message.type === 'result') {
            const stats = tokenMonitor.getStats()
            console.log(`Request cost: $${stats.totalCost.toFixed(6)}`)
        }
    }
}
```

### Use Case 2: Auto-switch Based on Budget

```typescript
import { getModelManager, getTokenMonitor } from '@/claude/sdk'

const modelManager = getModelManager()
const monitor = getTokenMonitor()

// Check if we've exceeded budget
const stats = monitor.getStats()
if (stats.totalCost > 10) {
    console.log('Budget exceeded, switching to cheaper model')
    modelManager.switchModel('claude-3-5-haiku')
}
```

### Use Case 3: Monitor Model Performance

```typescript
import { getModelManager } from '@/claude/sdk'

const modelManager = getModelManager()

// Get usage breakdown by model
const modelStats = modelManager.getModelUsageStats()

modelStats.forEach(stat => {
    const avgCost = stat.totalCost / stat.totalRequests
    console.log(`${stat.modelId}:`)
    console.log(`  Average cost per request: $${avgCost.toFixed(6)}`)
    console.log(`  Total requests: ${stat.totalRequests}`)
})
```

### Use Case 4: Real-time Rate Monitoring

```typescript
import { getTokenMonitor } from '@/claude/sdk'

const monitor = getTokenMonitor()

// Listen for real-time updates
monitor.on('usage', (usage) => {
    console.log(`New request: ${usage.totalTokens} tokens, $${usage.costUSD.toFixed(6)}`)
})

monitor.on('stats', (stats) => {
    console.log(`Current rate: ${stats.currentRate.tokensPerSecond.toFixed(2)} tokens/sec`)
})
```

## Configuration

### Model Profiles

Model profiles are stored in `~/.happy/model-config.json`:

```json
{
  "profiles": {
    "claude-3-5-sonnet": {
      "name": "claude-3-5-sonnet",
      "displayName": "Claude 3.5 Sonnet",
      "provider": "anthropic",
      "modelId": "claude-3-5-sonnet-20241022",
      "costPer1KInput": 0.003,
      "costPer1KOutput": 0.015,
      "tags": ["reasoning", "coding"],
      "isActive": true
    }
  },
  "activeProfile": "claude-3-5-sonnet"
}
```

### Usage History

Token usage is logged to `~/.happy/token-usage.json` in JSONL format:

```json
{"inputTokens": 150, "outputTokens": 300, "totalTokens": 450, "costUSD": 0.0054, "timestamp": 1635789012345, "model": "claude-3-5-sonnet-20241022"}
```

## CLI Commands

### View Token Statistics

```bash
# View current stats
node dist/commands/token-stats.js

# View compact stats
node dist/commands/token-stats.js --format compact

# View JSON
node dist/commands/token-stats.js --format json

# View specific model
node dist/commands/token-stats.js --model claude-3-5-sonnet

# Watch mode (updates every 2s)
node dist/commands/token-stats.js --watch --interval 2000
```

### Manage Models

```bash
# List all models
node dist/commands/model-switch.js --list

# Switch model
node dist/commands/model-switch.js --set claude-3-5-haiku

# Add custom model
node dist/commands/model-switch.js --add my-model --cost "0.003:0.015" --tags "fast"

# Auto-switch
node dist/commands/model-switch.js --auto cheap

# Export config
node dist/commands/model-switch.js --export config.json

# Import config
node dist/commands/model-switch.js --import config.json
```

### Dashboard

```bash
# Start dashboard
node dist/commands/dashboard.js

# Custom refresh rate
node dist/commands/dashboard.js --refresh 500
```

## Tips

1. **Use monitored queries by default**: Replace `query()` with `createMonitoredQuery()` to get automatic monitoring

2. **Check costs before expensive operations**:
   ```typescript
   const stats = tokenMonitor.getStats()
   if (stats.totalCost > budgetLimit) {
       // Switch to cheaper model or stop
   }
   ```

3. **Use auto-switching for cost optimization**:
   ```typescript
   modelManager.autoSwitch('balanced')
   ```

4. **Monitor real-time with event listeners**:
   ```typescript
   tokenMonitor.on('usage', (usage) => {
       // React to each request
   })
   ```

5. **Track multiple models**:
   ```typescript
   const modelStats = modelManager.getModelUsageStats()
   // Find most/least cost-effective models
   ```

## Troubleshooting

### Stats show 0 usage
- Make sure you're using `createMonitoredQuery()` instead of `query()`
- Check that your queries are completing successfully

### Model not switching
- Verify the model name exists: `modelManager.getProfile(name)`
- Check that the model has the correct configuration

### Dashboard not updating
- Ensure you're using monitored queries
- Check that the token monitor is receiving usage events

## Next Steps

- Read the full [API documentation](./TOKEN_MONITORING.md)
- Explore the [examples](./examples/token-monitoring-example.ts)
- Customize [model profiles](#configuration) for your needs
- Set up [automated switching](#use-case-2-auto-switch-based-on-budget) based on your budget
