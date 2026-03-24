import fs from 'fs';
import path from 'path';
import { promisify } from 'util';
import * as zlib from 'zlib';

const gzip = promisify(zlib.gzip);

const MAX_RECENT_MESSAGES = 500;
const MAX_MESSAGE_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const MAX_TEAM_STORAGE_BYTES = 5 * 1024 * 1024; // 5MB per team
const ARCHIVE_DIR_NAME = 'archives';
const MAX_ARCHIVE_FILES = 10;

// Define a minimal interface for TeamMessage to avoid dependency issues
export interface TeamMessage {
    id: string;
    teamId: string;
    content: string;
    timestamp: number;
    [key: string]: any;
}

export class TeamMessageStorage {
    private storageDir: string;

    constructor(baseDir: string) {
        this.storageDir = path.join(baseDir, '.aha', 'teams');
        if (!fs.existsSync(this.storageDir)) {
            fs.mkdirSync(this.storageDir, { recursive: true });
        }
    }

    private ensureTeamDir(teamId: string): string {
        const teamDir = path.join(this.storageDir, teamId);
        if (!fs.existsSync(teamDir)) {
            fs.mkdirSync(teamDir, { recursive: true });
        }
        return teamDir;
    }

    private getFilePath(teamId: string): string {
        const teamDir = this.ensureTeamDir(teamId);
        return path.join(teamDir, 'messages.jsonl');
    }

    private getArchiveDir(teamId: string): string {
        const teamDir = this.ensureTeamDir(teamId);
        const archiveDir = path.join(teamDir, ARCHIVE_DIR_NAME);
        if (!fs.existsSync(archiveDir)) {
            fs.mkdirSync(archiveDir, { recursive: true });
        }
        return archiveDir;
    }

    private async loadMessages(teamId: string): Promise<TeamMessage[]> {
        const filePath = this.getFilePath(teamId);
        if (!fs.existsSync(filePath)) {
            return [];
        }

        const content = await fs.promises.readFile(filePath, 'utf8');
        const lines = content.split('\n').filter(line => line.trim() !== '');
        const messageMap = new Map<string, TeamMessage>();

        for (const line of lines) {
            try {
                const parsed = JSON.parse(line);
                if (parsed && parsed.id) {
                    messageMap.set(parsed.id, parsed);
                }
            } catch {
                // Skip malformed lines
            }
        }

        return Array.from(messageMap.values());
    }

    private async writeMessages(teamId: string, messages: TeamMessage[]): Promise<void> {
        const filePath = this.getFilePath(teamId);
        if (messages.length === 0) {
            await fs.promises.writeFile(filePath, '', 'utf8');
            return;
        }

        const payload = messages
            .map(message => JSON.stringify(message))
            .join('\n') + '\n';
        await fs.promises.writeFile(filePath, payload, 'utf8');
    }

    private async archiveMessages(teamId: string, messages: TeamMessage[]): Promise<void> {
        if (!messages.length) {
            return;
        }

        const archiveDir = this.getArchiveDir(teamId);
        const archivePayload = messages
            .map(message => JSON.stringify(message))
            .join('\n') + '\n';
        const compressed = await gzip(archivePayload, { level: zlib.constants.Z_BEST_SPEED });
        const archiveFile = path.join(archiveDir, `${Date.now()}-${messages[0].id}.jsonl.gz`);
        await fs.promises.writeFile(archiveFile, compressed);
    }

    private async enforceArchiveBudget(teamId: string): Promise<void> {
        const archiveDir = path.join(this.ensureTeamDir(teamId), ARCHIVE_DIR_NAME);
        if (!fs.existsSync(archiveDir)) {
            return;
        }

        const entries = await fs.promises.readdir(archiveDir);
        const files = await Promise.all(entries.map(async (name) => {
            const fullPath = path.join(archiveDir, name);
            const stats = await fs.promises.stat(fullPath);
            return { name, fullPath, stats };
        }));

        if (files.length > MAX_ARCHIVE_FILES) {
            const sorted = [...files].sort((a, b) => a.stats.mtimeMs - b.stats.mtimeMs);
            const excess = sorted.slice(0, files.length - MAX_ARCHIVE_FILES);
            for (const entry of excess) {
                await fs.promises.unlink(entry.fullPath);
            }
        }

        const archiveFiles = await Promise.all((await fs.promises.readdir(archiveDir)).map(async (name) => {
            const fullPath = path.join(archiveDir, name);
            const stats = await fs.promises.stat(fullPath);
            return { name, fullPath, stats };
        }));

        let totalBytes = 0;
        const messagePath = this.getFilePath(teamId);
        if (fs.existsSync(messagePath)) {
            totalBytes += (await fs.promises.stat(messagePath)).size;
        }
        totalBytes += archiveFiles.reduce((sum, file) => sum + file.stats.size, 0);

        if (totalBytes <= MAX_TEAM_STORAGE_BYTES) {
            return;
        }

        const sortedByAge = [...archiveFiles].sort((a, b) => a.stats.mtimeMs - b.stats.mtimeMs);
        for (const entry of sortedByAge) {
            if (totalBytes <= MAX_TEAM_STORAGE_BYTES) {
                break;
            }
            await fs.promises.unlink(entry.fullPath);
            totalBytes -= entry.stats.size;
        }
    }

    async saveMessage(teamId: string, message: TeamMessage): Promise<void> {
        const filePath = this.getFilePath(teamId);
        const line = JSON.stringify(message) + '\n';
        await fs.promises.appendFile(filePath, line, 'utf8');
        await this.enforceLimits(teamId);
    }

    async hydrateFromServer(teamId: string, messages: TeamMessage[]): Promise<number> {
        if (!messages.length) {
            return 0;
        }

        const localMessages = await this.loadMessages(teamId);
        const merged = new Map<string, TeamMessage>();

        for (const message of [...localMessages, ...messages]) {
            merged.set(message.id, message);
        }

        const ordered = Array.from(merged.values()).sort((a, b) => a.timestamp - b.timestamp);
        await this.writeMessages(teamId, ordered);
        await this.enforceLimits(teamId, ordered);
        return ordered.length;
    }

    async getMessages(teamId: string, limit: number, before?: string): Promise<{ messages: TeamMessage[], hasMore: boolean }> {
        const messages = await this.loadMessages(teamId);
        if (!messages.length) {
            return { messages: [], hasMore: false };
        }

        const ordered = [...messages].sort((a, b) => b.timestamp - a.timestamp);

        let startIndex = 0;
        if (before) {
            const beforeIndex = ordered.findIndex(m => m.id === before);
            if (beforeIndex !== -1) {
                startIndex = beforeIndex + 1;
            }
        }

        const sliced = ordered.slice(startIndex, startIndex + limit);
        return {
            messages: sliced,
            hasMore: ordered.length > startIndex + limit
        };
    }

    async getRecentContext(teamId: string, limit: number = 20): Promise<TeamMessage[]> {
        const { messages } = await this.getMessages(teamId, limit);
        return messages.reverse();
    }

    private async enforceLimits(teamId: string, seed?: TeamMessage[]) {
        const messages = seed ? [...seed] : await this.loadMessages(teamId);
        if (!messages.length) {
            return;
        }

        const now = Date.now();
        const cutoff = now - MAX_MESSAGE_AGE_MS;
        const sorted = messages.sort((a, b) => a.timestamp - b.timestamp);
        const retained: TeamMessage[] = [];
        const archived: TeamMessage[] = [];

        for (const message of sorted) {
            if (message.timestamp < cutoff) {
                archived.push(message);
            } else {
                retained.push(message);
            }
        }

        if (retained.length > MAX_RECENT_MESSAGES) {
            const overflow = retained.splice(0, retained.length - MAX_RECENT_MESSAGES);
            archived.push(...overflow);
        }

        await this.writeMessages(teamId, retained);
        await this.archiveMessages(teamId, archived);
        await this.enforceArchiveBudget(teamId);
    }
}
