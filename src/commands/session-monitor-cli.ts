/**
 * Session Monitor CLI - Real-time session token tracking
 */

import chalk from 'chalk';
import { SessionVisualizer, SessionMetrics } from '@/ui/sessionVisualizer';
import { getTokenMonitor } from '@/claude/sdk/tokenMonitor';

export interface SessionMonitorCliOptions {
  watch?: boolean;
  sessionId?: string;
  maxSessions?: number;
  showStats?: boolean;
}

export async function handleSessionMonitorCli(args: string[]): Promise<void> {
  const options = parseArgs(args);

  if (options.watch) {
    await runWatchMode(options);
  } else {
    runOnce(options);
  }
}

function parseArgs(args: string[]): SessionMonitorCliOptions {
  const options: SessionMonitorCliOptions = {
    watch: false,
    maxSessions: 5,
    showStats: true,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--watch' || arg === '-w') {
      options.watch = true;
    } else if (arg === '--session' && i + 1 < args.length) {
      options.sessionId = args[++i];
    } else if (arg === '--max-sessions' && i + 1 < args.length) {
      options.maxSessions = parseInt(args[++i], 10);
    } else if (arg === '--no-stats') {
      options.showStats = false;
    } else if (arg === '--help' || arg === '-h') {
      showHelp();
      process.exit(0);
    }
  }

  return options;
}

function runOnce(options: SessionMonitorCliOptions): void {
  const monitor = getTokenMonitor(options.sessionId);
  const sessions = getSessionData(monitor, options);

  if (sessions.length === 0) {
    console.log(chalk.yellow('No session data found'));
    return;
  }

  const visualizer = new SessionVisualizer({
    maxSessions: options.maxSessions,
    showStats: options.showStats,
  });

  sessions.forEach((session) => {
    visualizer.updateSession(session.sessionId, session);
  });

  console.log(visualizer.render());
}

async function runWatchMode(options: SessionMonitorCliOptions): Promise<void> {
  console.log(chalk.blue('Starting session monitor (Ctrl+C to exit)...\n'));

  const visualizer = new SessionVisualizer({
    maxSessions: options.maxSessions,
    showStats: options.showStats,
    refreshInterval: 500,
  });

  visualizer.start();

  // Update from token monitor
  const monitor = getTokenMonitor(options.sessionId);
  const history = monitor.getHistory();

  // Process existing history
  history.forEach((usage) => {
    if (usage.sessionId) {
      const session = getOrCreateSession(usage.sessionId, visualizer);
      session.inputTokens += usage.inputTokens;
      session.outputTokens += usage.outputTokens;
      session.totalTokens += usage.totalTokens;
      session.costUSD += usage.costUSD;
      session.requestCount += 1;
      if (usage.model) {
        session.model = usage.model;
      }
    }
  });

  // Listen for new data
  monitor.on('usage', (usage) => {
    if (usage.sessionId) {
      const session = getOrCreateSession(usage.sessionId, visualizer);
      session.inputTokens = usage.inputTokens;
      session.outputTokens = usage.outputTokens;
      session.totalTokens = usage.totalTokens;
      session.costUSD = usage.costUSD;
      session.requestCount += 1;
      if (usage.model) {
        session.model = usage.model;
      }

      visualizer.updateSession(usage.sessionId, session);
    }
  });

  // Handle Ctrl+C
  process.on('SIGINT', () => {
    console.log(chalk.yellow('\n\nStopping session monitor...'));
    visualizer.stop();
    process.exit(0);
  });

  // Keep the process running
  return new Promise(() => {});
}

function getSessionData(monitor: any, options: SessionMonitorCliOptions): SessionMetrics[] {
  const history = monitor.getHistory();
  const sessionMap = new Map<string, SessionMetrics>();

  history.forEach((usage: any) => {
    if (usage.sessionId) {
      const existing = sessionMap.get(usage.sessionId) || {
        sessionId: usage.sessionId,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        costUSD: 0,
        waitTime: 0,
        processingTime: 0,
        requestCount: 0,
        startTime: Date.now(),
        model: usage.model || 'unknown',
      };

      existing.inputTokens += usage.inputTokens;
      existing.outputTokens += usage.outputTokens;
      existing.totalTokens += usage.totalTokens;
      existing.costUSD += usage.costUSD;
      existing.requestCount += 1;

      sessionMap.set(usage.sessionId, existing);
    }
  });

  return Array.from(sessionMap.values());
}

function getOrCreateSession(sessionId: string, visualizer: SessionVisualizer): SessionMetrics {
  let session = visualizer.getSessionStats(sessionId);
  if (!session) {
    session = {
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
    };
  }
  return session;
}

function showHelp(): void {
  console.log(`
${chalk.bold('happy session-monitor')} - Real-time session token tracking

${chalk.bold('Usage:')}
  happy session-monitor [options]

${chalk.bold('Options:')}
  --watch, -w              Watch mode (real-time updates)
  --session <id>           Monitor specific session ID
  --max-sessions <n>       Maximum sessions to display (default: 5)
  --no-stats               Hide detailed statistics
  --help, -h               Show this help

${chalk.bold('Examples:')}
  happy session-monitor                 Show current session statistics
  happy session-monitor --watch         Real-time monitoring
  happy session-monitor --session abc123  Monitor specific session

${chalk.bold('Features:')}
  - Block visualization of token usage
  - Input/Output token tracking
  - Wait/Processing time analysis
  - Cost calculation
  - Efficiency scoring
`);
}
