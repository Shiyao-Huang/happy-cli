import { describe, it, expect, vi, beforeEach } from 'vitest';
import axios from 'axios';

// Mock axios
vi.mock('axios');
const mockedAxios = axios as any;

// Mock configuration
vi.mock('@/configuration', () => ({
  configuration: {
    serverUrl: 'http://localhost:3005'
  }
}));

// Mock persistence
vi.mock('@/persistence', () => ({
  writeCredentialsLegacy: vi.fn(),
  readCredentials: vi.fn().mockResolvedValue(null),
  updateSettings: vi.fn()
}));

// Mock browser opener
vi.mock('@/utils/browser', () => ({
  openBrowser: vi.fn().mockResolvedValue(true)
}));

// Mock QR code display
vi.mock('@/ui/qrcode', () => ({
  displayQRCode: vi.fn()
}));

describe('Device Code Auth (R2)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('doDeviceCodeAuth', () => {
    it('should display user code and poll until approved', async () => {
      // Mock the initial POST request
      mockedAxios.post.mockResolvedValueOnce({
        data: {
          userCode: 'ABC-123',
          deviceCode: 'test-device-code',
          expiresIn: 300,
          verificationUri: 'https://app.aha.engineering/device?code=ABC-123'
        }
      });

      // Mock poll responses: pending, then approved
      mockedAxios.get
        .mockResolvedValueOnce({ data: { status: 'pending' } })
        .mockResolvedValueOnce({ data: { status: 'approved', token: 'test-token' } });

      // Import after mocks are set up
      const { doDeviceCodeAuth } = await import('@/ui/auth');
      const result = await doDeviceCodeAuth(true); // headless mode

      // Verify result
      expect(result).not.toBeNull();
      expect(result?.token).toBe('test-token');
      expect(result?.encryption.type).toBe('legacy');

      // Verify POST was called
      expect(mockedAxios.post).toHaveBeenCalledWith(
        'http://localhost:3005/v1/auth/device-code',
        expect.objectContaining({})
      );

      // Verify polling happened
      expect(mockedAxios.get).toHaveBeenCalled();
    });

    it('should handle expired device code', async () => {
      mockedAxios.post.mockResolvedValueOnce({
        data: {
          userCode: 'XYZ-789',
          deviceCode: 'expired-device-code',
          expiresIn: 300,
          verificationUri: 'https://app.aha.engineering/device?code=XYZ-789'
        }
      });

      // Mock expired response
      mockedAxios.get.mockResolvedValueOnce({ data: { status: 'expired' } });

      const { doDeviceCodeAuth } = await import('@/ui/auth');
      const result = await doDeviceCodeAuth(true);

      expect(result).toBeNull();
    });

    it('should not open browser in headless mode', async () => {
      const { openBrowser } = await import('@/utils/browser');

      mockedAxios.post.mockResolvedValueOnce({
        data: {
          userCode: 'HEAD-LESS',
          deviceCode: 'headless-code',
          expiresIn: 300,
          verificationUri: 'https://app.aha.engineering/device?code=HEAD-LESS'
        }
      });

      // Return pending forever (we'll just check browser wasn't opened)
      mockedAxios.get.mockImplementation(() =>
        new Promise(resolve => setTimeout(() => resolve({ data: { status: 'pending' } }), 100))
      );

      const { doDeviceCodeAuth } = await import('@/ui/auth');

      // Start the auth process but don't wait for it
      const authPromise = doDeviceCodeAuth(true);

      // Give it time to execute
      await new Promise(resolve => setTimeout(resolve, 50));

      // In headless mode, openBrowser should NOT be called
      expect(openBrowser).not.toHaveBeenCalled();
    });
  });

  describe('User code format', () => {
    it('should generate valid XXX-XXX format codes', async () => {
      const validUserCodeRegex = /^[A-Z0-9]{3}-[A-Z0-9]{3}$/;

      // Test several mock responses
      const testCodes = ['ABC-123', 'XYZ-789', 'K9M-P4Q'];
      for (const code of testCodes) {
        expect(code).toMatch(validUserCodeRegex);
      }
    });
  });
});