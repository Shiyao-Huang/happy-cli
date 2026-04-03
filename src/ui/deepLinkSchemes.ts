const TERMINAL_CONNECT_PREFIXES = ['aha://terminal?', 'happy://terminal?'] as const;
const ACCOUNT_CONNECT_PREFIXES = ['aha:///account?', 'happy:///account?'] as const;

export const PRIMARY_TERMINAL_CONNECT_PREFIX = TERMINAL_CONNECT_PREFIXES[0];
export const PRIMARY_ACCOUNT_CONNECT_PREFIX = ACCOUNT_CONNECT_PREFIXES[0];

function parsePrefixedValue(value: string, prefixes: readonly string[]): string | null {
  for (const prefix of prefixes) {
    if (value.startsWith(prefix)) {
      return value.slice(prefix.length);
    }
  }

  return null;
}

export function buildTerminalConnectUrl(publicKey: string): string {
  return `${PRIMARY_TERMINAL_CONNECT_PREFIX}${publicKey}`;
}

export function parseTerminalConnectUrl(url: string): string | null {
  return parsePrefixedValue(url, TERMINAL_CONNECT_PREFIXES);
}

export function isTerminalConnectUrl(url: string): boolean {
  return parseTerminalConnectUrl(url) !== null;
}

export function buildAccountConnectUrl(publicKey: string): string {
  return `${PRIMARY_ACCOUNT_CONNECT_PREFIX}${publicKey}`;
}

export function parseAccountConnectUrl(url: string): string | null {
  return parsePrefixedValue(url, ACCOUNT_CONNECT_PREFIXES);
}

export function isAccountConnectUrl(url: string): boolean {
  return parseAccountConnectUrl(url) !== null;
}
