/**
 * DNS Fallback Resolver
 *
 * When the system DNS resolver fails (ENOTFOUND), falls back to
 * public DNS resolvers (Google 8.8.8.8, Cloudflare 1.1.1.1).
 *
 * Call `installDnsFallback()` early in the process lifecycle
 * (before any network calls) to patch Node's dns.lookup globally.
 */
import dns from 'node:dns'
import { logger } from '@/ui/logger'

let installed = false

/**
 * Install a global dns.lookup fallback that uses Google/Cloudflare DNS
 * when the system resolver fails with ENOTFOUND.
 */
export function installDnsFallback(): void {
  if (installed) return
  installed = true

  const resolver = new dns.Resolver()
  resolver.setServers(['8.8.8.8', '1.1.1.1'])

  const originalLookup = dns.lookup

  // @ts-expect-error — overloaded signatures make typing messy; runtime behavior is correct
  dns.lookup = function fallbackLookup(
    hostname: string,
    optionsOrCallback: dns.LookupOptions | number | ((err: NodeJS.ErrnoException | null, address: string, family: number) => void),
    maybeCallback?: (err: NodeJS.ErrnoException | null, address: string, family: number) => void
  ): void {
    let options: dns.LookupOptions
    let callback: (err: NodeJS.ErrnoException | null, address: string, family: number) => void

    if (typeof optionsOrCallback === 'function') {
      callback = optionsOrCallback as typeof callback
      options = {}
    } else if (typeof optionsOrCallback === 'number') {
      options = { family: optionsOrCallback }
      callback = maybeCallback!
    } else {
      options = optionsOrCallback || {}
      callback = maybeCallback!
    }

    // Skip patching for localhost and raw IPs
    if (hostname === 'localhost' || hostname === '127.0.0.1' || /^\d+\.\d+\.\d+\.\d+$/.test(hostname)) {
      return originalLookup.call(dns, hostname, options, callback as never) as never
    }

    // When options.all is true, the callback signature is different —
    // (err, addresses: {address, family}[]) instead of (err, address, family).
    // Delegate to original lookup entirely for all-mode to avoid signature mismatches.
    if (options.all) {
      return originalLookup.call(dns, hostname, options, callback as never) as never
    }

    // Try system resolver first
    originalLookup.call(dns, hostname, options, ((err: NodeJS.ErrnoException | null, address: string, family: number) => {
      if (!err) {
        callback(null, address, family)
        return
      }

      if (err.code !== 'ENOTFOUND') {
        callback(err, address, family)
        return
      }

      // System resolver failed with ENOTFOUND — try public DNS
      const resolveMethod = (!options.family || options.family === 4) ? 'resolve4' : 'resolve6'
      resolver[resolveMethod](hostname, (resolveErr, addresses) => {
        if (resolveErr || !addresses || addresses.length === 0) {
          logger.debug(`[DNS FALLBACK] Public DNS also failed for ${hostname}: ${resolveErr?.message ?? 'no addresses'}`)
          callback(err, address, family) // return original error
          return
        }

        logger.debug(`[DNS FALLBACK] Resolved ${hostname} via public DNS: ${addresses[0]}`)
        callback(null, addresses[0], resolveMethod === 'resolve4' ? 4 : 6)
      })
    }) as never) as never
  }

  logger.debug('[DNS FALLBACK] Installed global dns.lookup fallback (Google 8.8.8.8 + Cloudflare 1.1.1.1)')
}
