import { describe, expect, it } from 'vitest';

import {
  buildAccountConnectUrl,
  buildTerminalConnectUrl,
  isAccountConnectUrl,
  isTerminalConnectUrl,
  parseAccountConnectUrl,
  parseTerminalConnectUrl,
} from './deepLinkSchemes';

describe('deepLinkSchemes', () => {
  it('builds primary aha terminal and account URLs', () => {
    expect(buildTerminalConnectUrl('abc')).toBe('aha://terminal?abc');
    expect(buildAccountConnectUrl('xyz')).toBe('aha:///account?xyz');
  });

  it('accepts both aha and legacy happy terminal URLs', () => {
    expect(parseTerminalConnectUrl('aha://terminal?abc')).toBe('abc');
    expect(parseTerminalConnectUrl('happy://terminal?abc')).toBe('abc');
    expect(isTerminalConnectUrl('happy://terminal?abc')).toBe(true);
  });

  it('accepts both aha and legacy happy account URLs', () => {
    expect(parseAccountConnectUrl('aha:///account?xyz')).toBe('xyz');
    expect(parseAccountConnectUrl('happy:///account?xyz')).toBe('xyz');
    expect(isAccountConnectUrl('happy:///account?xyz')).toBe(true);
  });

  it('rejects unrelated URLs', () => {
    expect(parseTerminalConnectUrl('https://example.com')).toBeNull();
    expect(parseAccountConnectUrl('aha://terminal?abc')).toBeNull();
  });
});
