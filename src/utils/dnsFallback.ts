/**
 * DNS Fallback Resolver
 *
 * When the system DNS resolver fails (ENOTFOUND), falls back to
 * public DNS resolvers (Google 8.8.8.8, Cloudflare 1.1.1.1).
 *
 * Call `installDnsFallback()` early in the process lifecycle
 * (before any network calls) to patch Node's dns.lookup globally.
 *
 * Guards:
 * - Skips localhost, raw IPs, and private/internal TLDs (.local, .corp, etc.)
 * - Set AHA_DNS_FALLBACK=false to disable entirely
 */
import dns from 'node:dns'
import { logger } from '@/ui/logger'

let installed = false

/**
 * TLDs/suffixes that should never be resolved via public DNS.
 * These are typically used for internal/private networks.
 */
const PRIVATE_TLDS = new Set([
  'local',
  'internal',
  'corp',
  'lan',
  'home',
  'intranet',
  'private',
  'localhost',
  'test',
  'invalid',
])

/** Returns true if the hostname should skip public DNS fallback */
function isPrivateHostname(hostname: string): boolean {
  // Bare hostnames (no dots) are likely internal
  if (!hostname.includes('.')) return true
  const parts = hostname.split('.')
  const tld = parts[parts.length - 1].toLowerCase()
  return PRIVATE_TLDS.has(tld)
}

/**
 * Install a global dns.lookup fallback that uses Google/Cloudflare DNS
 * when the system resolver fails with ENOTFOUND.
 *
 * Handles both normal mode (callback: err, address, family) and
 * all mode (callback: err, [{address, family}]) which Node's HTTPS uses.
 */
export function installDnsFallback(): void {
  if (installed) return
  installed = true

  // Env opt-out: set AHA_DNS_FALLBACK=false to disable
  if (process.env.AHA_DNS_FALLBACK === 'false') {
    logger.debug('[DNS FALLBACK] Disabled via AHA_DNS_FALLBACK=false')
    return
  }

  const resolver = new dns.Resolver()
  resolver.setServers(['8.8.8.8', '1.1.1.1'])

  const originalLookup = dns.lookup

  /** Resolve hostname via public DNS after system resolver ENOTFOUND */
  const fallbackResolve = (
    hostname: string,
    family: number | undefined,
    originalErr: NodeJS.ErrnoException,
    cb: (...args: unknown[]) => void,
    allMode: boolean
  ): void => {
    const resolveMethod =
      !family || family === 4 ? ('resolve4' as const) : ('resolve6' as const)
    resolver[resolveMethod](hostname, (resolveErr, addresses) => {
      if (resolveErr || !addresses || addresses.length === 0) {
        logger.debug(
          `[DNS FALLBACK] Public DNS also failed for ${hostname}: ${resolveErr?.message ?? 'no addresses'}`
        )
        cb(originalErr)
        return
      }

      const resolvedFamily = resolveMethod === 'resolve4' ? 4 : 6
      logger.debug(
        `[DNS FALLBACK] Resolved ${hostname} via public DNS: ${addresses[0]}`
      )

      if (allMode) {
        cb(
          null,
          addresses.map((addr: string) => ({
            address: addr,
            family: resolvedFamily,
          }))
        )
      } else {
        cb(null, addresses[0], resolvedFamily)
      }
    })
  }

  // @ts-expect-error — overloaded signatures make typing messy; runtime behavior is correct
  dns.lookup = function fallbackLookup(
    hostname: string,
    optionsOrCallback:
      | dns.LookupOptions
      | number
      | ((...args: unknown[]) => void),
    maybeCallback?: (...args: unknown[]) => void
  ): void {
    let options: dns.LookupOptions
    let callback: (...args: unknown[]) => void

    if (typeof optionsOrCallback === 'function') {
      callback = optionsOrCallback
      options = {}
    } else if (typeof optionsOrCallback === 'number') {
      options = { family: optionsOrCallback }
      callback = maybeCallback!
    } else {
      options = optionsOrCallback || {}
      callback = maybeCallback!
    }

    // Skip patching for localhost, raw IPs, and private/internal hostnames
    if (
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      /^\d+\.\d+\.\d+\.\d+$/.test(hostname) ||
      isPrivateHostname(hostname)
    ) {
      return originalLookup.call(
        dns,
        hostname,
        options,
        callback as never
      ) as never
    }

    // When options.all is true, callback signature is (err, [{address, family}])
    if (options.all) {
      originalLookup.call(
        dns,
        hostname,
        options,
        ((
          err: NodeJS.ErrnoException | null,
          addresses: Array<{ address: string; family: number }>
        ) => {
          if (!err) {
            callback(null, addresses)
            return
          }
          if (err.code !== 'ENOTFOUND') {
            callback(err, addresses)
            return
          }
          fallbackResolve(hostname, options.family, err, callback, true)
        }) as never
      ) as never
      return
    }

    // Normal mode: callback signature is (err, address, family)
    originalLookup.call(
      dns,
      hostname,
      options,
      ((
        err: NodeJS.ErrnoException | null,
        address: string,
        family: number
      ) => {
        if (!err) {
          callback(null, address, family)
          return
        }
        if (err.code !== 'ENOTFOUND') {
          callback(err, address, family)
          return
        }
        fallbackResolve(hostname, options.family, err, callback, false)
      }) as never
    ) as never
  }

  logger.debug(
    '[DNS FALLBACK] Installed global dns.lookup fallback (Google 8.8.8.8 + Cloudflare 1.1.1.1)'
  )
}
