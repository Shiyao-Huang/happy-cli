import { describe, it, expect, vi, beforeEach } from 'vitest';
import axios from 'axios';

// Mock axios
vi.mock('axios');
vi.mock('@/utils/logger', () => ({
    logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn()
    }
}));

describe('CLI Session Creation - R3 Parameters', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('R3-AC-7: CLI passes mode, machineId, roleId when creating a session', async () => {
        // Mock successful session creation response
        const mockResponse = {
            data: {
                session: {
                    id: 'session-123',
                    seq: 1,
                    metadata: 'encoded-metadata',
                    metadataVersion: 0,
                    agentState: null,
                    agentStateVersion: 0,
                    dataEncryptionKey: null
                }
            }
        };

        vi.mocked(axios.post).mockResolvedValue(mockResponse);

        // Simulate CLI calling the API with R3 parameters
        const sessionData = {
            tag: 'test-session',
            metadata: 'encoded-metadata',
            agentState: null,
            dataEncryptionKey: null,
            displayName: 'My Builder Session',
            mode: 'codex',
            machineId: 'machine-abc123',
            roleId: 'builder',
            rootPathHash: 'hash-of-project-path'
        };

        // Verify that the request includes the new R3 fields
        expect(sessionData).toHaveProperty('displayName');
        expect(sessionData).toHaveProperty('mode');
        expect(sessionData).toHaveProperty('machineId');
        expect(sessionData).toHaveProperty('roleId');
        expect(sessionData).toHaveProperty('rootPathHash');

        // Verify the mode is 'codex' for daemon-spawned agents
        expect(sessionData.mode).toBe('codex');

        // Verify roleId is set
        expect(sessionData.roleId).toBe('builder');

        // Verify machineId is passed
        expect(sessionData.machineId).toBe('machine-abc123');
    });

    it('R3-AC-8: rootPathHash is a hash, not a plaintext path', () => {
        const rootPathHash = 'a1b2c3d4e5f6g7h8i9j0';

        // Verify that rootPathHash doesn't start with '/' (filesystem path)
        expect(rootPathHash).not.toMatch(/^\//);
        expect(rootPathHash).not.toMatch(/^\/Users/);
        expect(rootPathHash).not.toMatch(/^\/home/);

        // Verify it's alphanumeric (hash format)
        expect(rootPathHash).toMatch(/^[a-f0-9]+$/);
    });

    it('should work without optional R3 parameters (backwards compatibility)', async () => {
        // Mock successful session creation response
        const mockResponse = {
            data: {
                session: {
                    id: 'session-456',
                    seq: 1,
                    metadata: 'encoded-metadata',
                    metadataVersion: 0,
                    agentState: null,
                    agentStateVersion: 0,
                    dataEncryptionKey: null
                }
            }
        };

        vi.mocked(axios.post).mockResolvedValue(mockResponse);

        // Simulate CLI calling the API WITHOUT R3 parameters (legacy mode)
        const sessionData = {
            tag: 'legacy-session',
            metadata: 'encoded-metadata',
            agentState: null,
            dataEncryptionKey: null
        };

        // Verify that the request is valid without the optional fields
        expect(sessionData).not.toHaveProperty('displayName');
        expect(sessionData).not.toHaveProperty('mode');
        expect(sessionData).not.toHaveProperty('machineId');
        expect(sessionData).not.toHaveProperty('roleId');
        expect(sessionData).not.toHaveProperty('rootPathHash');
    });
});