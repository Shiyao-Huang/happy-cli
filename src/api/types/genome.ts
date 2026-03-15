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
    // 逃生口 — 任意扩展
    // =========================================================================
    /**
     * 任意 key-value，用于存储 GenomeSpec 尚未定义的字段。
     * CLI 遇到 meta 里的字段会忽略，不会报错。
     * 随着系统演进，成熟的 meta 字段会被提升到正式字段。
     */
    meta?: Record<string, unknown>;
}

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
