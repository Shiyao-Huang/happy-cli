/**
 * Token Monitor - Real-time token usage tracking
 * Tracks input/output tokens, costs, and rate statistics
 */

import { EventEmitter } from 'node:events';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUSD: number;
  timestamp: number;
  model?: string;
  sessionId?: string;
}

export interface TokenRate {
  tokensPerSecond: number;
  costPerSecond: number;
  timeWindow: number; // in seconds
}

export interface TokenStats {
  totalInput: number;
  totalOutput: number;
  totalCost: number;
  currentRate: TokenRate;
  averageRate: TokenRate;
  sessionStartTime: number;
  requestCount: number;
}

export class TokenMonitor extends EventEmitter {
  private usageHistory: TokenUsage[] = [];
  private sessionStartTime = Date.now();
  private requestCount = 0;
  private currentRateWindow: TokenUsage[] = [];
  private readonly maxHistorySize = 1000;
  private readonly rateCalculationWindow = 60000; // 1 minute in ms
  private tokenUsageFile: string;

  constructor(sessionId?: string) {
    super();
    this.tokenUsageFile = join(homedir(), '.happy', 'token-usage.json');
  }

  /**
   * Record token usage from SDK result
   */
  recordUsage(usage: {
    input_tokens: number;
    output_tokens: number;
    total_cost_usd: number;
    model?: string;
    session_id?: string;
  }): TokenUsage {
    const tokenUsage: TokenUsage = {
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      totalTokens: usage.input_tokens + usage.output_tokens,
      costUSD: usage.total_cost_usd,
      timestamp: Date.now(),
      model: usage.model,
      sessionId: usage.session_id,
    };

    this.usageHistory.push(tokenUsage);
    this.currentRateWindow.push(tokenUsage);
    this.requestCount++;

    // Trim history if too large
    if (this.usageHistory.length > this.maxHistorySize) {
      this.usageHistory = this.usageHistory.slice(-this.maxHistorySize);
    }

    // Trim rate window
    this.trimRateWindow();

    // Persist to file
    this.persistUsage(tokenUsage);

    // Emit event for real-time updates
    this.emit('usage', tokenUsage);
    this.emit('stats', this.getStats());

    return tokenUsage;
  }

  /**
   * Get current token statistics
   */
  getStats(): TokenStats {
    const now = Date.now();

    // Calculate total usage
    const totalInput = this.usageHistory.reduce((sum, u) => sum + u.inputTokens, 0);
    const totalOutput = this.usageHistory.reduce((sum, u) => sum + u.outputTokens, 0);
    const totalCost = this.usageHistory.reduce((sum, u) => sum + u.costUSD, 0);

    // Calculate current rate (last minute)
    const currentRate = this.calculateRate(this.currentRateWindow, this.rateCalculationWindow);

    // Calculate average rate (entire session)
    const sessionDuration = now - this.sessionStartTime;
    const averageRate = {
      tokensPerSecond: (totalInput + totalOutput) / (sessionDuration / 1000),
      costPerSecond: totalCost / (sessionDuration / 1000),
      timeWindow: sessionDuration / 1000,
    };

    return {
      totalInput,
      totalOutput,
      totalCost,
      currentRate,
      averageRate,
      sessionStartTime: this.sessionStartTime,
      requestCount: this.requestCount,
    };
  }

  /**
   * Get usage history
   */
  getHistory(limit?: number): TokenUsage[] {
    if (limit) {
      return this.usageHistory.slice(-limit);
    }
    return [...this.usageHistory];
  }

  /**
   * Reset session statistics
   */
  reset(): void {
    this.usageHistory = [];
    this.sessionStartTime = Date.now();
    this.requestCount = 0;
    this.currentRateWindow = [];
    this.emit('reset');
  }

  /**
   * Calculate rate from usage window
   */
  private calculateRate(usages: TokenUsage[], timeWindowMs: number): TokenRate {
    if (usages.length === 0) {
      return {
        tokensPerSecond: 0,
        costPerSecond: 0,
        timeWindow: timeWindowMs / 1000,
      };
    }

    const now = Date.now();
    const windowStart = now - timeWindowMs;
    const relevantUsages = usages.filter((u) => u.timestamp >= windowStart);

    if (relevantUsages.length === 0) {
      return {
        tokensPerSecond: 0,
        costPerSecond: 0,
        timeWindow: timeWindowMs / 1000,
      };
    }

    const totalTokens = relevantUsages.reduce((sum, u) => sum + u.totalTokens, 0);
    const totalCost = relevantUsages.reduce((sum, u) => sum + u.costUSD, 0);

    // Use actual time span or configured window, whichever is smaller
    const oldestTimestamp = relevantUsages[0].timestamp;
    const actualTimeSpan = Math.max(now - oldestTimestamp, 1000); // at least 1 second
    const timeWindowSeconds = timeWindowMs / 1000;

    return {
      tokensPerSecond: totalTokens / (actualTimeSpan / 1000),
      costPerSecond: totalCost / (actualTimeSpan / 1000),
      timeWindow: timeWindowSeconds,
    };
  }

  /**
   * Trim rate window to keep only recent usages
   */
  private trimRateWindow(): void {
    const cutoff = Date.now() - this.rateCalculationWindow;
    this.currentRateWindow = this.currentRateWindow.filter((u) => u.timestamp >= cutoff);
  }

  /**
   * Persist usage to file
   */
  private persistUsage(usage: TokenUsage): void {
    try {
      const line = JSON.stringify(usage) + '\n';
      appendFileSync(this.tokenUsageFile, line);
    } catch (error) {
      // Ignore file write errors
      console.error('Failed to persist token usage:', error);
    }
  }

  /**
   * Load historical usage from file
   */
  loadHistory(): void {
    try {
      if (existsSync(this.tokenUsageFile)) {
        const content = readFileSync(this.tokenUsageFile, 'utf-8');
        const lines = content.split('\n').filter((l) => l.trim());
        this.usageHistory = lines.map((line) => JSON.parse(line));
      }
    } catch (error) {
      // Ignore file read errors
      console.error('Failed to load token usage history:', error);
    }
  }

  /**
   * Get usage for specific model
   */
  getUsageByModel(model?: string): TokenStats {
    const filtered = model ? this.usageHistory.filter((u) => u.model === model) : this.usageHistory;

    const totalInput = filtered.reduce((sum, u) => sum + u.inputTokens, 0);
    const totalOutput = filtered.reduce((sum, u) => sum + u.outputTokens, 0);
    const totalCost = filtered.reduce((sum, u) => sum + u.costUSD, 0);
    const currentRate = this.calculateRate(filtered, this.rateCalculationWindow);

    return {
      totalInput,
      totalOutput,
      totalCost,
      currentRate,
      averageRate: {
        tokensPerSecond: (totalInput + totalOutput) / ((Date.now() - this.sessionStartTime) / 1000),
        costPerSecond: totalCost / ((Date.now() - this.sessionStartTime) / 1000),
        timeWindow: (Date.now() - this.sessionStartTime) / 1000,
      },
      sessionStartTime: this.sessionStartTime,
      requestCount: filtered.length,
    };
  }

  /**
   * Get top models by usage
   */
  getTopModels(
    limit = 10
  ): Array<{ model: string; totalTokens: number; totalCost: number; requestCount: number }> {
    const modelMap = new Map<
      string,
      { totalTokens: number; totalCost: number; requestCount: number }
    >();

    this.usageHistory.forEach((u) => {
      if (!u.model) return;
      const existing = modelMap.get(u.model) || { totalTokens: 0, totalCost: 0, requestCount: 0 };
      modelMap.set(u.model, {
        totalTokens: existing.totalTokens + u.totalTokens,
        totalCost: existing.totalCost + u.costUSD,
        requestCount: existing.requestCount + 1,
      });
    });

    return Array.from(modelMap.entries())
      .map(([model, stats]) => ({ model, ...stats }))
      .sort((a, b) => b.totalTokens - a.totalTokens)
      .slice(0, limit);
  }
}

// Global instance
let globalMonitor: TokenMonitor | null = null;

export function getTokenMonitor(sessionId?: string): TokenMonitor {
  if (!globalMonitor) {
    globalMonitor = new TokenMonitor(sessionId);
  }
  return globalMonitor;
}

export function createNewMonitor(sessionId?: string): TokenMonitor {
  return new TokenMonitor(sessionId);
}
