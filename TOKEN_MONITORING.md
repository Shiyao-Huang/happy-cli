# Token Monitoring and Model Management

This enhancement to happy-cli-augment provides real-time token usage monitoring,
model configuration management, and cost tracking for Claude Code.

## Features

### 1. Real-time Token Monitoring

- **Live tracking** of input/output tokens
- **Rate calculation** (tokens per second, cost per second)
- **Usage history** with persistent storage
- **Model-specific** statistics
- **Top models** by usage

### 2. Model Configuration Management

- **Multiple model profiles** with custom settings
- **Dynamic model switching** without code changes
- **Cost tracking** per model
- **Auto-switching** based on usage patterns
- **Export/Import** configurations

### 3. Real-time Dashboard

- **Live visualization** of token usage
- **Rate indicators** with visual bars
- **Model breakdown** and rankings
- **Recent activity** log

## Installation

The token monitoring modules are already integrated into the SDK. Simply import
and use them:

```typescript
import {
  createMonitoredQuery,
  getTokenMonitor,
  getModelManager,
} from '@/claude/sdk';
```

## Usage

### Basic Monitoring

```typescript
import { createMonitoredQuery } from '@/claude/sdk';

// Create a monitored query
const { query, tokenMonitor } = createMonitoredQuery({
  prompt: 'Explain quantum computing',
  options: {
    model: 'claude-3-5-sonnet-20241022',
  },
});

// Iterate through results
for await (const message of query) {
  console.log(message);
}

// Get statistics
const stats = tokenMonitor.getStats();
console.log(`Total tokens: ${stats.totalInput + stats.totalOutput}`);
console.log(`Current rate: ${stats.currentRate.tokensPerSecond} tokens/sec`);
console.log(`Total cost: $${stats.totalCost}`);
```

### Model Management

```typescript
import { getModelManager } from '@/claude/sdk';

const modelManager = getModelManager();

// List all models
const models = modelManager.getAllProfiles();
console.log(models);

// Switch to a different model
modelManager.switchModel('claude-3-5-haiku');

// Get current active model
const active = modelManager.getActiveProfile();
console.log(`Active: ${active?.displayName}`);

// Auto-switch based on usage
modelManager.autoSwitch('cheap'); // Switch to cheaper model
modelManager.autoSwitch('expensive'); // Switch to more capable model
```

### Real-time Dashboard

Run the dashboard to see live token usage:

```bash
node -e "
import('./dist/commands/dashboard.js').then(m => {
  m.handleDashboard({ refresh: 1000 });
})
"
```

### Token Statistics

View detailed token usage:

```bash
node -e "
import('./dist/commands/token-stats.js').then(m => {
  m.handleTokenStats({ format: 'table' });
})
"
```

### Model Switching

Manage model configurations:

```bash
node -e "
import('./dist/commands/model-switch.js').then(m => {
  m.handleModelSwitch({ list: true });
})
"
```

## CLI Commands

### Token Stats

```bash
# Show current token usage
npm run token-stats

# Show compact view
npm run token-stats -- --format compact

# Show JSON output
npm run token-stats -- --format json

# Show stats for specific model
npm run token-stats -- --model claude-3-5-sonnet

# Watch mode (updates every 2 seconds)
npm run token-stats -- --watch --interval 2000
```

### Model Switch

```bash
# List all models
npm run model-switch -- --list

# Switch to a model
npm run model-switch -- --set claude-3-5-haiku

# Add a new model
npm run model-switch -- --add my-model --cost "0.003:0.015" --tags "fast,cheap"

# Remove a model
npm run model-switch -- --remove my-model

# Auto-switch based on usage
npm run model-switch -- --auto cheap
npm run model-switch -- --auto expensive
npm run model-switch -- --auto balanced

# Export configuration
npm run model-switch -- --export model-config.json

# Import configuration
npm run model-switch -- --import model-config.json
```

### Dashboard

```bash
# Start real-time dashboard
npm run dashboard

# Dashboard with custom refresh rate
npm run dashboard -- --refresh 500  # 0.5 second updates
```

## API Reference

### TokenMonitor

```typescript
class TokenMonitor extends EventEmitter {
  // Record token usage
  recordUsage(usage: {
    input_tokens: number;
    output_tokens: number;
    total_cost_usd: number;
    model?: string;
    session_id?: string;
  }): TokenUsage;

  // Get current statistics
  getStats(): TokenStats;

  // Get usage history
  getHistory(limit?: number): TokenUsage[];

  // Get stats for specific model
  getUsageByModel(model?: string): TokenStats;

  // Get top models by usage
  getTopModels(
    limit = 10
  ): Array<{
    model: string;
    totalTokens: number;
    totalCost: number;
    requestCount: number;
  }>;

  // Reset session statistics
  reset(): void;
}
```

### ModelManager

```typescript
class ModelManager {
  // Get all profiles
  getAllProfiles(): ModelProfile[];

  // Get active profile
  getActiveProfile(): ModelProfile | null;

  // Switch to a model
  switchModel(name: string): boolean;

  // Add or update a model
  upsertProfile(
    profile: Omit<ModelProfile, 'createdAt' | 'updatedAt'>
  ): ModelProfile;

  // Remove a model
  removeProfile(name: string): boolean;

  // Auto-switch based on usage pattern
  autoSwitch(pattern: 'expensive' | 'cheap' | 'balanced'): boolean;

  // Get model usage statistics
  getModelUsageStats(name?: string): ModelUsageStats[];

  // Find best model by criteria
  findBestModel(criteria: {
    maxCost?: number;
    minSpeed?: number;
    maxTokens?: number;
    tags?: string[];
  }): ModelProfile | null;

  // Get recommendations
  getRecommendations(currentUsage?: {
    avgInputTokens: number;
    avgOutputTokens: number;
    avgCost: number;
  }): Array<{ profile: ModelProfile; reason: string; score: number }>;
}
```

### createMonitoredQuery

```typescript
function createMonitoredQuery(config: {
  prompt: QueryPrompt;
  options?: QueryOptions;
  sessionId?: string;
}): {
  query: MonitoredQuery;
  tokenMonitor: TokenMonitor;
};
```

## Model Profiles

A model profile contains:

```typescript
interface ModelProfile {
  name: string; // Unique identifier
  displayName?: string; // Human-readable name
  provider: 'anthropic' | 'openai' | 'gemini' | 'custom';
  modelId: string; // API model ID
  fallbackModelId?: string; // Fallback model ID
  costPer1KInput: number; // Cost per 1K input tokens
  costPer1KOutput: number; // Cost per 1K output tokens
  maxTokens?: number; // Maximum tokens
  description?: string; // Model description
  tags: string[]; // Tags for categorization
  isActive: boolean; // Active status
  createdAt: number; // Creation timestamp
  updatedAt: number; // Last update timestamp
}
```

## Configuration Files

Token usage is stored in:

- `~/.happy/token-usage.json` - Usage history (JSONL format)

Model configuration is stored in:

- `~/.happy/model-config.json` - Model profiles and active model

## Examples

### Example 1: Track a Query

```typescript
import { createMonitoredQuery } from '@/claude/sdk';

const { query, tokenMonitor } = createMonitoredQuery({
  prompt: 'Write a Python function to calculate fibonacci numbers',
  options: {
    model: 'claude-3-5-sonnet-20241022',
    maxTurns: 1,
  },
});

console.log('Starting query...');

for await (const message of query) {
  if (message.type === 'result') {
    const stats = tokenMonitor.getStats();
    console.log(`Completed! Total cost: $${stats.totalCost}`);
  }
}
```

### Example 2: Switch Models Based on Cost

```typescript
import { getModelManager, getTokenMonitor } from '@/claude/sdk';

const modelManager = getModelManager();
const monitor = getTokenMonitor();

// Run a few queries and check cost
const stats = monitor.getStats();

if (stats.totalCost > 5) {
  console.log('Cost is getting high, switching to cheaper model');
  modelManager.switchModel('claude-3-5-haiku');
} else if (stats.totalCost < 0.5) {
  console.log('Cost is low, switching to more capable model');
  modelManager.switchModel('claude-3-5-sonnet');
}
```

### Example 3: Monitor Multiple Models

```typescript
import { getModelManager, getTokenMonitor } from '@/claude/sdk';

const modelManager = getModelManager();
const monitor = getTokenMonitor();

// Get usage breakdown by model
const modelStats = modelManager.getModelUsageStats();

modelStats.forEach((stat) => {
  const avgCost = stat.totalCost / stat.totalRequests;
  console.log(`${stat.modelId}:`);
  console.log(`  Total requests: ${stat.totalRequests}`);
  console.log(`  Average cost per request: $${avgCost.toFixed(4)}`);
  console.log(`  Total cost: $${stat.totalCost.toFixed(4)}`);
});
```

### Example 4: Real-time Rate Monitoring

```typescript
import { getTokenMonitor } from '@/claude/sdk';

const monitor = getTokenMonitor();

// Listen for real-time updates
monitor.on('usage', (usage) => {
  console.log(
    `New usage: ${usage.totalTokens} tokens, $${usage.costUSD.toFixed(6)}`
  );
});

// Also listen for stats updates
monitor.on('stats', (stats) => {
  console.log(
    `Current rate: ${stats.currentRate.tokensPerSecond.toFixed(2)} tokens/sec`
  );
});
```

## Benefits

1. **Real-time Monitoring**: See token usage as it happens, not after the fact
2. **Cost Awareness**: Track exactly how much you're spending
3. **Model Optimization**: Switch to the best model for your needs and budget
4. **Usage Patterns**: Understand how you use different models
5. **Automated Switching**: Let the system optimize model selection based on
   usage

## Integration with Existing Code

The monitoring is non-intrusive. You can:

1. Use `createMonitoredQuery()` instead of `query()` to get automatic monitoring
2. Use `getTokenMonitor()` to access monitoring in existing code
3. Use `getModelManager()` to manage models alongside existing code

No changes to your existing queries are required - the monitoring happens
automatically in the background.
