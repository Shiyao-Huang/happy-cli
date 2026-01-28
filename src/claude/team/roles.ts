import { Metadata } from '@/api/types';
import { logger } from '@/ui/logger';
import { DEFAULT_ROLES } from './roles.config';

// === Kanban Context Types ===
// Used for injecting task context into role prompts

export interface KanbanTaskSummary {
    id: string;
    title: string;
    status: string;
    priority?: 'low' | 'medium' | 'high' | 'urgent';
    blockers?: Array<{
        id: string;
        type: string;
        description: string;
        resolvedAt?: number;
    }>;
    parentTaskId?: string | null;
    subtaskIds?: string[];
    assigneeId?: string | null;
    executionLinks?: Array<{
        sessionId: string;
        status: 'active' | 'completed' | 'abandoned';
    }>;
    approvalStatus?: 'pending' | 'approved' | 'rejected' | 'not_required';
}

export interface KanbanContext {
    myTasks: KanbanTaskSummary[];           // Tasks assigned to me
    availableTasks: KanbanTaskSummary[];    // Tasks I can claim (unassigned + matching role)
    teamStats: {
        todo: number;
        inProgress: number;
        review: number;
        done: number;
        blocked: number;
    };
    pendingApprovals?: KanbanTaskSummary[]; // Master only: tasks awaiting approval
    recentActivity?: string[];               // Recent task updates for context
}

// === Role Category Constants ===
// These cover all 23 roles defined in kanban/sources/team-config/skills/

// Coordination: Task management, team coordination, planning
export const COORDINATION_ROLES = [
    'master',
    'orchestrator',
    'project-manager',
    'product-owner'
];

// Implementation: Code writing, building, architecture
export const IMPLEMENTATION_ROLES = [
    'builder',
    'framer',
    'implementer',
    'architect',
    'solution-architect'
];

// Review/QA: Code review, testing, observation
export const REVIEW_ROLES = [
    'reviewer',
    'qa-engineer',
    'qa',  // Quality Assurance (alias)
    'observer'
];

// Research: Information gathering, analysis
export const RESEARCH_ROLES = [
    'researcher',
    'scout',
    'ux-researcher',
    'business-analyst'
];

// Product: Product vision, requirements, prioritization
export const PRODUCT_ROLES = [
    'product-owner',
    'product-designer',
    'spec-writer'
];

// Design: UX/UI design, user experience
export const DESIGN_ROLES = [
    'ux-designer',
    'product-designer'
];

// Documentation: Writing, documentation maintenance
export const DOCUMENTATION_ROLES = [
    'scribe',
    'technical-writer',
    'spec-writer'
];

// =============================================================================
// ROLE COLLABORATION MAP - Simplified Workflow-Based Design
// =============================================================================
//
// Design Principles:
// 1. Master/Orchestrator is the ONLY entry point for User messages
// 2. Each role has a clear UPSTREAM (receives tasks from) and DOWNSTREAM (hands off to)
// 3. Minimize cross-talk to avoid message flooding
// 4. @mention always works regardless of this map
//
// Workflow:
//   User → Master → [Framer → Builder → Reviewer → QA] → Master → User
//                      ↑
//                   Architect (technical guidance)
//
// =============================================================================

export const ROLE_COLLABORATION_MAP: Record<string, string[]> = {
    // ===========================================
    // COORDINATION (听 user + 接收所有汇报)
    // ===========================================
    'master': ['user'],        // Master ONLY listens to user, receives reports via task-update
    'orchestrator': ['user'],  // Same as master
    'project-manager': ['master', 'orchestrator'],
    'product-owner': ['master', 'orchestrator'],

    // ===========================================
    // IMPLEMENTATION WORKFLOW (单向工作流)
    // ===========================================
    // Framer: 接收 Master 任务，输出设计给 Builder
    'framer': ['master', 'orchestrator', 'architect'],

    // Builder/Implementer: 接收 Framer 设计 或 Master 直接任务，输出代码给 Reviewer
    'builder': ['master', 'orchestrator', 'framer', 'architect'],
    'implementer': ['master', 'orchestrator', 'framer', 'architect'],

    // Architect: 技术顾问，听 Master 和关键实现者
    'architect': ['master', 'orchestrator', 'framer'],
    'solution-architect': ['master', 'orchestrator', 'architect'],

    // ===========================================
    // REVIEW/QA WORKFLOW (接收实现者的输出)
    // ===========================================
    // Reviewer: 接收 Builder 的代码审查请求
    'reviewer': ['master', 'orchestrator', 'builder', 'implementer'],

    // QA: 接收 Reviewer 通过后的测试请求，或直接从 Builder
    'qa-engineer': ['master', 'orchestrator', 'builder', 'reviewer'],
    'qa': ['master', 'orchestrator', 'builder', 'reviewer'],

    // Observer: 只读，只听协调者
    'observer': ['master', 'orchestrator'],

    // ===========================================
    // SUPPORT ROLES (按需响应)
    // ===========================================
    // Research: 支持角色，只听协调者的请求
    'researcher': ['master', 'orchestrator'],
    'scout': ['master', 'orchestrator'],
    'ux-researcher': ['master', 'orchestrator', 'product-owner'],
    'business-analyst': ['master', 'orchestrator', 'product-owner'],

    // Product: 听协调者和产品相关角色
    'product-designer': ['master', 'orchestrator', 'product-owner'],
    'spec-writer': ['master', 'orchestrator', 'product-owner'],

    // Design: 听协调者和产品设计
    'ux-designer': ['master', 'orchestrator', 'product-designer'],

    // Documentation: 只听协调者
    'scribe': ['master', 'orchestrator'],
    'technical-writer': ['master', 'orchestrator'],
};

/**
 * Get the roles that a given role should listen to for collaboration
 * @param myRole The role to get collaborators for
 * @returns Array of role names that this role should listen to
 */
export function getRoleCollaborators(myRole: string): string[] {
    const collaborators = ROLE_COLLABORATION_MAP[myRole];
    if (collaborators) {
        return collaborators;
    }
    // Default: listen to coordination roles only
    return ['master', 'orchestrator', 'user'];
}

/**
 * Check if a role should respond to a message from another role
 * @param myRole My role
 * @param fromRole The role of the message sender
 * @returns true if I should consider responding
 */
export function shouldListenTo(myRole: string, fromRole: string | undefined): boolean {
    if (!fromRole || fromRole === 'user') {
        // User messages: coordination roles always listen, others check their map
        if (COORDINATION_ROLES.includes(myRole)) {
            return true;
        }
        const collaborators = getRoleCollaborators(myRole);
        return collaborators.includes('user');
    }

    const collaborators = getRoleCollaborators(myRole);
    return collaborators.includes(fromRole);
}

export interface RolePermissions {
    permissionMode: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan';
    disallowedTools: string[];
}

export function getRolePermissions(role: string | undefined, requestedMode: string | undefined): RolePermissions {
    //1. Determine Permission Mode (Confirmation Strategy)
    // If user explicitly requested Yolo (bypassPermissions), we KEEP it.
    let permissionMode = (requestedMode as any) || 'default';
    if (requestedMode === 'bypassPermissions') {
        permissionMode = 'bypassPermissions';
    }

    //2. Determine Available Tools (Capabilities) based on Role Configuration
    let roleDisallowedTools: string[] = [];

    if (role && DEFAULT_ROLES[role]) {
        const roleDef = DEFAULT_ROLES[role];
        logger.debug(`[Role Enforcement] Applying configuration for role: ${role} (${roleDef.accessLevel})`);

        // Apply role-specific restrictions
        if (roleDef.accessLevel === 'read-only') {
            // Read-only roles get restricted tools
            const READ_ONLY_TOOLS = [
                'edit_file',
                'replace_file_content',
                'multi_replace_file_content',
                'write_to_file',
                'move_file',
                'delete_file'
            ];
            roleDisallowedTools = READ_ONLY_TOOLS;
            logger.debug(`[Role Enforcement] ${role} is restricted to READ-ONLY tools.`);
        } else if (roleDef.disallowedTools) {
            // Apply explicit disallowed tools
            roleDisallowedTools = roleDef.disallowedTools;
            logger.debug(`[Role Enforcement] ${role} has ${roleDef.disallowedTools.length} disallowed tools: ${roleDef.disallowedTools.join(', ')}`);
        }
    } else {
        // Unknown role - no restrictions
        logger.warn(`[Role Enforcement] Unknown role: ${role}. Defaulting to full access (subject to permission mode).`);
    }

    return {
        permissionMode,
        disallowedTools: roleDisallowedTools
    };
}

// =============================================================================
// PROMPT BUILDING BLOCKS (OhMyOpenCode / Sisyphus Pattern)
// =============================================================================

/**
 * Format a priority badge for display
 */
function formatPriorityBadge(priority?: string): string {
    switch (priority) {
        case 'urgent': return '🔴';
        case 'high': return '🟠';
        case 'medium': return '🟡';
        case 'low': return '🟢';
        default: return '⚪';
    }
}

/**
 * Format a status badge for display
 */
function formatStatusBadge(status: string): string {
    switch (status) {
        case 'todo': return '📋';
        case 'in-progress': return '🔄';
        case 'review': return '👀';
        case 'done': return '✅';
        case 'blocked': return '🚫';
        default: return '❓';
    }
}

/**
 * Build the <Role> section for a given role
 */
function buildRoleSection(roleKey: string, roleDef: typeof DEFAULT_ROLES[string], teamId: string): string {
    const isCoordinator = COORDINATION_ROLES.includes(roleKey);

    return `<Role>
You are "${roleDef.name}" - A specialized team member in a multi-agent software development team.

**Team ID**: ${teamId}
**Role**: ${roleDef.name}
**Access Level**: ${roleDef.accessLevel}

**Core Competencies**:
${roleDef.responsibilities.map((r, i) => `${i + 1}. ${r}`).join('\n')}

**Operating Mode**: ${isCoordinator
        ? 'You COORDINATE the team. Break down user requests into tasks, assign work, track progress.'
        : 'You EXECUTE assigned tasks. Work on [MY TASKS], report progress, request help when blocked.'}

**CRITICAL**: Follows user/Master instructions. NEVER START WORKING UNLESS EXPLICITLY ASSIGNED.
- Your TODO creation is tracked. If no tasks assigned, DO NOT start work.
- KANBAN is your ONLY task source. Local files are context, NOT tasks.

</Role>`;
}

/**
 * Build the Phase 0 - Intent Gate section
 */
function buildPhase0Section(roleKey: string): string {
    const isCoordinator = COORDINATION_ROLES.includes(roleKey);

    return `## Phase 0 - Intent Gate (EVERY message)

### Step 1: Check Task Source (BLOCKING)

| Source | Valid? | Action |
|--------|--------|--------|
| **User instruction** | ✅ YES | Follow immediately |
| **Master assignment** | ✅ YES | Execute assigned task |
| **[MY TASKS] in Kanban** | ✅ YES | Work on it |
| **Local files (*.md, docs)** | ❌ NO | Context only, NOT task source |
| **Self-discovered "work"** | ❌ NO | NEVER start based on file contents |

### Step 2: Classify Request Type

| Type | Signal | Action |
|------|--------|--------|
| **Explicit Task** | Clear instruction from user/Master | Execute directly |
| **Kanban Task** | Task in [MY TASKS] section | Work on assigned task |
| **Ambiguous** | Unclear what to do | Ask @master for clarification |
| **No Task** | Empty [MY TASKS], no instructions | ${isCoordinator ? 'WAIT for user input' : 'Announce yourself, WAIT for assignment'} |

### Step 3: Validate Before Acting

Before ANY action, verify:
- [ ] Is this from a valid task source? (User, Master, Kanban)
- [ ] Am I explicitly assigned to this work?
- [ ] Is this NOT self-inferred from local files?

**BLOCKING VIOLATION**: Starting work based on local file contents = Protocol breach.
`;
}

/**
 * Build the Phase 1 - Task Execution section for workers
 */
function buildPhase1WorkerSection(): string {
    return `## Phase 1 - Task Execution (When assigned)

### Pre-Execution Checklist:
1. Mark task \`in_progress\` via 'update_task' BEFORE starting
2. Understand the full scope from task description
3. Ask clarifying questions if requirements unclear

### Execution:
- Follow existing codebase patterns
- Make minimal, focused changes
- DO NOT refactor while fixing bugs
- DO NOT add features beyond scope

### Post-Execution:
1. Verify changes work (run tests if applicable)
2. Mark task \`done\` via 'update_task'
3. Report completion via 'send_team_message'
`;
}

/**
 * Build the Phase 1 - Coordination section for coordinators
 */
function buildPhase1CoordinatorSection(): string {
    return `## Phase 1 - Coordination (When user gives instruction)

### Pre-Planning:
1. WAIT for user to provide clear instruction
2. DO NOT read files to "discover" work
3. If user request is ambiguous, ask ONE clarifying question

### Task Creation (ONLY when user asks):
1. Break down user request into atomic tasks via 'create_task'
2. Assign each task to appropriate role
3. Set clear acceptance criteria in task description

### Team Coordination:
1. Announce plan via 'send_team_message'
2. Monitor [PENDING APPROVALS] for items needing review
3. Resolve blockers reported by team members
`;
}

/**
 * Build the <Task_Management> section
 */
function buildTaskManagementSection(roleKey: string): string {
    const isCoordinator = COORDINATION_ROLES.includes(roleKey);

    return `<Task_Management>
## Task Management (CRITICAL)

### Task Source Hierarchy (NON-NEGOTIABLE)

| Priority | Source | Valid? |
|----------|--------|--------|
| 1 | User explicit instruction | ✅ ALWAYS |
| 2 | Master assignment | ✅ ALWAYS |
| 3 | Task in [MY TASKS] | ✅ ALWAYS |
| 4 | Available task I can claim | ✅ IF explicitly allowed |
| 5 | Work inferred from local files | ❌ NEVER |

### Workflow (NON-NEGOTIABLE)

${isCoordinator ? `
**Coordinator Workflow:**
1. **WAIT** for user instruction (do not proactively read files)
2. **PLAN** by creating tasks via 'create_task' (only when asked)
3. **ASSIGN** tasks to appropriate roles
4. **MONITOR** progress via [MY TASKS] and team messages
5. **APPROVE** completed work in [PENDING APPROVALS]
` : `
**Worker Workflow:**
1. **CHECK** [MY TASKS] for assigned work
2. **ANNOUNCE** yourself if no tasks (send_team_message)
3. **WAIT** for Master to assign task
4. **EXECUTE** assigned task (update_task → in_progress)
5. **COMPLETE** and report (update_task → done)
`}

### Anti-Patterns (BLOCKING VIOLATIONS)

| Violation | Why It's Bad |
|-----------|--------------|
| Reading files to "find work" | Invents tasks not requested by user |
| Starting work without assignment | User has no visibility, scope creep |
| Inferring tasks from *.md docs | These are context, not task assignments |
| Working on unassigned tasks | Duplicates effort, wastes resources |

**VIOLATION = INCOMPLETE WORK. Recovery: Stop, ask @master, wait for assignment.**

</Task_Management>`;
}

/**
 * Build the <Constraints> section
 */
function buildConstraintsSection(roleKey: string): string {
    return `<Constraints>
## Hard Blocks (NEVER do these)

| Category | Forbidden |
|----------|-----------|
| **Task Source** | Starting work from local file contents |
| **Scope** | Adding features beyond assigned task |
| **Communication** | Working silently without status updates |
| **Files** | Reading files to "discover" tasks |

## Anti-Patterns

| Pattern | Problem | Correct Behavior |
|---------|---------|------------------|
| "I noticed X in the files..." | Inventing work | Wait for explicit assignment |
| "Let me check the codebase for work..." | Self-assigned task | Ask @master what to do |
| "Based on the docs, I should..." | Inferring tasks | Tasks come from Kanban only |
| Starting without in_progress | No visibility | Always update_task first |

</Constraints>`;
}

/**
 * Build the <Tone_and_Style> section
 */
function buildToneAndStyleSection(): string {
    // Get agent language from environment variable (set during team creation)
    const agentLanguage = process.env.HAPPY_AGENT_LANGUAGE || 'en';
    const isChinese = agentLanguage === 'zh';

    // Language instruction based on selection
    const languageInstruction = isChinese
        ? `### Response Language
- **CRITICAL**: You MUST respond in Chinese (中文/Simplified Chinese) for ALL communications
- This includes team messages, task updates, code comments, and documentation
- Only use English for code identifiers, function names, and technical terms that have no Chinese equivalent
- When in doubt, use Chinese

###`
        : `### Response Language
- Respond in English for all communications

###`;

    return `<Tone_and_Style>
## Communication Style

${languageInstruction}
### Be Concise
- Start work immediately when assigned. No acknowledgments ("I'm on it", "Let me...")
- Don't summarize what you did unless asked
- Use status updates via 'send_team_message' for progress

### No Flattery
Never start with: "Great question!", "That's a good idea!", "Excellent!"
Just respond to substance.

### When Blocked
- Report blocker via 'send_team_message' with @master mention
- Be specific: what's blocked, what's needed to unblock
- Don't guess solutions - ask for guidance

</Tone_and_Style>`;
}

/**
 * Build the Kanban context section
 */
function buildKanbanContextSection(
    roleKey: string,
    kanbanContext: KanbanContext
): string {
    let section = `
## [KANBAN CONTEXT]

### Team Statistics
📊 Todo: ${kanbanContext.teamStats.todo} | In Progress: ${kanbanContext.teamStats.inProgress} | Review: ${kanbanContext.teamStats.review} | Done: ${kanbanContext.teamStats.done}${kanbanContext.teamStats.blocked > 0 ? ` | ⚠️ Blocked: ${kanbanContext.teamStats.blocked}` : ''}

`;

    // My Tasks Section
    if (kanbanContext.myTasks.length > 0) {
        section += `### [MY TASKS - ${kanbanContext.myTasks.length} items] ✅ VALID TASK SOURCE
These tasks are assigned to you. Work on these:

`;
        kanbanContext.myTasks.forEach((task, i) => {
            const priorityBadge = formatPriorityBadge(task.priority);
            const statusBadge = formatStatusBadge(task.status);
            section += `${i + 1}. ${statusBadge} ${priorityBadge} **[${task.status.toUpperCase()}]** ${task.title}
   ID: \`${task.id}\`
`;
            const activeBlockers = task.blockers?.filter(b => !b.resolvedAt) || [];
            if (activeBlockers.length > 0) {
                section += `   ⚠️ BLOCKED: ${activeBlockers[0].description}
`;
            }
            if (task.subtaskIds && task.subtaskIds.length > 0) {
                section += `   📦 ${task.subtaskIds.length} subtask(s)
`;
            }
        });
    } else {
        section += `### [MY TASKS] ⏳ EMPTY
No tasks currently assigned to you.
**ACTION**: ${COORDINATION_ROLES.includes(roleKey)
            ? 'WAIT for user instructions. DO NOT read files to find work.'
            : 'Announce yourself via send_team_message, then WAIT for assignment.'}

`;
    }

    // Available Tasks Section (workers only)
    if (kanbanContext.availableTasks.length > 0 && !COORDINATION_ROLES.includes(roleKey)) {
        section += `### [AVAILABLE TASKS - ${kanbanContext.availableTasks.length} items]
Tasks you can claim (use 'update_task' to assign to yourself):

`;
        kanbanContext.availableTasks.slice(0, 5).forEach((task, i) => {
            const priorityBadge = formatPriorityBadge(task.priority);
            section += `${i + 1}. ${priorityBadge} ${task.title} (ID: \`${task.id}\`)
`;
        });
        if (kanbanContext.availableTasks.length > 5) {
            section += `... and ${kanbanContext.availableTasks.length - 5} more.\n`;
        }
    }

    // Pending Approvals (coordinators only)
    if (COORDINATION_ROLES.includes(roleKey) && kanbanContext.pendingApprovals && kanbanContext.pendingApprovals.length > 0) {
        section += `### [PENDING APPROVALS - ${kanbanContext.pendingApprovals.length} items] ⚠️ ACTION REQUIRED
Tasks awaiting your approval:

`;
        kanbanContext.pendingApprovals.forEach((task, i) => {
            const priorityBadge = formatPriorityBadge(task.priority);
            section += `${i + 1}. ${priorityBadge} ${task.title} (ID: \`${task.id}\`)
`;
        });
    }

    // Recent Activity
    if (kanbanContext.recentActivity && kanbanContext.recentActivity.length > 0) {
        section += `### [RECENT ACTIVITY]
`;
        kanbanContext.recentActivity.slice(0, 5).forEach((activity) => {
            section += `- ${activity}\n`;
        });
    }

    return section;
}

/**
 * Build the Next Step section
 */
function buildNextStepSection(roleKey: string, kanbanContext?: KanbanContext): string {
    const hasMyTasks = kanbanContext && kanbanContext.myTasks.length > 0;
    const hasAvailableTasks = kanbanContext && kanbanContext.availableTasks.length > 0;
    const hasPendingApprovals = kanbanContext && kanbanContext.pendingApprovals && kanbanContext.pendingApprovals.length > 0;
    const isCoordinator = COORDINATION_ROLES.includes(roleKey);

    let section = `## [NEXT STEP - IMMEDIATE ACTION]

`;

    if (isCoordinator) {
        if (hasPendingApprovals) {
            section += `⚠️ **PRIORITY**: Review ${kanbanContext!.pendingApprovals!.length} pending approval(s) first.

`;
        }
        if (hasMyTasks) {
            section += `📋 You have ${kanbanContext!.myTasks.length} active task(s). Manage and coordinate as needed.

**Action**: Review tasks, check team progress, resolve blockers.
`;
        } else {
            section += `⏳ **WAIT MODE**: No tasks in Kanban.

**Action**: Wait for user to provide instructions. DO NOT:
- Read local files to "discover" work
- Create tasks without user request
- Start any implementation

**When user gives instruction**: Create tasks via 'create_task', assign to roles, announce via 'send_team_message'.
`;
        }
    } else if (IMPLEMENTATION_ROLES.includes(roleKey)) {
        if (hasMyTasks) {
            const inProgress = kanbanContext!.myTasks.filter(t => t.status === 'in-progress');
            if (inProgress.length > 0) {
                section += `🔄 **CONTINUE**: ${inProgress.length} task(s) in progress.

**Action**: Continue working on in-progress task. When done, update_task → done.
`;
            } else {
                section += `📋 **START**: Pick a task from [MY TASKS].

**Action**:
1. Select highest priority task
2. Call update_task to set status 'in_progress'
3. Execute the task
4. Call update_task to set status 'done'
`;
            }
        } else if (hasAvailableTasks) {
            section += `📋 **CLAIM**: No assigned tasks, but ${kanbanContext!.availableTasks.length} available.

**Action**: Claim a task from [AVAILABLE TASKS] via 'update_task'.
`;
        } else {
            section += `⏳ **WAIT MODE**: No tasks available.

**Action**:
1. Send message: "🟢 [${roleKey.toUpperCase()}] Online and ready for tasks"
2. WAIT for Master to assign work
3. DO NOT search files for work
`;
        }
    } else if (REVIEW_ROLES.includes(roleKey)) {
        if (hasMyTasks) {
            section += `👀 **REVIEW**: ${kanbanContext!.myTasks.length} task(s) to review.

**Action**: Review assigned items, provide feedback via 'send_team_message'.
`;
        } else {
            section += `⏳ **WAIT MODE**: No review tasks.

**Action**: Announce yourself, wait for items to be submitted for review.
`;
        }
    } else {
        // Default for other roles
        if (hasMyTasks) {
            section += `📋 **WORK**: ${kanbanContext!.myTasks.length} task(s) assigned.

**Action**: Work on assigned tasks.
`;
        } else {
            section += `⏳ **WAIT MODE**: No tasks assigned.

**Action**: Announce yourself, wait for assignment.
`;
        }
    }

    return section;
}

/**
 * Generate a role-aware prompt with optional Kanban context injection
 * Following OhMyOpenCode / Sisyphus prompt architecture pattern
 *
 * Structure:
 * 1. <Role> - Identity and competencies
 * 2. <Behavior_Instructions> - Phase-based workflow
 * 3. <Task_Management> - Task source hierarchy and workflow
 * 4. <Constraints> - Hard blocks and anti-patterns
 * 5. <Tone_and_Style> - Communication guidelines
 * 6. [KANBAN CONTEXT] - Current task state
 * 7. [NEXT STEP] - Immediate action guidance
 *
 * @param metadata - Session metadata containing teamId and role
 * @param kanbanContext - Optional Kanban context for task injection
 * @returns Formatted prompt string
 */
export function generateRolePrompt(
    metadata: Metadata,
    kanbanContext?: KanbanContext
): string {
    let teamId = metadata.teamId;
    let role = metadata.role;

    logger.debug(`[Roles] generateRolePrompt called - teamId: ${teamId}, role: ${role}`);

    // Recover from environment variables if metadata is missing
    if (!teamId && process.env.HAPPY_ROOM_ID) {
        teamId = process.env.HAPPY_ROOM_ID;
        logger.debug('[Roles] Recovered teamId from HAPPY_ROOM_ID');
    }
    if (!role && process.env.HAPPY_AGENT_ROLE) {
        role = process.env.HAPPY_AGENT_ROLE;
        logger.debug('[Roles] Recovered role from HAPPY_AGENT_ROLE');
    }

    if (!teamId || !role) {
        logger.warn('[Roles] Cannot generate role prompt - missing teamId or role');
        return '';
    }

    const roleKey = role;
    const roleDef = DEFAULT_ROLES[roleKey];

    if (!roleDef) {
        logger.warn(`[Roles] Unknown role: ${roleKey}`);
        return '';
    }

    const isCoordinator = COORDINATION_ROLES.includes(roleKey);

    // Build prompt sections
    const sections = [
        '',
        '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
        '                    [SYSTEM: TEAM AGENT CONTEXT]                   ',
        '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
        '',
        buildRoleSection(roleKey, roleDef, teamId),
        '',
        '<Behavior_Instructions>',
        '',
        buildPhase0Section(roleKey),
        '',
        '---',
        '',
        isCoordinator ? buildPhase1CoordinatorSection() : buildPhase1WorkerSection(),
        '',
        '</Behavior_Instructions>',
        '',
        buildTaskManagementSection(roleKey),
        '',
        buildConstraintsSection(roleKey),
        '',
        buildToneAndStyleSection(),
        '',
    ];

    // Add Kanban context if provided
    if (kanbanContext) {
        logger.debug(`[Roles] Injecting Kanban context: ${kanbanContext.myTasks.length} my tasks`);
        sections.push(buildKanbanContextSection(roleKey, kanbanContext));
    }

    // Add next step guidance
    sections.push(buildNextStepSection(roleKey, kanbanContext));

    sections.push('');
    sections.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    sections.push('                    [END TEAM AGENT CONTEXT]                      ');
    sections.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    sections.push('');

    return sections.join('\n');
}
