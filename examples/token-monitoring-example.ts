/**
 * Example: Using Token Monitoring in Claude Code SDK
 *
 * This example demonstrates how to:
 * 1. Set up token monitoring
 * 2. Execute a query with monitoring
 * 3. View real-time statistics
 * 4. Switch models based on usage
 */

import {
  createMonitoredQuery,
  getTokenMonitor,
  getModelManager,
} from '../dist/claude/sdk/index.js';
import { handleTokenStats } from '../dist/commands/token-stats.js';
import { handleDashboard } from '../dist/commands/dashboard.js';

async function example1BasicMonitoring() {
  console.log('\n=== Example 1: Basic Token Monitoring ===\n');

  // Create a monitored query
  const { query, tokenMonitor } = createMonitoredQuery({
    prompt: 'Explain the concept of machine learning in simple terms',
    options: {
      model: 'claude-3-5-sonnet-20241022',
      maxTurns: 1,
    },
  });

  console.log('Executing query with token monitoring...\n');

  // Execute the query
  for await (const message of query) {
    if (message.type === 'result') {
      console.log('\nQuery completed!');
    }
  }

  // Get and display statistics
  const stats = tokenMonitor.getStats();
  console.log('\nToken Usage Statistics:');
  console.log(`  Total Input Tokens:  ${stats.totalInput.toLocaleString()}`);
  console.log(`  Total Output Tokens: ${stats.totalOutput.toLocaleString()}`);
  console.log(`  Total Cost:          $${stats.totalCost.toFixed(6)}`);
  console.log(`  Current Rate:        ${stats.currentRate.tokensPerSecond.toFixed(2)} tokens/sec`);
  console.log(`  Requests:            ${stats.requestCount}`);
}

async function example2ModelSwitching() {
  console.log('\n=== Example 2: Model Switching ===\n');

  const modelManager = getModelManager();

  // Show current active model
  console.log('Current active model:');
  const active = modelManager.getActiveProfile();
  if (active) {
    console.log(`  ${active.displayName || active.name}`);
    console.log(`  Model ID: ${active.modelId}`);
  }

  // Switch to a different model
  console.log('\nSwitching to Claude 3.5 Haiku...');
  modelManager.switchModel('claude-3-5-haiku');

  // Show updated active model
  console.log('\nNew active model:');
  const newActive = modelManager.getActiveProfile();
  if (newActive) {
    console.log(`  ${newActive.displayName || newActive.name}`);
    console.log(`  Model ID: ${newActive.modelId}`);
  }

  // Run a query with the new model
  const { query, tokenMonitor } = createMonitoredQuery({
    prompt: 'What is the time complexity of binary search?',
    options: {
      maxTurns: 1,
    },
  });

  console.log('\nExecuting query with Haiku model...\n');

  for await (const message of query) {
    if (message.type === 'result') {
      console.log('\nQuery completed with Haiku!');
    }
  }

  // Show model usage breakdown
  const modelStats = modelManager.getModelUsageStats();
  console.log('\nModel Usage Breakdown:');
  modelStats.forEach((stat) => {
    const avgCost = stat.totalCost / stat.totalRequests;
    console.log(`  ${stat.modelId}:`);
    console.log(`    Requests: ${stat.totalRequests}`);
    console.log(`    Total cost: $${stat.totalCost.toFixed(6)}`);
    console.log(`    Avg cost/request: $${avgCost.toFixed(6)}`);
  });
}

async function example3RealTimeMonitoring() {
  console.log('\n=== Example 3: Real-time Monitoring with Multiple Queries ===\n');

  const tokenMonitor = getTokenMonitor();
  const modelManager = getModelManager();

  // Set up event listener for real-time updates
  tokenMonitor.on('usage', (usage) => {
    console.log(
      `⚡ New usage: ${usage.totalTokens} tokens, ` +
        `$${usage.costUSD.toFixed(6)} (${usage.model || 'unknown'})`
    );
  });

  // Run multiple queries with different models
  const queries = [
    { prompt: 'Write a hello world program in Python', model: 'claude-3-5-sonnet' },
    { prompt: 'What is 2+2?', model: 'claude-3-5-haiku' },
    { prompt: 'Explain quantum computing', model: 'claude-3-5-sonnet' },
    { prompt: 'What is the capital of France?', model: 'claude-3-5-haiku' },
  ];

  for (const { prompt, model } of queries) {
    console.log(`\n--- Running query with ${model} ---`);
    const { query } = createMonitoredQuery({
      prompt,
      options: { model, maxTurns: 1 },
    });

    for await (const message of query) {
      if (message.type === 'result') {
        console.log('Query completed!');
      }
    }
  }

  // Show final statistics
  console.log('\n=== Final Statistics ===');
  const stats = tokenMonitor.getStats();
  console.log(`Total Input:  ${stats.totalInput.toLocaleString()}`);
  console.log(`Total Output: ${stats.totalOutput.toLocaleString()}`);
  console.log(`Total Cost:   $${stats.totalCost.toFixed(6)}`);
  console.log(`Total Rate:   ${stats.currentRate.tokensPerSecond.toFixed(2)} tokens/sec`);

  // Show top models
  const topModels = tokenMonitor.getTopModels(3);
  console.log('\nTop Models:');
  topModels.forEach((model, index) => {
    console.log(
      `  ${index + 1}. ${model.model}: ${model.requestCount} req, $${model.totalCost.toFixed(4)}`
    );
  });
}

async function example4AutoSwitching() {
  console.log('\n=== Example 4: Auto-Switching Based on Usage ===\n');

  const modelManager = getModelManager();
  const tokenMonitor = getTokenMonitor();

  // Get recommendations
  const stats = tokenMonitor.getStats();
  if (stats.requestCount > 0) {
    const avgUsage = {
      avgInputTokens: stats.totalInput / stats.requestCount,
      avgOutputTokens: stats.totalOutput / stats.requestCount,
      avgCost: stats.totalCost / stats.requestCount,
    };

    const recommendations = modelManager.getRecommendations(avgUsage);
    console.log('Model Recommendations:');
    recommendations.slice(0, 3).forEach((rec) => {
      console.log(`  ${rec.profile.name}: ${rec.reason} (score: ${rec.score})`);
    });
  }

  // Auto-switch based on current usage
  console.log('\nAuto-switching based on expensive usage...');
  modelManager.autoSwitch('expensive');

  const active = modelManager.getActiveProfile();
  console.log(`Switched to: ${active?.displayName || active?.name}`);

  // Run a query
  const { query } = createMonitoredQuery({
    prompt: 'Write a function to sort an array',
    options: { maxTurns: 1 },
  });

  console.log('\nRunning query with auto-selected model...\n');

  for await (const message of query) {
    if (message.type === 'result') {
      console.log('\nQuery completed!');
    }
  }
}

async function example5Dashboard() {
  console.log('\n=== Example 5: Interactive Dashboard ===\n');
  console.log('Starting real-time dashboard (will run for 10 seconds)...\n');

  // Create a monitored query
  const { query, tokenMonitor } = createMonitoredQuery({
    prompt: 'Generate a detailed explanation of blockchain technology',
    options: {
      model: 'claude-3-5-sonnet-20241022',
      maxTurns: 1,
    },
  });

  // Start the dashboard
  const dashboardPromise = new Promise<void>((resolve) => {
    setTimeout(() => resolve(), 10000);
    handleDashboard({ refresh: 500 });
  });

  // Start the query
  const queryPromise = new Promise<void>(async (resolve) => {
    for await (const message of query) {
      if (message.type === 'result') {
        resolve();
      }
    }
  });

  await Promise.all([dashboardPromise, queryPromise]);
  console.log('\nDashboard example completed!');
}

// Main execution
async function main() {
  console.log('\n╔════════════════════════════════════════════════════════════╗');
  console.log('║     Token Monitoring and Model Management Examples        ║');
  console.log('╚════════════════════════════════════════════════════════════╝\n');

  try {
    // Run examples
    await example1BasicMonitoring();
    await new Promise((resolve) => setTimeout(resolve, 1000));

    await example2ModelSwitching();
    await new Promise((resolve) => setTimeout(resolve, 1000));

    await example3RealTimeMonitoring();
    await new Promise((resolve) => setTimeout(resolve, 1000));

    await example4AutoSwitching();
    await new Promise((resolve) => setTimeout(resolve, 1000));

    await example5Dashboard();

    console.log('\n✓ All examples completed successfully!\n');
  } catch (error) {
    console.error('\n✗ Error running examples:', error);
    process.exit(1);
  }
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

export {
  example1BasicMonitoring,
  example2ModelSwitching,
  example3RealTimeMonitoring,
  example4AutoSwitching,
  example5Dashboard,
};
