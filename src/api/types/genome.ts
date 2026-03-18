import { z } from 'zod';

/**
 * GenomeSpec — agent 的完整配置 schema。
 *
 * 类比 Docker：
 *   Genome（服务端记录） = Docker image
 *   运行中的 session     = Docker container
 *   /v1/genomes (public) = Docker Hub
 *   GenomeSpec           = Dockerfile（描述 image 的配置）
 *
 * 字段分层：
 *   Tier 0  身份（genome 必须有的最小信息）
 *   Tier 1  Prompt（最常见的自定义）
 *   Tier 2  模型选择
 *   Tier 3  工具访问控制
 *   Tier 4  权限与执行行为
 *   Tier 5  上下文注入（扩展用，暂未全部实现）
 *   Tier 6  团队路由（给 org-manager 按 genome 组团）
 *   meta    任意 key-value 扩展逃生口
 *
 * 只有 Tier 0 字段是语义上必要的，其余全部可选。
 * 当字段缺失时 CLI 回退到编译期 role 默认值，保证向后兼容。
 */
export interface GenomeSpec {

    // =========================================================================
    // Tier 0 — 身份（最小必要信息，用于 UI 展示 / 路由决策）
    // =========================================================================
    /** 对人可读的名称，显示在 UI 和日志里 */
    displayName?: string;
    /** 一句话描述这个 agent 的用途 */
    description?: string;
    /**
     * 要扩展的内置 role ID（如 "supervisor"、"implementer"）。
     * 设置后 genome 的字段是 overlay：有值的字段覆盖内置 role 默认值，
     * 没有的字段回退到内置 role。
     */
    baseRoleId?: string;
    /**
     * Namespace 作用域。格式：
     *   '@official'   — 官方内置 genome（supervisor、help-agent 等）
     *   '@org-name'   — 组织级 genome
     *   null          — 个人 / 无作用域
     */
    namespace?: string;
    /**
     * 版本号（1-based，只增不减）。
     * 引用时可 pin 到特定版本：fetchGenomeSpec('@official/supervisor', 2)
     * 不填则使用 latest。
     */
    version?: number;
    /**
     * 可搜索的标签列表，用于 Marketplace 搜索过滤。
     * 例：['supervisor', 'bypass', 'monitoring', 'read-only']
     */
    tags?: string[];
    /**
     * Marketplace 分类，用于浏览和路由决策。
     * 例：'coordination' | 'development' | 'qa' | 'support' | 'data'
     */
    category?: string;

    // =========================================================================
    // Tier 1 — Prompt
    // =========================================================================
    /**
     * 完整的 system / instruction prompt，完全替换编译期 hardcode 的 role prompt。
     * 设置后 baseRoleId 的 prompt 部分被忽略（保留其他字段）。
     */
    systemPrompt?: string;
    /**
     * 附加到主 prompt 后面的补充内容。
     * 适合"继承内置 role prompt + 追加领域知识"的场景，
     * 无需重写整个 prompt。
     */
    systemPromptSuffix?: string;
    /**
     * agent 的职责列表（来自 ROLE_DEFINITIONS.yaml 的 responsibilities 字段）。
     * 用于动态生成 systemPrompt（当 systemPrompt 未设置时）。
     * 也用于 UI 展示和 org-manager 路由决策。
     * 例：['Break down user requests', 'Assign tasks based on role expertise']
     */
    responsibilities?: string[];
    /**
     * agent 的协作协议（来自 ROLE_DEFINITIONS.yaml 的 protocol 字段）。
     * 描述 agent 如何与团队互动的规则。
     * 用于动态生成 systemPrompt（当 systemPrompt 未设置时）。
     * 例：['Always announce when starting a task', 'Report blockers immediately']
     */
    protocol?: string[];

    // =========================================================================
    // Tier 2 — 模型
    // =========================================================================
    /** Claude model ID，如 "claude-opus-4-6"、"claude-sonnet-4-6" */
    modelId?: string;
    /**
     * 主模型失败时的 fallback model ID。
     * 对应 EnhancedMode.fallbackModel。
     */
    fallbackModelId?: string;
    /**
     * 模型 provider。当前仅支持 'anthropic'。
     * 设置为 'zhipu'/'openai' 等时 CLI 会记录警告并降级到 anthropic。
     * 为后续 OpenAI 兼容层预留接口。
     */
    modelProvider?: 'anthropic' | 'zhipu' | 'openai' | 'local';

    // =========================================================================
    // Tier 3 — 工具访问控制
    // =========================================================================
    /**
     * 工具白名单。设置后 agent 只能使用列表内的工具，
     * 优先级高于 disallowedTools。
     * 例：["Read", "Grep", "Glob"] 实现只读 agent。
     */
    allowedTools?: string[];
    /**
     * 工具黑名单，叠加在 role 默认黑名单之上。
     * 例：["Bash"] 禁止执行 shell 命令。
     */
    disallowedTools?: string[];
    /**
     * 允许连接的 MCP server 名称列表。
     * 未来实现：暂时存储，CLI 暂不处理。
     */
    mcpServers?: string[];

    // =========================================================================
    // Tier 4 — 权限与执行行为
    // =========================================================================
    /** Claude Code 权限模式 */
    permissionMode?: 'default' | 'acceptEdits' | 'bypassPermissions';
    /** 简化的访问层级，驱动默认工具限制 */
    accessLevel?: 'read-only' | 'full-access';
    /** agent 运行在哪个执行面 */
    executionPlane?: 'mainline' | 'bypass';
    /**
     * 最大对话轮数硬上限，到达后 agent 自动停止。
     * 未来实现：暂时存储，CLI 暂不处理。
     */
    maxTurns?: number;

    // =========================================================================
    // Tier 5 — 上下文注入（扩展用，Meta Self 阶段实现）
    // =========================================================================
    /**
     * 在特定时机向 agent 注入额外上下文。
     * 未来实现：定义在 spec 里但 CLI 暂不处理。
     */
    contextInjections?: Array<{
        /** 注入时机 */
        trigger: 'on_join' | 'per_tool_call' | 'on_context_threshold';
        /** trigger=on_context_threshold 时的触发阈值（0-1，如 0.8 = 80%） */
        threshold?: number;
        /** 注入的文本内容 */
        content: string;
    }>;

    // =========================================================================
    // Tier 6 — 团队路由（org-manager 按 genome 组团时使用）
    // =========================================================================
    /**
     * 这个 agent 在团队里扮演的角色 ID。
     * org-manager 可以通过 genome 直接 spawn 有特定角色的 agent。
     */
    teamRole?: string;
    /**
     * 这个 agent 具备的能力列表（声明式，用于 UI 展示和 org-manager 路由）。
     * 例：["write_code", "review_pr", "run_tests"]
     */
    capabilities?: string[];

    // =========================================================================
    // Tier 7 — 消息行为（个体的通信 DNA，行为跟着基因走，不由军团覆盖）
    // =========================================================================
    /**
     * 消息社交图：定义这个 agent 天生与谁通信。
     *
     * 行为是个体属性，不由军团（CorpsSpec）覆盖。
     * 想要不同行为的 agent 应发布为独立 genome variant，
     * 例：'@official/passive-builder' vs '@official/active-builder'
     */
    messaging?: {
        /**
         * 接受哪些角色发来的消息并响应。
         * - string[]  只响应列表内的角色（如 ['master', 'orchestrator', 'user']）
         * - '*'       接收所有角色的消息
         * 不设置时回退到 ROLE_COLLABORATION_MAP 的 hardcode 默认值。
         */
        listenFrom?: string[] | '*';
        /**
         * 是否是用户消息的入口。
         * true  = 用户消息直接发给我（如 master）
         * false = 用户消息不经过我
         * 不设置时回退到 isCoordinatorRole() 的判断。
         */
        receiveUserMessages?: boolean;
        /**
         * 响应模式（agent 的天生性格）：
         * - 'proactive'   主动型：有任务就自取，会主动发起沟通
         * - 'responsive'  响应型：有呼必应，被动等待分配（默认）
         * - 'passive'     静默型：只做任务不参与聊天
         */
        replyMode?: 'proactive' | 'responsive' | 'passive';
    };

    /**
     * 行为协议：定义这个 agent 天生的行为模式。
     * 与 messaging 一起构成 agent 的"社交 DNA"。
     */
    behavior?: {
        /**
         * 空闲（无任务）时的行为：
         * - 'wait'        等待 master 分配（默认）
         * - 'self-assign' 主动从 available tasks 自取任务
         * - 'ask'         主动向 master 询问下一步
         */
        onIdle?: 'wait' | 'self-assign' | 'ask';
        /**
         * 遇到阻塞时的行为：
         * - 'report'    向 master 上报 blocker（默认）
         * - 'escalate'  直接升级给更高层协调者
         * - 'retry'     自行重试后再上报
         */
        onBlocked?: 'report' | 'escalate' | 'retry';
        /**
         * 是否可以召唤新的 agent（调用 create_agent）。
         * 不设置时回退到 canSpawnAgents(role) 的 hardcode 判断。
         */
        canSpawnAgents?: boolean;
        /**
         * 是否必须等待显式分配才能开始工作。
         * true  = 等待 master 分配或 kanban 任务（默认 worker 行为）
         * false = 可自取 available tasks（proactive 变种）
         */
        requireExplicitAssignment?: boolean;
    };

    // =========================================================================
    // Layer 3 — Memory & Learning
    // =========================================================================
    memory?: {
        type?: 'session' | 'persistent' | 'shared';
        learnings?: string[];
        iterationGuide?: {
            recentChanges?: string[];
            discoveries?: string[];
            improvements?: string[];
        };
        knowledgeBase?: string[];
    };

    // =========================================================================
    // Layer 4 — Capability & Governance
    // =========================================================================
    scopeOfResponsibility?: {
        ownedPaths?: string[];
        forbiddenPaths?: string[];
        outOfScope?: string[];
    };
    modelScores?: Record<string, number>;
    preferredModel?: string;

    // =========================================================================
    // Layer 5 — Agent Resume
    // =========================================================================
    resume?: {
        specialties?: string[];
        workHistory?: Array<{
            project?: string;
            domain?: string;
            tasksCompleted?: number;
            avgScore?: number;
            period?: string;
        }>;
        performanceRating?: number;
        totalSessions?: number;
        reviews?: string[];
    };

    // =========================================================================
    // Layer 6 — Operational Knowledge
    // =========================================================================
    operations?: {
        commonPatterns?: string[];
        recentChanges?: string[];
        runtimeConfig?: string;
    };

    // =========================================================================
    // Tier 8 — Hooks（Claude Code 自动化钩子）
    // =========================================================================
    /**
     * Per-agent Claude Code hooks，在工具调用生命周期中自动执行。
     * 与全局 ~/.claude/settings.json hooks 互补，但作用域限定到本 genome。
     */
    hooks?: {
        /** 在工具调用前执行 */
        preToolUse?: Array<{ matcher: string; command: string; description?: string }>;
        /** 在工具调用后执行 */
        postToolUse?: Array<{ matcher: string; command: string; description?: string }>;
        /** 在会话结束时执行 */
        stop?: Array<{ command: string; description?: string }>;
    };

    // =========================================================================
    // Tier 9 — Skills（可调用的 slash-command 能力）
    // =========================================================================
    /**
     * 此 agent 可调用的 skill 名称列表。
     * Skill 从 agent 工作目录或全局注册表中解析。
     */
    skills?: string[];

    // =========================================================================
    // Tier 10 — Marketplace & Lifecycle（市场发布 / 生命周期元数据）
    // =========================================================================

    /**
     * Agent 运行时类型。
     * 用于市场检索过滤、spawning 路由到正确的 runtime。
     * 'claude' = Anthropic Claude Code, 'codex' = OpenAI Codex CLI,
     * 'open-code' = OpenCode (open-source Claude Code alternative)
     */
    runtimeType?: 'claude' | 'codex' | 'open-code';

    /**
     * 激活触发条件。
     * 描述此 genome 应在什么情境下被激活/召唤。
     * - mention: 被 @mention 时激活
     * - task-assign: 有任务分配给它时激活
     * - scheduled: 按计划定期激活
     * - event: 由特定事件触发激活
     */
    trigger?: {
        mode: 'mention' | 'task-assign' | 'scheduled' | 'event';
        /** 触发条件列表，如 ['PR opened', 'build failed'] */
        conditions?: string[];
    };

    /**
     * 版本溯源信息。
     * 记录此 genome 的来源、是否从市场 fork、经历了哪些 mutation。
     */
    provenance?: {
        /** 父 genome ID（fork 自某个市场 genome 时记录） */
        parentId?: string;
        /** 本次 mutation 说明（forked/mutated 时记录修改内容摘要） */
        mutationNote?: string;
        /** 来源类型 */
        origin?: 'original' | 'forked' | 'mutated';
    };

    /**
     * 评估标准。
     * 描述评估此 agent 表现好坏的具体指标列表。
     * 用于自动评分、市场评价展示。
     * 示例: ['按时完成任务', '代码无 TypeScript 错误', '测试覆盖率 ≥ 80%']
     */
    evalCriteria?: string[];

    /**
     * 资源消耗画像。
     * 帮助用户在市场中评估此 genome 的运行成本。
     */
    costProfile?: {
        /** 典型任务的 token 消耗量（用于成本估算） */
        typicalTokens?: number;
        /** 所需的上下文窗口大小（tokens），超过此值会降低效果 */
        contextWindowReq?: number;
    };

    /**
     * 生命周期状态。
     * - experimental: 实验性，可能不稳定
     * - active: 稳定运行中
     * - deprecated: 已废弃，建议迁移到更新版本
     */
    lifecycle?: 'experimental' | 'active' | 'deprecated';

    // =========================================================================
    // 逃生口 — 任意扩展
    // =========================================================================
    /**
     * 任意 key-value，用于存储 GenomeSpec 尚未定义的字段。
     * CLI 遇到 meta 里的字段会忽略，不会报错。
     * 随着系统演进，成熟的 meta 字段会被提升到正式字段。
     */
    meta?: Record<string, unknown>;
}

export const GenomeRuntimeTypeSchema = z.enum(['claude', 'codex', 'open-code']);
export const GenomeTriggerModeSchema = z.enum(['mention', 'task-assign', 'scheduled', 'event']);
export const GenomeProvenanceOriginSchema = z.enum(['original', 'forked', 'mutated']);
export const GenomeLifecycleSchema = z.enum(['experimental', 'active', 'deprecated']);

/** 服务端返回的完整 Genome 记录 */
export interface Genome {
    id: string;
    accountId: string;
    name: string;
    description?: string | null;
    /** JSON 序列化的 GenomeSpec */
    spec: string;
    parentSessionId: string;
    teamId?: string | null;
    spawnCount: number;
    lastSpawnedAt?: string | null;
    isPublic: boolean;
    createdAt: string;
    updatedAt: string;
}

/** 解析 Genome.spec 字段为 GenomeSpec 对象 */
export function parseGenomeSpec(genome: Genome): GenomeSpec {
    return JSON.parse(genome.spec) as GenomeSpec;
}

/**
 * CorpsSpec — 军团配置 schema。
 *
 * 军团 = 多个 genome 的组合 + 共享启动上下文。
 * 军团不定义行为规则（行为由每个 genome 自身携带），
 * 只提供成员名单和启动时注入给每个成员的共享信息。
 *
 * 类比：
 *   CorpsSpec    = docker-compose.yml（组合多个镜像）
 *   GenomeSpec   = Dockerfile（定义单个镜像的完整行为）
 */
export interface CorpsSpec {
    // ─── 基础标识 ──────────────────────────────────────────────────
    namespace: string;        // '@official', '@myorg'
    name: string;             // 'fullstack-sprint', 'research-team'
    version: number;
    description: string;
    tags?: string[];
    category?: string;        // 'engineering' | 'research' | 'product' | string

    // ─── 成员名单 ──────────────────────────────────────────────────
    /**
     * 军团成员列表：启动时召唤哪些 genome。
     * 每个 genome 携带自己完整的行为 DNA，军团不覆盖任何行为。
     */
    members: {
        /** genome 引用，格式：'@namespace/name@version' 或 '@namespace/name'（latest） */
        genome: string;
        /** 在此军团内的角色别名（用于 UI 展示），不覆盖 genome 内部的 baseRoleId */
        roleAlias?: string;
        /** 启动几个实例，默认 1 */
        count?: number;
        /** false = 按需召唤，true = 军团启动时立即召唤（默认 true） */
        required?: boolean;
    }[];

    // ─── 共享启动上下文 ─────────────────────────────────────────────
    /**
     * 启动时注入给每个成员的共享上下文。
     * 这是军团唯一可以"干预"成员的地方：告知成员"你在哪个军团、军团目标是什么"。
     * 不干预成员的行为规则（listenFrom、replyMode 等由各自 genome 决定）。
     */
    bootContext?: {
        /** 军团级别的背景说明，注入给每个成员的 systemPromptSuffix */
        teamDescription?: string;
        /** org-manager 启动时的初始目标 */
        initialObjective?: string;
    };
}

/**
 * AgentPackageRef — 标准化的 agent/package 身份。
 *
 * 说明：
 * - `specId` 仍保留作兼容指针，但它不是长期的可移植身份。
 * - 新语义以 `ref + version + digest` 为准，供市场、引擎、评分回流共同绑定。
 */
export interface AgentPackageRef {
    ref: string;
    version: number;
    digest?: string;
    source?: 'hub' | 'server' | 'local-file';
}

/**
 * RuntimeAdapterSpec — 某个 runtime 上的运行契约。
 * Canonical card 可以为同一个 agent 同时携带多个 adapter。
 */
export interface RuntimeAdapterSpec {
    runtime: 'claude' | 'codex' | 'open-code';
    entry?: {
        instructionFile?: string;
        bootstrapPrompt?: string;
        workingDirectoryMode?: 'inherit' | 'fixed';
    };
    model?: {
        provider?: 'anthropic' | 'zhipu' | 'openai' | 'local';
        primary?: string;
        fallback?: string;
        preferred?: string;
    };
    tools?: {
        allowed?: string[];
        disallowed?: string[];
        mcpServers?: string[];
        skills?: string[];
        hooks?: {
            preToolUse?: Array<{ matcher: string; command: string; description?: string }>;
            postToolUse?: Array<{ matcher: string; command: string; description?: string }>;
            stop?: Array<{ command: string; description?: string }>;
        };
    };
    sandbox?: {
        permissionMode?: 'default' | 'acceptEdits' | 'bypassPermissions';
        accessLevel?: 'read-only' | 'full-access';
        executionPlane?: 'mainline' | 'bypass';
        maxTurns?: number;
    };
    env?: {
        requiredEnv?: string[];
        optionalEnv?: string[];
        secretsPolicy?: string[];
    };
    io?: {
        expects?: string[];
        produces?: string[];
        artifactFormats?: string[];
    };
    evidence?: {
        logKinds?: string[];
        scorecardSchemaVersion?: string;
    };
}

/**
 * CanonicalAgentCard — 内部标准对象。
 *
 * 作用：
 * - 供 engine/runtime 使用
 * - 供 supervisor 评分绑定 package identity
 * - 供 org-manager 复用
 * - 供市场投影生成 A2A / listing card
 */
export interface CanonicalAgentCard {
    kind: 'aha.agent.v1';
    identity: AgentPackageRef & {
        namespace: string;
        name: string;
        displayName?: string;
        description?: string;
    };
    genome: GenomeSpec;
    adapters?: {
        claude?: RuntimeAdapterSpec;
        codex?: RuntimeAdapterSpec;
        'open-code'?: RuntimeAdapterSpec;
    };
    market?: {
        category?: string;
        tags?: string[];
        lifecycle?: 'experimental' | 'active' | 'deprecated';
        tagline?: string;
    };
    lineage?: {
        origin?: 'original' | 'forked' | 'mutated';
        parentId?: string;
        variantOf?: string;
        mutationNote?: string;
    };
}

/** AgentPackageManifest 当前与 CanonicalAgentCard 同义，保留独立命名给后续打包层使用。 */
export type AgentPackageManifest = CanonicalAgentCard;

/**
 * A2AProjectionCard — 面向 A2A / 外部发现的投影对象。
 * 这不是内部唯一真相源，只是从 canonical card 派生出的 outward card。
 */
export interface A2AProjectionCard {
    protocolVersion: string;
    name: string;
    description: string;
    url: string;
    version?: string;
    preferredTransport?: string;
    defaultInputModes?: string[];
    defaultOutputModes?: string[];
    capabilities?: Record<string, unknown>;
    securitySchemes?: Record<string, unknown>;
    security?: Array<Record<string, unknown>>;
    skills?: Array<{
        id: string;
        name: string;
        description?: string;
        tags?: string[];
        examples?: string[];
        inputModes?: string[];
        outputModes?: string[];
    }>;
}
