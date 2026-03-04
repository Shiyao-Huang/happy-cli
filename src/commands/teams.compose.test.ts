import { describe, expect, it } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { __teamsComposeTestables } from './teams';

describe('teams compose helpers', () => {
  it('does not treat --ask-output path as goal text', () => {
    const goal = __teamsComposeTestables.extractComposeGoal([
      '--ask-output',
      './用户访谈/ASK.md',
    ]);
    expect(goal).toBe('');
  });

  it('does not treat --spec-output path as goal text', () => {
    const goal = __teamsComposeTestables.extractComposeGoal([
      '--spec-output',
      './DOC/V6_SPEC.md',
    ]);
    expect(goal).toBe('');
  });

  it('loads PRD context and picks pending stories by priority', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aha-teams-prd-'));
    const prdPath = path.join(dir, 'prd.json');
    fs.writeFileSync(
      prdPath,
      JSON.stringify({
        project: 'Role & Rating System',
        userStories: [
          { id: 'A', title: 'done', priority: 2, passes: true },
          { id: 'B', title: 'todo-high', priority: 1, passes: false },
          { id: 'C', title: 'todo-low', priority: 8, passes: false },
        ],
      })
    );

    const context = __teamsComposeTestables.loadPrdComposeContext(prdPath, 2);
    expect(context.completedCount).toBe(1);
    expect(context.totalStories).toBe(3);
    expect(context.pendingStories.map((story) => story.id)).toEqual(['B', 'C']);
    expect(context.goalSuggestion).toContain('B');
  });

  it('collects evolution signals from .aha history roots', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aha-teams-history-'));
    const messagesDir = path.join(dir, 'teams', 'team-1');
    fs.mkdirSync(messagesDir, { recursive: true });
    const messagesPath = path.join(messagesDir, 'messages.jsonl');
    const lines = [
      { fromRole: 'master', content: 'Ready for assignment' },
      { fromRole: 'orchestrator', content: 'standing by' },
      { fromRole: 'implementer', content: '部署失败 rollback needed' },
      { fromRole: 'researcher', content: 'normal update' },
    ];
    fs.writeFileSync(messagesPath, lines.map((line) => JSON.stringify(line)).join('\n'));

    const signals = __teamsComposeTestables.collectEvolutionSignals([dir]);
    expect(signals.historySampleSize).toBe(4);
    expect(signals.readyPingRatio).toBeGreaterThan(0);
    expect(signals.coordinatorMessageRatio).toBeGreaterThan(0);
    expect(signals.deploymentIncidentRatio).toBeGreaterThan(0);
  });

  it('builds ASK markdown with branch suggestion content', () => {
    const markdown = __teamsComposeTestables.buildAskInterviewMarkdown({
      goal: '推进 wow v1/v2 迭代',
      target: 'wow',
      signals: {
        readyPingRatio: 0.3,
        coordinatorMessageRatio: 0.4,
        deploymentIncidentRatio: 0.1,
        historySampleSize: 120,
      },
      plan: {
        mode: 'multi',
        versionTrack: 'dual',
        deploymentTarget: 'wow',
        inferredFocus: ['deployment', 'orchestration'],
        constraints: ['constraint'],
        recommendations: ['recommendation'],
        signalsUsed: {
          readyPingRatio: 0.3,
          coordinatorMessageRatio: 0.4,
          deploymentIncidentRatio: 0.1,
          idleStatusRatio: 0.2,
          cliFocusRatio: 0.08,
          serverFocusRatio: 0.2,
          kanbanFocusRatio: 0.12,
          historySampleSize: 120,
        },
        teams: [
          {
            key: 'v2-delivery',
            name: 'V2 功能迭代组',
            objective: 'deliver',
            versionTrack: 'v2',
            branchSuggestion: 'feat/v2-v2-delivery',
            roleCounts: { master: 1, implementer: 2 },
            evoMap: {
              score: 4.2,
              tier: 'A',
              trend: 'flat',
              highlights: ['qa + architect 完整'],
            },
            rationale: ['r1'],
            risks: ['risk1'],
          },
        ],
        releaseGates: [
          {
            versionTrack: 'v2',
            branch: 'release/v2-integration',
            completionRule: '同版本分支必须完成三端调试才能关闭分支',
            requiredChecks: [
              { component: 'aha-cli', environments: ['uv1', 'uv2', 'wow'], status: 'pending' },
              { component: 'happy-server', environments: ['uv1', 'uv2', 'wow'], status: 'pending' },
              { component: 'kanban', environments: ['uv1', 'uv2', 'wow'], status: 'pending' },
            ],
          },
        ],
      },
    });

    expect(markdown).toContain('ASK 用户旅程访谈');
    expect(markdown).toContain('feat/v2-v2-delivery');
    expect(markdown).toContain('Keep Improving');
  });

  it('builds SPEC markdown with release gates and evo map', () => {
    const markdown = __teamsComposeTestables.buildSpecMarkdown({
      goal: '推进 V1/V2 多团队协作',
      target: 'wow',
      signals: {
        readyPingRatio: 0.28,
        coordinatorMessageRatio: 0.42,
        deploymentIncidentRatio: 0.09,
        idleStatusRatio: 0.3,
        cliFocusRatio: 0.06,
        serverFocusRatio: 0.23,
        kanbanFocusRatio: 0.15,
        historySampleSize: 240,
      },
      plan: {
        mode: 'multi',
        versionTrack: 'dual',
        deploymentTarget: 'wow',
        inferredFocus: ['deployment', 'backend', 'frontend'],
        constraints: ['同版本分支需三端调试'],
        recommendations: ['先 uv1/uv2，再 wow'],
        signalsUsed: {
          readyPingRatio: 0.28,
          coordinatorMessageRatio: 0.42,
          deploymentIncidentRatio: 0.09,
          idleStatusRatio: 0.3,
          cliFocusRatio: 0.06,
          serverFocusRatio: 0.23,
          kanbanFocusRatio: 0.15,
          historySampleSize: 240,
        },
        teams: [
          {
            key: 'v1-guard',
            name: 'V1 稳定性保障组',
            objective: '保证 v1 稳定',
            versionTrack: 'v1',
            branchSuggestion: 'feat/v1-v1-guard',
            roleCounts: { master: 1, implementer: 1, 'qa-engineer': 1 },
            evoMap: {
              score: 3.8,
              tier: 'B',
              trend: 'flat',
              highlights: ['发布风险可控'],
            },
            rationale: ['r1'],
            risks: ['risk1'],
          },
        ],
        releaseGates: [
          {
            versionTrack: 'v1',
            branch: 'release/v1-integration',
            completionRule: '同版本分支必须完成三端调试才能关闭分支',
            requiredChecks: [
              { component: 'aha-cli', environments: ['uv1', 'uv2', 'wow'], status: 'pending' },
              { component: 'happy-server', environments: ['uv1', 'uv2', 'wow'], status: 'pending' },
              { component: 'kanban', environments: ['uv1', 'uv2', 'wow'], status: 'pending' },
            ],
          },
        ],
      },
    });

    expect(markdown).toContain('版本门禁');
    expect(markdown).toContain('EvoMap');
    expect(markdown).toContain('uv1');
    expect(markdown).toContain('aha-cli');
    expect(markdown).toContain('同版本分支必须完成三端调试');
  });
});
