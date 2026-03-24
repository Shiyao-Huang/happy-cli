/**
 * @module channels/commandExecutor
 * @description Executes slash commands received from IM users.
 *
 * All methods return a plain-text reply string.
 * Calls the daemon's local HTTP control API via daemonPost.
 * Calls the Aha server API via ApiClient.
 */

import { ChannelState } from './state'
import { ApiClient } from '@/api/api'
import { daemonPost } from '@/daemon/controlClient'

const STATUS_ICONS: Record<string, string> = {
  todo: '⏳', 'in-progress': '🔄', done: '✅', blocked: '🚫',
}

function statusIcon(s: string): string {
  return STATUS_ICONS[s] ?? '📌'
}

function errorMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

export class CommandExecutor {
  constructor(
    private readonly state: ChannelState,
    private readonly api: ApiClient,
  ) {}

  async execute(command: string, args: string[]): Promise<string> {
    switch (command) {
      case 'teams':  return this.listTeams()
      case 't':      return this.switchTeam(args[0])
      case 'status': return this.teamStatus()
      case 'tasks':  return this.listTasks()
      case 'new':    return this.createTeam(args.join(' '))
      case 'stop':   return this.confirmStop()
      case 'agents': return this.listAgents()
      case 'pulse':  return this.teamPulse()
      case 'task':   return this.handleTask(args)
      case 'spawn':  return this.spawnAgent(args[0])
      case 'kill':   return this.confirmKill(args.join(' '))
      case 'mute':   return this.setPushPolicy('important')
      case 'unmute': return this.setPushPolicy('all')
      case 'usage':  return this.teamUsage()
      case 'help':   return this.showHelp()
      default:
        return `❓ 未知命令: /${command}\n输入 /help 查看可用命令`
    }
  }

  // ── /teams ──────────────────────────────────────────────────────────────────

  private async listTeams(): Promise<string> {
    try {
      const { teams } = await this.api.listTeams()
      if (!teams.length) {
        return '📋 暂无 Team\n\n输入 /new <描述> 创建第一个' + this.state.statusBar()
      }
      const lines = teams.map((t, i) => {
        const active = t.id === this.state.currentTeamId ? ' ✦' : ''
        return `${i + 1}. ${t.name}${active}`
      })
      return `📋 你的 Teams:\n${lines.join('\n')}\n\n输入 /t <编号> 切换${this.state.statusBar()}`
    } catch (e) {
      return `❌ 获取 Teams 失败: ${errorMsg(e)}`
    }
  }

  // ── /t <num|name> ───────────────────────────────────────────────────────────

  private async switchTeam(arg: string | undefined): Promise<string> {
    if (!arg) return '用法: /t <编号或 Team 名称>'
    try {
      const { teams } = await this.api.listTeams()
      if (!teams.length) return '❌ 暂无 Team'

      const idx = parseInt(arg, 10)
      const target = !isNaN(idx) && idx >= 1 && idx <= teams.length
        ? teams[idx - 1]
        : teams.find(t => t.name.toLowerCase().includes(arg.toLowerCase()))

      if (!target) return `❌ 找不到 Team: ${arg}`

      this.state.switchTeam(target.id, target.name)
      return `✅ 已切换到: ${target.name}${this.state.statusBar()}`
    } catch (e) {
      return `❌ 切换失败: ${errorMsg(e)}`
    }
  }

  // ── /status ─────────────────────────────────────────────────────────────────

  private async teamStatus(): Promise<string> {
    const teamId = this.state.currentTeamId
    if (!teamId) return '❌ 未选择 Team，输入 /teams 查看'
    try {
      const [teamRes, pulseRes] = await Promise.allSettled([
        this.api.getTeam(teamId),
        daemonPost('/team-pulse', { teamId }),
      ])

      const team = teamRes.status === 'fulfilled' ? teamRes.value?.team : null
      const pulse = pulseRes.status === 'fulfilled' ? pulseRes.value : null
      const lines: string[] = [
        `📊 ${this.state.currentTeamName ?? teamId} 状态:`,
        '━━━━━━━━━━━',
      ]

      if (pulse?.pulse) {
        lines.push('Agent:')
        for (const a of pulse.pulse as any[]) {
          const icon = a.status === 'alive' ? '🟢' : a.status === 'suspect' ? '🟡' : '🔴'
          lines.push(`  ${icon} ${a.role}`)
        }
      }

      if (team) {
        lines.push(`\nTasks: ${team.taskCount ?? '?'} 个`)
        lines.push(`Members: ${team.memberCount ?? '?'} 个`)
      }

      return lines.join('\n') + this.state.statusBar()
    } catch (e) {
      return `❌ 获取状态失败: ${errorMsg(e)}`
    }
  }

  // ── /tasks ──────────────────────────────────────────────────────────────────

  private async listTasks(): Promise<string> {
    const teamId = this.state.currentTeamId
    if (!teamId) return '❌ 未选择 Team'
    try {
      const res = await this.api.listTasks(teamId)
      const tasks = res?.tasks ?? []
      if (!tasks.length) {
        return `📋 ${this.state.currentTeamName} 暂无任务` + this.state.statusBar()
      }
      const lines = (tasks as any[]).slice(0, 20).map((t, i) =>
        `${i + 1}. ${statusIcon(t.status)} ${t.title}`
      )
      return `📋 ${this.state.currentTeamName} 任务:\n${lines.join('\n')}${this.state.statusBar()}`
    } catch (e) {
      return `❌ 获取任务失败: ${errorMsg(e)}`
    }
  }

  // ── /new <description> ──────────────────────────────────────────────────────

  private async createTeam(description: string): Promise<string> {
    if (!description) return '用法: /new <团队任务描述>'
    const name = description.slice(0, 40)
    try {
      const res = await daemonPost('/spawn-session', {
        role: 'master',
        sessionName: name,
        env: { AHA_TEAM_TASK: description },
      })
      if (res?.error) return `❌ 创建失败: ${res.error}`

      // Wait briefly then pick up the new team
      await new Promise<void>(r => setTimeout(r, 1500))
      try {
        const { teams } = await this.api.listTeams()
        const newest = teams[teams.length - 1]
        if (newest) this.state.switchTeam(newest.id, newest.name)
      } catch { /* non-fatal */ }

      return `🆕 Team "${name}" 创建中...\n🎯 master 已启动${this.state.statusBar()}`
    } catch (e) {
      return `❌ 创建失败: ${errorMsg(e)}`
    }
  }

  // ── /stop ───────────────────────────────────────────────────────────────────

  private confirmStop(): string {
    const name = this.state.currentTeamName
    if (!name) return '❌ 未选择 Team'
    this.state.setPending('stop-team', { teamId: this.state.currentTeamId! })
    return `⏹️ 停止 ${name}?\n所有 Agent 将归档。\n\n回复 "确认" 执行，其他取消。`
  }

  async executeStop(teamId: string): Promise<string> {
    try {
      await daemonPost('/stop-team-sessions', { teamId })
      const name = this.state.currentTeamName
      this.state.clearTeam()
      return `✅ ${name} 已归档${this.state.statusBar()}`
    } catch (e) {
      return `❌ 停止失败: ${errorMsg(e)}`
    }
  }

  // ── /agents ─────────────────────────────────────────────────────────────────

  private async listAgents(): Promise<string> {
    const teamId = this.state.currentTeamId
    if (!teamId) return '❌ 未选择 Team'
    try {
      const res = await daemonPost('/team-pulse', { teamId })
      const agents: any[] = res?.pulse ?? []
      if (!agents.length) {
        return `🤖 ${this.state.currentTeamName} 暂无 Agent${this.state.statusBar()}`
      }
      const lines = agents.map(a => {
        const icon = a.status === 'alive' ? '🟢' : a.status === 'suspect' ? '🟡' : '🔴'
        return `${icon} ${a.role}`
      })
      return `🤖 ${this.state.currentTeamName} Agents:\n${lines.join('\n')}${this.state.statusBar()}`
    } catch (e) {
      return `❌ 获取 Agent 列表失败: ${errorMsg(e)}`
    }
  }

  // ── /pulse ──────────────────────────────────────────────────────────────────

  private async teamPulse(): Promise<string> {
    const teamId = this.state.currentTeamId
    if (!teamId) return '❌ 未选择 Team'
    try {
      const res = await daemonPost('/team-pulse', { teamId })
      const agents: any[] = res?.pulse ?? []
      if (!agents.length) return `💓 暂无 Agent 心跳${this.state.statusBar()}`

      const lines = agents.map(a => {
        const icon = a.status === 'alive' ? '🟢' : a.status === 'suspect' ? '🟡' : '🔴'
        const ago = a.lastSeenMs > 0 ? `${Math.round(a.lastSeenMs / 1000)}s ago` : 'unknown'
        return `  ${icon} ${String(a.role).padEnd(14)} ${a.status}  ${ago}`
      })
      return `💓 ${this.state.currentTeamName} 心跳:\n${lines.join('\n')}${this.state.statusBar()}`
    } catch (e) {
      return `❌ 获取心跳失败: ${errorMsg(e)}`
    }
  }

  // ── /task [<idx> done | <description>] ──────────────────────────────────────

  private async handleTask(args: string[]): Promise<string> {
    const teamId = this.state.currentTeamId
    if (!teamId) return '❌ 未选择 Team'

    if (args.length >= 2 && /^\d+$/.test(args[0]) && args[1] === 'done') {
      return this.completeTaskByIndex(teamId, parseInt(args[0], 10))
    }

    const title = args.join(' ')
    if (!title) return '用法: /task <描述>  或  /task <编号> done'
    try {
      await this.api.createTask(teamId, { title })
      return `✅ 任务已创建: ${title}${this.state.statusBar()}`
    } catch (e) {
      return `❌ 创建任务失败: ${errorMsg(e)}`
    }
  }

  private async completeTaskByIndex(teamId: string, idx: number): Promise<string> {
    try {
      const res = await this.api.listTasks(teamId)
      const tasks: any[] = res?.tasks ?? []
      const task = tasks[idx - 1]
      if (!task) return `❌ 找不到任务 #${idx}`
      await this.api.updateTask(task.id, { status: 'done' })
      return `✅ 任务 #${idx} "${task.title}" 已完成${this.state.statusBar()}`
    } catch (e) {
      return `❌ 完成任务失败: ${errorMsg(e)}`
    }
  }

  // ── /spawn <role> ────────────────────────────────────────────────────────────

  private async spawnAgent(role: string | undefined): Promise<string> {
    if (!role) return '用法: /spawn <角色> (如: builder, reviewer, qa-engineer)'
    const teamId = this.state.currentTeamId
    if (!teamId) return '❌ 未选择 Team'
    try {
      const res = await daemonPost('/spawn-session', { role, teamId })
      if (res?.error) return `❌ 启动失败: ${res.error}`
      return `🚀 ${role} 正在启动...${this.state.statusBar()}`
    } catch (e) {
      return `❌ 启动失败: ${errorMsg(e)}`
    }
  }

  // ── /kill <name> ─────────────────────────────────────────────────────────────

  private confirmKill(name: string): string {
    if (!name) return '用法: /kill <角色名称>'
    this.state.setPending('kill-agent', { roleName: name })
    return `⚠️ 停止 Agent "${name}"?\n\n回复 "确认" 执行，其他取消。`
  }

  async executeKill(roleName: string): Promise<string> {
    try {
      const res = await daemonPost('/list', {})
      const sessions: any[] = res?.sessions ?? []
      const teamId = this.state.currentTeamId
      const target = sessions.find(s =>
        s.role === roleName && (!teamId || s.teamId === teamId || s.roomId === teamId)
      )
      if (!target?.sessionId) return `❌ 找不到 Agent: ${roleName}`
      await daemonPost('/stop-session', { sessionId: target.sessionId })
      return `✅ ${roleName} 已停止${this.state.statusBar()}`
    } catch (e) {
      return `❌ 停止失败: ${errorMsg(e)}`
    }
  }

  // ── /mute /unmute ─────────────────────────────────────────────────────────────

  private setPushPolicy(policy: 'all' | 'important'): string {
    void daemonPost('/channels/weixin/policy', { pushPolicy: policy })
    return policy === 'important'
      ? '🔇 已静默。仅推送任务完成/失败/求助。\n输入 /unmute 恢复全部推送。'
      : '🔔 已恢复全部推送。'
  }

  // ── /usage ────────────────────────────────────────────────────────────────────

  private async teamUsage(): Promise<string> {
    const teamId = this.state.currentTeamId
    if (!teamId) return '❌ 未选择 Team'
    try {
      const res = await this.api.getTeamScore(teamId)
      if (!res) return '暂无使用数据'
      return `📊 ${this.state.currentTeamName} 用量:\n${JSON.stringify(res, null, 2).slice(0, 500)}${this.state.statusBar()}`
    } catch (e) {
      return `❌ 获取用量失败: ${errorMsg(e)}`
    }
  }

  // ── /help ─────────────────────────────────────────────────────────────────────

  private showHelp(): string {
    return `📖 微信指令:

聊天:
  直接打字       → 发给 master
  @角色名        → 指定 Agent
  #team名        → 指定 Team

常用:
  /teams         — 列出 Teams
  /t <编号>      — 切换 Team
  /status        — 当前状态
  /tasks         — 任务列表
  /new <描述>    — 创建 Team
  /stop          — 停止当前 Team

任务:
  /task <描述>   — 创建任务
  /task <#> done — 标记完成

Agent:
  /agents        — Agent 列表
  /pulse         — 心跳状态
  /spawn <角色>  — 加 Agent
  /kill <名称>   — 停 Agent

推送:
  /mute          — 仅重要消息
  /unmute        — 全部消息${this.state.statusBar()}`
  }
}
