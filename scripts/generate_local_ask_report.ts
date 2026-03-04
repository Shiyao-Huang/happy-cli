import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateTeamCompositionPlan, type TeamCompositionPlan, type TeamEvolutionSignals } from '../../happy-server/sources/modules/teamComposition';

type PrdStory = {
  id?: string;
  title?: string;
  priority?: number;
  passes?: boolean;
};

type PrdDocument = {
  project?: string;
  branchName?: string;
  description?: string;
  userStories?: PrdStory[];
  tasks?: PrdStory[];
};

type PrdContext = {
  sourcePath: string;
  project: string;
  branchName: string;
  pendingStories: PrdStory[];
  completedCount: number;
  totalStories: number;
  goalSuggestion: string;
  contextLines: string[];
};

function toAbsolute(inputPath: string): string {
  const expanded = inputPath.startsWith('~') ? path.join(os.homedir(), inputPath.slice(1)) : inputPath;
  return path.isAbsolute(expanded) ? expanded : path.resolve(process.cwd(), expanded);
}

function parsePrd(prdPath: string, topN: number): PrdContext {
  const resolved = toAbsolute(prdPath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`PRD not found: ${resolved}`);
  }

  const raw = fs.readFileSync(resolved, 'utf8');
  const prd = JSON.parse(raw) as PrdDocument;
  const stories = (Array.isArray(prd.userStories) && prd.userStories.length > 0)
    ? prd.userStories
    : (Array.isArray(prd.tasks) ? prd.tasks : []);

  const pending = stories
    .filter((story) => story && story.passes !== true)
    .sort((a, b) => (a.priority ?? Number.MAX_SAFE_INTEGER) - (b.priority ?? Number.MAX_SAFE_INTEGER));

  const selected = pending.slice(0, Math.max(1, Math.min(20, topN)));
  const completedCount = stories.length - pending.length;
  const pendingSummary = selected.map((story) => `${story.id || 'UNKNOWN'}(${story.priority ?? '-'})`).join('、') || '暂无';

  return {
    sourcePath: resolved,
    project: prd.project || 'unknown',
    branchName: prd.branchName || 'unknown',
    pendingStories: selected,
    completedCount,
    totalStories: stories.length,
    goalSuggestion: selected.length > 0
      ? `按 PRD 优先级推进 ${selected.slice(0, 3).map((story) => story.id || 'UNKNOWN').join('、')}，并兼顾 wow 的 V1/V2 双轨部署`
      : `推进 ${prd.project || 'V1/V2 迭代'} 并完成 wow 环境闭环验证`,
    contextLines: [
      `PRD来源: ${resolved}`,
      `项目: ${prd.project || 'unknown'}`,
      `分支建议: ${prd.branchName || 'unknown'}`,
      `待办Top${selected.length}: ${selected.map((story) => `${story.id || 'UNKNOWN'} ${story.title || 'untitled'}`).join(' | ') || 'none'}`,
      `已通过: ${completedCount}/${stories.length}`,
    ],
  };
}

function collectHistoryFiles(roots: string[]): string[] {
  const files = new Set<string>();
  for (const root of roots) {
    const resolved = toAbsolute(root.trim());
    if (!resolved || !fs.existsSync(resolved)) {
      continue;
    }

    const stat = fs.statSync(resolved);
    if (stat.isFile() && resolved.endsWith('messages.jsonl')) {
      files.add(resolved);
      continue;
    }

    const teamsDir = path.join(resolved, 'teams');
    if (!fs.existsSync(teamsDir) || !fs.statSync(teamsDir).isDirectory()) {
      continue;
    }

    for (const teamId of fs.readdirSync(teamsDir)) {
      const messagesPath = path.join(teamsDir, teamId, 'messages.jsonl');
      if (fs.existsSync(messagesPath) && fs.statSync(messagesPath).isFile()) {
        files.add(messagesPath);
      }
    }
  }

  return Array.from(files);
}

function collectSignals(roots: string[]): TeamEvolutionSignals {
  const readyPatterns = ['online and ready', 'standing by', 'awaiting task assignment', '待命', 'ready for assignment'];
  const incidentPatterns = ['404', 'blocked', 'failed', 'error', 'nginx', 'pm2', '部署失败', '回滚'];
  const coordinatorRoles = new Set(['master', 'orchestrator', 'project-manager', 'product-owner']);

  let total = 0;
  let readyLike = 0;
  let coordinator = 0;
  let incidents = 0;

  for (const filePath of collectHistoryFiles(roots)) {
    for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
      if (!line.trim()) {
        continue;
      }
      try {
        const payload = JSON.parse(line) as { fromRole?: string; content?: string };
        const content = (payload.content || '').toLowerCase();
        total += 1;
        if (readyPatterns.some((pattern) => content.includes(pattern))) {
          readyLike += 1;
        }
        if (incidentPatterns.some((pattern) => content.includes(pattern))) {
          incidents += 1;
        }
        if (payload.fromRole && coordinatorRoles.has(payload.fromRole)) {
          coordinator += 1;
        }
      } catch {
        // Ignore malformed lines.
      }
    }
  }

  if (total === 0) {
    return {
      readyPingRatio: 0,
      coordinatorMessageRatio: 0,
      deploymentIncidentRatio: 0,
      historySampleSize: 0,
    };
  }

  return {
    readyPingRatio: Number((readyLike / total).toFixed(4)),
    coordinatorMessageRatio: Number((coordinator / total).toFixed(4)),
    deploymentIncidentRatio: Number((incidents / total).toFixed(4)),
    historySampleSize: total,
  };
}

function pct(value: number | undefined): string {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : 0;
  return `${(n * 100).toFixed(1)}%`;
}

function buildAskMarkdown(input: {
  goal: string;
  target: 'wow' | 'local' | 'generic';
  signals: TeamEvolutionSignals;
  prd: PrdContext;
  plan: TeamCompositionPlan;
}): string {
  const journey = [
    '发现阶段：用户在 PRD 中确认未完成目标并明确 V1/V2 目标边界。',
    `编组阶段：系统按 ${input.plan.versionTrack.toUpperCase()} 策略返回 ${input.plan.teams.length} 个建议团队。`,
    '执行阶段：团队按分支建议并行推进 aha-cli / happy-server / kanban。',
    '验证阶段：执行自动化脚本，确认关键测试与部署探针通过。',
    '进化阶段：回填历史信号与评分数据，下一轮自动调整团队配比。',
  ];

  return `# ASK 用户旅程访谈（自动生成）

## 基本信息
- 生成时间: ${new Date().toISOString()}
- 目标: ${input.goal}
- 部署目标: ${input.target}
- 版本策略: ${input.plan.versionTrack}
- 编组模式: ${input.plan.mode}

## A - Assess（现状评估）
- PRD: ${input.prd.project}
- 分支建议: ${input.prd.branchName}
- 进度: ${input.prd.completedCount}/${input.prd.totalStories}
- 待办 Top: ${input.prd.pendingStories.map((story) => `${story.id || 'UNKNOWN'}(${story.priority ?? '-'})`).join('、') || '暂无'}
- 历史信号: ready=${pct(input.signals.readyPingRatio)} | coordinator=${pct(input.signals.coordinatorMessageRatio)} | incident=${pct(input.signals.deploymentIncidentRatio)} | sample=${input.signals.historySampleSize ?? 0}
- 推断焦点: ${input.plan.inferredFocus.join(', ') || 'delivery'}

## S - Story（用户旅程）
${journey.map((line, index) => `${index + 1}. ${line}`).join('\n')}

## K - Keep Improving（持续改进问答）
### Q1: 为什么当前要拆分团队？
A1: 因为任务跨三端且含 V1/V2 双轨部署，单团队会出现上下文切换和等待噪声。

### Q2: 本轮闭环验收点是什么？
A2: PRD 待办映射、自动化测试、部署探针（wow: V1/V2）和访谈产物都必须可追踪。

### Q3: 下一轮如何进化？
A3: 继续回填 .aha 历史和评分数据，复用 compose 策略自动收敛角色配比。

## 团队拆分建议
${input.plan.teams.map((team, index) => `### ${index + 1}. ${team.name} (${team.versionTrack})
- 目标: ${team.objective}
- 分支建议: ${team.branchSuggestion}
- 角色配比: ${Object.entries(team.roleCounts).map(([role, count]) => `${role}×${count}`).join('、')}
- 依据: ${team.rationale.join('；') || '无'}
- 风险: ${team.risks.join('；') || '无'}
`).join('\n')}

## 系统建议
${(input.plan.recommendations.length > 0 ? input.plan.recommendations : ['暂无']).map((item) => `- ${item}`).join('\n')}
`;
}

function main(): void {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const repoRoot = path.resolve(__dirname, '..', '..');

  const prdPath = process.env.PRD_PATH || path.join(repoRoot, 'ralph/prd.json');
  const askOutput = process.env.ASK_OUTPUT || path.join(repoRoot, '用户访谈', `自动生成_ASK用户旅程访谈_${new Date().toISOString().slice(0, 10)}.md`);
  const topN = Number(process.env.PRD_TOP || '6');
  const target = (process.env.DEPLOY_TARGET || 'wow') as 'wow' | 'local' | 'generic';
  const historyRoots = (process.env.HISTORY_ROOTS || `${path.join(repoRoot, '.aha')},${path.join(os.homedir(), 'work/opc/.aha')}`)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

  const prd = parsePrd(prdPath, Number.isFinite(topN) ? topN : 6);
  const signals = collectSignals(historyRoots);
  const goal = process.env.COMPOSE_GOAL || prd.goalSuggestion;
  const plan = generateTeamCompositionPlan({
    goal,
    context: prd.contextLines.join('\n'),
    versionTrack: 'dual',
    mode: 'multi',
    deploymentTarget: target,
    maxTeams: 3,
    evolutionSignals: signals,
  });

  const markdown = buildAskMarkdown({
    goal,
    target,
    signals,
    prd,
    plan,
  });

  const outputPath = toAbsolute(askOutput);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, markdown, 'utf8');

  console.log(`ASK report generated: ${outputPath}`);
}

main();
