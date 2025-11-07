/**
 * Session Visualizer - Real-time session token tracking with block visualization
 * Inspired by kilo cline's block display for input/output/wait visualization
 */

import chalk from 'chalk';
import { EventEmitter } from 'node:events';

export interface SessionMetrics {
  sessionId: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUSD: number;
  waitTime: number; // ms waiting for response
  processingTime: number; // ms processing response
  requestCount: number;
  startTime: number;
  model: string;
}

export interface SessionVisualizerOptions {
  blockWidth?: number; // Width of each block (default: 50)
  showStats?: boolean; // Show detailed statistics (default: true)
  refreshInterval?: number; // ms between refreshes (default: 100)
  maxSessions?: number; // Max sessions to display (default: 5)
}

export class SessionVisualizer extends EventEmitter {
  private sessions: Map<string, SessionMetrics> = new Map();
  private options: SessionVisualizerOptions;
  private refreshTimer: NodeJS.Timeout | null = null;
  private isRunning = false;

  constructor(options: SessionVisualizerOptions = {}) {
    super();
    this.options = {
      blockWidth: 50,
      showStats: true,
      refreshInterval: 100,
      maxSessions: 5,
      ...options,
    };
  }

  /**
   * Start visualizing sessions
   */
  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    this.refresh();
    this.refreshTimer = setInterval(() => this.refresh(), this.options.refreshInterval!);
  }

  /**
   * Stop visualizing
   */
  stop(): void {
    this.isRunning = false;
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  /**
   * Update or add a session
   */
  updateSession(sessionId: string, metrics: Partial<SessionMetrics>): void {
    const existing = this.sessions.get(sessionId);
    if (existing) {
      this.sessions.set(sessionId, { ...existing, ...metrics });
    } else {
      this.sessions.set(sessionId, {
        sessionId,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        costUSD: 0,
        waitTime: 0,
        processingTime: 0,
        requestCount: 0,
        startTime: Date.now(),
        model: 'unknown',
        ...metrics,
      });
    }

    this.emit('sessionUpdate', this.sessions.get(sessionId));
  }

  /**
   * Remove a session
   */
  removeSession(sessionId: string): void {
    this.sessions.delete(sessionId);
    this.emit('sessionRemoved', sessionId);
  }

  /**
   * Get all active sessions
   */
  getSessions(): SessionMetrics[] {
    return Array.from(this.sessions.values());
  }

  /**
   * Get statistics for a specific session
   */
  getSessionStats(sessionId: string): SessionMetrics | null {
    return this.sessions.get(sessionId) || null;
  }

  /**
   * Clear all sessions
   */
  clear(): void {
    this.sessions.clear();
  }

  /**
   * Render visualization to console
   */
  render(): string {
    if (this.sessions.size === 0) {
      return chalk.gray('  No active sessions');
    }

    const sessions = Array.from(this.sessions.values())
      .sort((a, b) => b.totalTokens - a.totalTokens)
      .slice(0, this.options.maxSessions);

    let output = '\n';

    sessions.forEach((session, index) => {
      output += this.renderSessionBlock(session, index);
    });

    return output;
  }

  /**
   * Render a single session block
   */
  private renderSessionBlock(session: SessionMetrics, index: number): string {
    const elapsed = Date.now() - session.startTime;
    const efficiency = this.calculateEfficiency(session);

    // Session header
    const headerColor = [cyan, green, yellow, magenta, red][index % 5];
    const sessionLabel = `Session ${index + 1}`;
    const modelLabel = session.model.substring(0, 20);

    let block = `${chalk.bold(headerColor(sessionLabel))} ${chalk.gray('(')}${chalk.blue(modelLabel)}${chalk.gray(')')}\n`;
    block += `  ${chalk.gray('ID:')}${chalk.white(session.sessionId.substring(0, 8))}\n`;

    // Token blocks
    block += '\n';
    block += this.renderTokenBlock('INPUT', session.inputTokens, chalk.blue);
    block += this.renderTokenBlock('OUTPUT', session.outputTokens, chalk.green);
    block += this.renderTimeBlock('WAIT', session.waitTime, chalk.yellow);
    block += this.renderTimeBlock('PROC', session.processingTime, chalk.magenta);

    // Statistics
    if (this.options.showStats) {
      block += '\n';
      block += `  ${chalk.gray('Total:')}${chalk.white(session.totalTokens.toLocaleString())} tokens `;
      block += `${chalk.gray('Cost:')}${chalk.yellow('$' + session.costUSD.toFixed(4))} `;
      block += `${chalk.gray('Rate:')}${chalk.cyan((session.totalTokens / (elapsed / 1000)).toFixed(1))} t/s `;
      block += `${chalk.gray('Eff:')}${this.renderEfficiency(efficiency)}\n`;
    }

    // ASCII art bar
    block += this.renderAsciiBar(session) + '\n';
    block += '\n';

    return block;
  }

  /**
   * Render token block with visual representation
   */
  private renderTokenBlock(label: string, value: number, color: typeof chalk.blue): string {
    const blockWidth = this.options.blockWidth!;
    const maxValue = 10000; // Normalize to 10K tokens
    const filledBlocks = Math.min(Math.floor((value / maxValue) * blockWidth), blockWidth);
    const emptyBlocks = blockWidth - filledBlocks;

    const block = '█'.repeat(filledBlocks) + '░'.repeat(emptyBlocks);
    const percentage = ((value / maxValue) * 100).toFixed(1);

    return `  ${chalk.gray(label)}: ${color(block)} ${chalk.white(value.toLocaleString())} (${percentage}%)\n`;
  }

  /**
   * Render time block
   */
  private renderTimeBlock(label: string, value: number, color: typeof chalk.yellow): string {
    const blockWidth = this.options.blockWidth!;
    const maxValue = 10000; // Normalize to 10s
    const filledBlocks = Math.min(Math.floor((value / maxValue) * blockWidth), blockWidth);
    const emptyBlocks = blockWidth - filledBlocks;

    const block = '▓'.repeat(filledBlocks) + '▒'.repeat(emptyBlocks);
    const timeStr = value < 1000 ? `${value.toFixed(0)}ms` : `${(value / 1000).toFixed(1)}s`;
    const percentage = ((value / maxValue) * 100).toFixed(1);

    return `  ${chalk.gray(label)}: ${color(block)} ${chalk.white(timeStr)} (${percentage}%)\n`;
  }

  /**
   * Render ASCII efficiency bar
   */
  private renderAsciiBar(session: SessionMetrics): string {
    const width = 60;
    const efficiency = this.calculateEfficiency(session);

    const filled = Math.floor((efficiency / 100) * width);
    const empty = width - filled;

    const bar = '█'.repeat(filled) + '░'.repeat(empty);
    const color = efficiency > 80 ? chalk.green : efficiency > 50 ? chalk.yellow : chalk.red;

    return `  ${chalk.gray('Efficiency:')} ${color(bar)} ${chalk.white(efficiency.toFixed(0) + '%')}`;
  }

  /**
   * Calculate efficiency score
   */
  private calculateEfficiency(session: SessionMetrics): number {
    if (session.requestCount === 0) return 0;

    const totalTime = session.waitTime + session.processingTime;
    if (totalTime === 0) return 0;

    // Efficiency = (processing time / total time) * 100
    // Higher processing time = better efficiency (less waiting)
    const efficiency = (session.processingTime / totalTime) * 100;
    return Math.min(Math.max(efficiency, 0), 100);
  }

  /**
   * Render efficiency with color
   */
  private renderEfficiency(efficiency: number): string {
    if (efficiency > 80) {
      return chalk.green(efficiency.toFixed(0) + '%');
    } else if (efficiency > 50) {
      return chalk.yellow(efficiency.toFixed(0) + '%');
    } else {
      return chalk.red(efficiency.toFixed(0) + '%');
    }
  }

  /**
   * Refresh display
   */
  private refresh(): void {
    if (!this.isRunning) return;

    // Clear screen and move cursor to top
    process.stdout.write('\x1B[2J\x1B[0f');
    process.stdout.write(this.render());
    process.stdout.write('\n');
  }
}

// Color helpers
const cyan = chalk.cyan;
const green = chalk.green;
const yellow = chalk.yellow;
const magenta = chalk.magenta;
const red = chalk.red;
