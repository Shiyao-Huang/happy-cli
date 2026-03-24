/**
 * @module commands/channels
 * @description CLI commands for managing IM channel bridge (WeChat etc.)
 *
 * Usage:
 *   aha channels status
 *   aha channels weixin login
 *   aha channels weixin disconnect
 *   aha channels weixin policy <all|important|silent>
 */

import chalk from 'chalk'
import { daemonPost } from '@/daemon/controlClient'
import { loginWithQR } from '@/channels/weixin/auth'
import {
  deleteWeixinCredentials,
  loadPushPolicy,
  loadWeixinCredentials,
  savePushPolicy,
  saveWeixinCredentials,
  setWeixinEnabled,
} from '@/channels/weixin/config'

export async function channelsCommand(args: string[]): Promise<void> {
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
  const res = await daemonPost('/channels/status', {})
  const savedCreds = loadWeixinCredentials()
  const savedPolicy = loadPushPolicy()

  if (res?.error) {
    if (savedCreds) {
      console.log(chalk.yellow(`WeChat: ○ Configured locally (daemon offline, policy=${savedPolicy})`))
    } else {
      console.log(chalk.gray('WeChat: ○ Not configured'))
    }
    return
  }

  const weixin = res?.status?.weixin
  if (weixin?.connected) {
    console.log(chalk.green(`WeChat: ✅ Connected (${weixin.pushPolicy ?? 'all'})`))
  } else if (weixin?.configured || savedCreds) {
    console.log(chalk.yellow(`WeChat: ○ Configured but disconnected (${weixin?.pushPolicy ?? savedPolicy})`))
  } else {
    console.log(chalk.gray('WeChat: ○ Not configured'))
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
  console.log(chalk.cyan('Starting WeChat QR login...'))
  console.log(chalk.gray('Scan the QR code with your WeChat app'))
  console.log()

  try {
    // Try to use qrcode-terminal for inline display
    let qrTerminal: any
    try { qrTerminal = (await import('qrcode-terminal' as any)).default } catch { /* optional dep */ }

    let qrCount = 0
    const creds = await loginWithQR(
      (info) => {
        if (qrCount > 0) {
          console.log(chalk.yellow('\n🔄 二维码已刷新，请重新扫码'))
        }
        qrCount++
        if (qrTerminal) {
          qrTerminal.generate(info.displayUrl, { small: true })
          console.log()
          console.log(chalk.gray(`或在微信中打开: ${info.displayUrl}`))
        } else {
          console.log(chalk.yellow('在微信中打开以下链接:'))
          console.log(chalk.cyan(info.displayUrl))
        }
        console.log()
        console.log(chalk.gray('⚠️  必须用微信 iOS 8.0.70+ → 我 → 设置 → 插件 → ClawBot'))
        console.log(chalk.gray('等待扫码 (二维码约 60 秒后自动刷新)...'))
      }
    )

    // Save credentials to disk
    saveWeixinCredentials(creds)
    setWeixinEnabled(true)

    // Notify daemon to connect the WeChat bridge with new credentials
    await daemonPost('/channels/weixin/poll', { qrcode: '__saved__' }).catch(() => { /* daemon may not be running */ })

    console.log(chalk.green('\n✅ 微信已连接！'))
    console.log(chalk.gray('在微信给 Bot 发一条消息以激活推送。'))
  } catch (e) {
    console.error(chalk.red(`\n❌ 登录失败: ${e instanceof Error ? e.message : String(e)}`))
    process.exit(1)
  }
}

async function weixinDisconnect(): Promise<void> {
  deleteWeixinCredentials()
  setWeixinEnabled(false)
  const res = await daemonPost('/channels/weixin/disconnect', {})
  if (res?.error) {
    console.log(chalk.yellow('微信本地配置已删除，daemon 当前不可达'))
    return
  }
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
  savePushPolicy(policy as 'all' | 'important' | 'silent')
  setWeixinEnabled(true)
  const res = await daemonPost('/channels/weixin/policy', { pushPolicy: policy })
  if (res?.error) {
    console.log(chalk.yellow(`已保存本地推送策略: ${policy}（daemon 当前不可达）`))
    return
  }
  console.log(chalk.green(`✅ 推送策略已设为: ${policy}`))
}

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
