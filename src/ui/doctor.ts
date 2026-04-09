/**
 * Doctor command implementation
 *
 * Provides comprehensive diagnostics and troubleshooting information
 * for aha CLI including configuration, daemon status, logs, and links
 */

import chalk from 'chalk'
import { configuration } from '@/configuration'
import { readSettings, readCredentials } from '@/persistence'
import { checkIfDaemonRunningAndCleanupStaleState } from '@/daemon/controlClient'
import { findRunawayAhaProcesses, findAllAhaProcesses } from '@/daemon/doctor'
import { readDaemonState } from '@/persistence'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { projectPath } from '@/projectPath'
import packageJson from '../../package.json'
import { t } from '@/i18n'

/**
 * Get relevant environment information for debugging
 */
export function getEnvironmentInfo(): Record<string, any> {
    return {
        PWD: process.env.PWD,
        AHA_HOME_DIR: process.env.AHA_HOME_DIR,
        AHA_SERVER_URL: process.env.AHA_SERVER_URL,
        AHA_PROJECT_ROOT: process.env.AHA_PROJECT_ROOT,
        DANGEROUSLY_LOG_TO_SERVER_FOR_AI_AUTO_DEBUGGING: process.env.DANGEROUSLY_LOG_TO_SERVER_FOR_AI_AUTO_DEBUGGING,
        NODE_ENV: process.env.NODE_ENV,
        DEBUG: process.env.DEBUG,
        workingDirectory: process.cwd(),
        processArgv: process.argv,
        ahaDir: configuration?.ahaHomeDir,
        serverUrl: configuration?.serverUrl,
        logsDir: configuration?.logsDir,
        processPid: process.pid,
        nodeVersion: process.version,
        platform: process.platform,
        arch: process.arch,
        user: process.env.USER,
        home: process.env.HOME,
        shell: process.env.SHELL,
        terminal: process.env.TERM,
    };
}

function getLogFiles(logDir: string): { file: string, path: string, modified: Date }[] {
    if (!existsSync(logDir)) {
        return [];
    }

    try {
        return readdirSync(logDir)
            .filter(file => file.endsWith('.log'))
            .map(file => {
                const path = join(logDir, file);
                const stats = statSync(path);
                return { file, path, modified: stats.mtime };
            })
            .sort((a, b) => b.modified.getTime() - a.modified.getTime());
    } catch {
        return [];
    }
}

/**
 * Run doctor command specifically for daemon diagnostics
 */
export async function runDoctorDaemon(): Promise<void> {
    return runDoctorCommand('daemon');
}

export async function runDoctorCommand(filter?: 'all' | 'daemon'): Promise<void> {
    // Default to 'all' if no filter specified
    if (!filter) {
        filter = 'all';
    }

    console.log(chalk.bold.cyan(t('doctor.title')));

    // For 'all' filter, show everything. For 'daemon', only show daemon-related info
    if (filter === 'all') {
        // Version and basic info
        console.log(chalk.bold(t('doctor.basicInfo')));
        console.log(`${t('doctor.cliVersionLabel')}${chalk.green(packageJson.version)}`);
        console.log(`${t('doctor.platformLabel')}${chalk.green(process.platform)} ${process.arch}`);
        console.log(`${t('doctor.nodeVersionLabel')}${chalk.green(process.version)}`);
        console.log('');

        // Daemon spawn diagnostics
        console.log(chalk.bold(t('doctor.daemonSpawnDiag')));
        const projectRoot = projectPath();
        const wrapperPath = join(projectRoot, 'bin', 'aha.mjs');
        const cliEntrypoint = join(projectRoot, 'dist', 'index.mjs');

        console.log(`${t('doctor.projectRootLabel')}${chalk.blue(projectRoot)}`);
        console.log(`${t('doctor.wrapperScriptLabel')}${chalk.blue(wrapperPath)}`);
        console.log(`${t('doctor.cliEntrypointLabel')}${chalk.blue(cliEntrypoint)}`);
        console.log(`${t('doctor.wrapperExistsLabel')}${existsSync(wrapperPath) ? chalk.green(t('doctor.checkYes')) : chalk.red(t('doctor.checkNo'))}`);
        console.log(`${t('doctor.cliExistsLabel')}${existsSync(cliEntrypoint) ? chalk.green(t('doctor.checkYes')) : chalk.red(t('doctor.checkNo'))}`);
        console.log('');

        // Configuration
        console.log(chalk.bold(t('doctor.configuration')));
        console.log(`${t('doctor.ahaHomeLabel')}${chalk.blue(configuration.ahaHomeDir)}`);
        console.log(`${t('doctor.configFileLabel')}${chalk.blue(configuration.configFile)}`);
        console.log(`${t('doctor.serverUrlLabel')}${chalk.blue(configuration.serverUrl)}`);
        console.log(`${t('doctor.logsDirLabel')}${chalk.blue(configuration.logsDir)}`);

        // Environment
        console.log(chalk.bold(t('doctor.envVars')));
        const env = getEnvironmentInfo();
        console.log(`AHA_HOME_DIR: ${env.AHA_HOME_DIR ? chalk.green(env.AHA_HOME_DIR) : chalk.gray(t('doctor.notSet'))}`);
        console.log(`AHA_CONFIG_FILE: ${env.AHA_CONFIG_FILE ? chalk.green(env.AHA_CONFIG_FILE) : chalk.gray(t('doctor.notSet'))}`);
        console.log(`AHA_SERVER_URL: ${env.AHA_SERVER_URL ? chalk.green(env.AHA_SERVER_URL) : chalk.gray(t('doctor.notSet'))}`);
        console.log(`DANGEROUSLY_LOG_TO_SERVER: ${env.DANGEROUSLY_LOG_TO_SERVER_FOR_AI_AUTO_DEBUGGING ? chalk.yellow(t('doctor.enabled')) : chalk.gray(t('doctor.notSet'))}`);
        console.log(`DEBUG: ${env.DEBUG ? chalk.green(env.DEBUG) : chalk.gray(t('doctor.notSet'))}`);
        console.log(`NODE_ENV: ${env.NODE_ENV ? chalk.green(env.NODE_ENV) : chalk.gray(t('doctor.notSet'))}`);

        // Settings
        try {
            const settings = await readSettings();
            console.log(chalk.bold(t('doctor.settingsJson')));
            console.log(chalk.gray(JSON.stringify(settings, null, 2)));
        } catch (error) {
            console.log(chalk.bold(t('doctor.settingsHeader')));
            console.log(chalk.red(t('doctor.settingsFailed')));
        }

        // Authentication status
        console.log(chalk.bold(t('doctor.authHeader')));
        try {
            const credentials = await readCredentials();
            if (credentials) {
                console.log(chalk.green(t('doctor.authenticated')));
            } else {
                console.log(chalk.yellow(t('doctor.notAuthenticated')));
            }
        } catch (error) {
            console.log(chalk.red(t('doctor.credentialsError')));
        }
    }

    // Daemon status - shown for both 'all' and 'daemon' filters
    console.log(chalk.bold(t('doctor.daemonStatusHeader')));
    try {
        const isRunning = await checkIfDaemonRunningAndCleanupStaleState();
        const state = await readDaemonState();

        if (isRunning && state) {
            console.log(chalk.green(t('doctor.daemonRunning')));
            console.log(t('doctor.daemonPidLabel', { pid: state.pid }));
            console.log(t('doctor.daemonStartedLabel', { time: new Date(state.startTime).toLocaleString() }));
            console.log(t('doctor.daemonCliVersionLabel', { version: state.startedWithCliVersion }));
            if (state.httpPort) {
                console.log(t('doctor.daemonHttpPortLabel', { port: state.httpPort }));
            }
        } else if (state && !isRunning) {
            console.log(chalk.yellow(t('doctor.daemonStale')));
        } else {
            console.log(chalk.red(t('doctor.daemonNotRunning')));
        }

        // Show daemon state file
        if (state) {
            console.log(chalk.bold(t('doctor.daemonStateHeader')));
            console.log(chalk.blue(`${t('doctor.daemonStateLocationLabel')}${configuration.daemonStateFile}`));
            console.log(chalk.gray(JSON.stringify(state, null, 2)));
        }

        // All Aha processes
        const allProcesses = await findAllAhaProcesses();
        if (allProcesses.length > 0) {
            console.log(chalk.bold(t('doctor.allProcesses')));

            // Group by type
            const grouped = allProcesses.reduce((groups, process) => {
                if (!groups[process.type]) groups[process.type] = [];
                groups[process.type].push(process);
                return groups;
            }, {} as Record<string, typeof allProcesses>);

            // Display each group
            const typeLabels: Record<string, string> = {
                'current': t('doctor.processType.current'),
                'daemon': t('doctor.processType.daemon'),
                'daemon-version-check': t('doctor.processType.daemonVersionCheck'),
                'daemon-spawned-session': t('doctor.processType.daemonSpawnedSession'),
                'user-session': t('doctor.processType.userSession'),
                'dev-daemon': t('doctor.processType.devDaemon'),
                'dev-daemon-version-check': t('doctor.processType.devDaemonVersionCheck'),
                'dev-session': t('doctor.processType.devSession'),
                'dev-doctor': t('doctor.processType.devDoctor'),
                'dev-related': t('doctor.processType.devRelated'),
                'doctor': t('doctor.processType.doctor'),
                'unknown': t('doctor.processType.unknown')
            };

            Object.entries(grouped).forEach(([type, processes]) => {
                console.log(chalk.blue(`\n${typeLabels[type] || type}:`));
                processes.forEach(({ pid, command }) => {
                    const color = type === 'current' ? chalk.green :
                        type.startsWith('dev') ? chalk.cyan :
                            type.includes('daemon') ? chalk.blue : chalk.gray;
                    console.log(`  ${color(`PID ${pid}`)}: ${chalk.gray(command)}`);
                });
            });
        } else {
            console.log(chalk.red(t('doctor.noProcesses')));
        }

        if (filter === 'all' && allProcesses.length > 1) { // More than just current process
            console.log(chalk.bold(t('doctor.processManagement')));
            console.log(chalk.gray(t('doctor.cleanupHint')));
        }
    } catch (error) {
        console.log(chalk.red(t('doctor.daemonCheckError')));
    }

    // Log files - only show for 'all' filter
    if (filter === 'all') {
        console.log(chalk.bold(t('doctor.logFilesHeader')));

        // Get ALL log files
        const allLogs = getLogFiles(configuration.logsDir);

        if (allLogs.length > 0) {
            // Separate daemon and regular logs
            const daemonLogs = allLogs.filter(({ file }) => file.includes('daemon'));
            const regularLogs = allLogs.filter(({ file }) => !file.includes('daemon'));

            // Show regular logs (max 10)
            if (regularLogs.length > 0) {
                console.log(chalk.blue(t('doctor.recentLogs')));
                const logsToShow = regularLogs.slice(0, 10);
                logsToShow.forEach(({ file, path, modified }) => {
                    console.log(`  ${chalk.green(file)} - ${modified.toLocaleString()}`);
                    console.log(chalk.gray(`    ${path}`));
                });
                if (regularLogs.length > 10) {
                    console.log(chalk.gray(t('doctor.moreLogFiles', { count: regularLogs.length - 10 })));
                }
            }

            // Show daemon logs (max 5)
            if (daemonLogs.length > 0) {
                console.log(chalk.blue(t('doctor.daemonLogsHeader')));
                const daemonLogsToShow = daemonLogs.slice(0, 5);
                daemonLogsToShow.forEach(({ file, path, modified }) => {
                    console.log(`  ${chalk.green(file)} - ${modified.toLocaleString()}`);
                    console.log(chalk.gray(`    ${path}`));
                });
                if (daemonLogs.length > 5) {
                    console.log(chalk.gray(t('doctor.moreDaemonLogs', { count: daemonLogs.length - 5 })));
                }
            } else {
                console.log(chalk.yellow(t('doctor.noDaemonLogs')));
            }
        } else {
            console.log(chalk.yellow(t('doctor.noLogFiles')));
        }

        // Support and bug reports
        console.log(chalk.bold(t('doctor.supportHeader')));
        console.log(`${t('doctor.reportIssuesLabel')}${chalk.blue('https://github.com/Shiyao-Huang/aha/issues/new/choose')}`);
        console.log(`${t('doctor.documentationLabel')}${chalk.blue('https://aha.engineering/')}`);
    }

    console.log(chalk.green(t('doctor.complete')));
}
