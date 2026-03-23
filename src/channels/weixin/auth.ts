/**
 * @module channels/weixin/auth
 * @description WeChat iLink Bot QR-code login flow.
 *
 * Step 1: GET ilink/bot/get_bot_qrcode?bot_type=3  → qrcode token + img URL
 * Step 2: Poll GET ilink/bot/get_qrcode_status?qrcode=<token>
 *         until status = 'confirmed'
 * Step 3: Return credentials (token, baseUrl, userId, accountId)
 *
 * Reference: lib/claude-plugin-weixin/login-qr.ts + login-poll.ts
 * NOTE: Both endpoints are plain unauthenticated GETs — no Bearer token needed.
 */

const DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com/'

// ── Public API ────────────────────────────────────────────────────────────────

export interface QRCodeResult {
  /** Raw qrcode token — used to poll status. */
  qrcode: string
  /** URL/content to feed into a QR renderer (qrcode_img_content from API). */
  displayUrl: string
}

export interface LoginResult {
  token: string
  baseUrl: string
  userId?: string
  accountId?: string
}

/**
 * Step 1: Request a QR code from iLink.
 */
export async function requestQRCode(baseUrl = DEFAULT_BASE_URL): Promise<QRCodeResult> {
  const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`
  const res = await fetch(`${base}ilink/bot/get_bot_qrcode?bot_type=3`)
  if (!res.ok) throw new Error(`获取二维码失败: ${res.status}`)
  const data = await res.json() as any
  if (!data?.qrcode) throw new Error('iLink: no qrcode in response')
  return {
    qrcode: data.qrcode,
    // qrcode_img_content is the scannable URL content; fall back to a direct link
    displayUrl: data.qrcode_img_content ?? `${base}qr/${data.qrcode}`,
  }
}

export type PollStatus = 'wait' | 'scaned' | 'confirmed' | 'expired'

export interface PollResult {
  status: PollStatus
  credentials?: LoginResult
}

/**
 * Step 2: Poll QR status (plain GET, no auth headers).
 * AbortErrors are treated as 'wait' (API is doing long-poll).
 */
export async function pollQRStatus(qrcode: string, baseUrl = DEFAULT_BASE_URL): Promise<PollResult> {
  const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 35_000)

  let data: any
  try {
    const res = await fetch(
      `${base}ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`,
      { signal: controller.signal },
    )
    clearTimeout(timer)
    if (!res.ok) throw new Error(`poll failed: ${res.status}`)
    data = await res.json()
  } catch (err: any) {
    clearTimeout(timer)
    if (err?.name === 'AbortError') return { status: 'wait' }
    throw err
  }

  switch (data?.status) {
    case 'confirmed':
      return {
        status: 'confirmed',
        credentials: {
          token: data.bot_token,
          baseUrl: data.baseurl ?? baseUrl,
          userId: data.ilink_user_id,
          accountId: data.ilink_bot_id,
        },
      }
    case 'scaned':  return { status: 'scaned' }
    case 'expired': return { status: 'expired' }
    default:        return { status: 'wait' }
  }
}

/**
 * Full login loop: request QR, call onQR with display info, then poll until done.
 * Auto-refreshes the QR code on expiry (WeChat QR codes are ~15-60s short-lived).
 *
 * @param onQR  - Called every time a new QR is issued (display/re-render it).
 * @param signal - Optional AbortSignal to cancel.
 */
export async function loginWithQR(
  onQR: (info: QRCodeResult) => void,
  signal?: AbortSignal,
  baseUrl = DEFAULT_BASE_URL,
): Promise<LoginResult> {
  const totalDeadline = Date.now() + 5 * 60 * 1000 // 5 min overall

  while (Date.now() < totalDeadline) {
    if (signal?.aborted) throw new Error('Login cancelled')

    // Get a fresh QR code
    const qrInfo = await requestQRCode(baseUrl)
    onQR(qrInfo)

    // Poll until confirmed, expired, or timeout
    while (Date.now() < totalDeadline) {
      if (signal?.aborted) throw new Error('Login cancelled')
      await sleep(2_000)
      const result = await pollQRStatus(qrInfo.qrcode, baseUrl)
      if (result.status === 'confirmed' && result.credentials) return result.credentials
      if (result.status === 'expired') break // get a new QR
    }
  }

  throw new Error('Login timed out after 5 minutes')
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}
