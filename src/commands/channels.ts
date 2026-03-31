/**
 * @module commands/channels
 * @description CLI commands for managing server-backed IM channels (WeChat etc.)
 *
 * Usage:
 *   aha channels status
 *   aha channels weixin login
 *   aha channels weixin disconnect
 *   aha channels weixin policy <all|important|silent>
 */

import chalk from 'chalk'
import { pollQRStatus } from '@/channels/weixin/auth'
import { createApiClient } from './output'

const QR_REFRESH_MS = 2_000
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000

interface WeixinLoginCredentials {
  token: string
  baseUrl: string
  weixinUserId?: string
  accountId?: string
}

export async function handleChannelsCommand(args: string[]): Promise<void> {
  const [sub, ...rest] = args

  switch (sub) {
    case 'status': return channelsStatus()
    case 'weixin':
    case 'wechat':
      return weixinCommand(rest)
    default:
      printHelp()
  }
}

// ── status ────────────────────────────────────────────────────────────────────

async function channelsStatus(): Promise<void> {
  const api = await createApiClient()
  const res = await api.getChannelStatus()
  const weixin = res?.weixin
  if (weixin?.connected) {
    console.log(chalk.green('WeChat: ✅ 已连接'))
    console.log(chalk.gray(`推送策略: ${weixin.pushPolicy}`))
    return
  }

  if (weixin) {
    console.log(chalk.yellow('WeChat: ⚠️ 已绑定，但当前未建立活动桥接'))
    console.log(chalk.gray(`推送策略: ${weixin.pushPolicy}`))
  } else {
    console.log(chalk.gray('WeChat: ○ 未配置'))
  }
}

// ── weixin subcommands ────────────────────────────────────────────────────────

async function weixinCommand(args: string[]): Promise<void> {
  const [sub, ...rest] = args
  switch (sub) {
    case 'login': return weixinLogin()
    case 'disconnect': return weixinDisconnect()
    case 'policy': return weixinPolicy(rest[0])
    default:
      console.log(chalk.cyan('Usage: aha channels weixin <login|disconnect|policy>'))
  }
}

async function weixinLogin(): Promise<void> {
  const api = await createApiClient()
  console.log(chalk.cyan('Starting WeChat QR login...'))
  console.log(chalk.gray('Scan the QR code with your WeChat app'))
  console.log()

  try {
    const { default: qrTerminal } = await import('qrcode-terminal')
    let currentQr = await api.requestWeixinQRCode()
    let qrCount = 0
    let lastStatus = 'wait'
    const deadline = Date.now() + LOGIN_TIMEOUT_MS

    while (Date.now() < deadline) {
      if (qrCount > 0) {
        console.log(chalk.yellow('\n🔄 二维码已刷新，请重新扫码'))
      }
      qrCount++
      renderQrCode(qrTerminal, currentQr.displayUrl)
      console.log()
      console.log(chalk.gray(`或在微信中打开: ${currentQr.displayUrl}`))
      console.log()
      console.log(chalk.gray('⚠️  必须用微信 iOS 8.0.70+ → 我 → 设置 → 插件 → ClawBot'))
      console.log(chalk.gray('等待扫码 (二维码约 60 秒后自动刷新)...'))

      while (Date.now() < deadline) {
        await sleep(QR_REFRESH_MS)
        const poll = await api.pollWeixinQRCode(currentQr.qrcode)
        const status = poll.status ?? 'wait'

        if (status !== lastStatus && status === 'scaned') {
          console.log(chalk.cyan('\n👀 已扫码，请在微信中确认登录'))
        }
        lastStatus = status

        if (status === 'confirmed') {
          const creds = poll.token && poll.baseUrl
            ? {
                token: poll.token,
                baseUrl: poll.baseUrl,
                weixinUserId: poll.weixinUserId,
                accountId: poll.accountId,
              }
            : await resolveConfirmedCredentials(currentQr.qrcode)

          await api.bindWeixinChannel(creds)
          console.log(chalk.green('\n✅ 微信已连接！'))
          console.log(chalk.gray('后续消息将通过 server 侧微信桥接统一处理。'))
          return
        }

        if (status === 'expired') {
          currentQr = await api.requestWeixinQRCode()
          break
        }
      }
    }

    throw new Error('Login timed out after 5 minutes')
  } catch (e) {
    console.error(chalk.red(`\n❌ 登录失败: ${e instanceof Error ? e.message : String(e)}`))
    process.exit(1)
  }
}

function renderQrCode(
  qrTerminal: { generate: (text: string, options?: { small: boolean }, callback?: (qrcode: string) => void) => void },
  displayUrl: string,
): void {
  qrTerminal.generate(displayUrl, { small: true })
}

async function resolveConfirmedCredentials(qrcode: string): Promise<WeixinLoginCredentials> {
  const result = await pollQRStatus(qrcode)
  if (result.status === 'confirmed' && result.credentials) {
    return {
      token: result.credentials.token,
      baseUrl: result.credentials.baseUrl,
      weixinUserId: result.credentials.userId,
      accountId: result.credentials.accountId,
    }
  }

  throw new Error('二维码已确认，但 server /poll 尚未返回绑定凭据，且直连 iLink 补取失败')
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function weixinDisconnect(): Promise<void> {
  const api = await createApiClient()
  await api.disconnectWeixinChannel()
  console.log(chalk.yellow('微信频道已断开'))
}

async function weixinPolicy(policy: string | undefined): Promise<void> {
  if (!policy || !['all', 'important', 'silent'].includes(policy)) {
    console.log(chalk.cyan('Usage: aha channels weixin policy <all|important|silent>'))
    console.log()
    console.log('  all       — 推送所有 Agent 消息')
    console.log('  important — 仅推送任务完成/失败/求助/评分')
    console.log('  silent    — 停止推送')
    return
  }

  const api = await createApiClient()
  await api.updateWeixinChannelPolicy(policy as 'all' | 'important' | 'silent')
  console.log(chalk.green(`✅ 推送策略已设为: ${policy}`))
}

export const channelsCommand = handleChannelsCommand

// ── help ──────────────────────────────────────────────────────────────────────

function printHelp(): void {
  console.log(chalk.cyan('Aha 消息频道管理\n'))
  console.log('Usage: aha channels <command>\n')
  console.log('Commands:')
  console.log('  status                    — 查看所有频道状态')
  console.log('  weixin login              — 扫码连接微信')
  console.log('  weixin disconnect         — 断开微信')
  console.log('  weixin policy <all|important|silent>')
  console.log('                            — 设置推送策略')
}
