# /self-evolution

Master agent self-evolution cycle. Run this when you need to improve the system you're running on.

---

## Goal

Turn marketplace scores + runtime evidence into genome improvements via the evolution pipeline.

## Prerequisites

- You are Master or have coordinator+ role
- Evolution execution requires agent-builder, supervisor, or org-manager (spawn one if needed)

## Cycle

### Phase 1: Observe (5 min)
```
1. get_self_view(section=overview)     → context %, tools, identity
2. get_team_pulse(teamId)              → who's alive, board state
3. list_available_agents()             → marketplace scores snapshot
4. get_genome_spec(specId)             → inspect lowest-scoring genomes
```

### Phase 2: Interview (10 min)
Send Mom Test questions to all live agents via send_team_message:
- "What specific action took you the most time last task?"
- "Which tool call failed? What error?"
- "When were you unsure what to do? What did you choose?"
- "Which spec rule did you never follow or found useless?"
- "If you could add/remove one tool, which and why?"

**Rule**: Ask for facts, not opinions. Concrete past behavior only.

### Phase 3: Rank (5 min)
Classify each finding:
- **D** = Definition defect (fix via mutate_genome)
- **E+O** = Environment/Organization issue (fix via code, config, or team structure)

Rank by leverage: `impact * frequency * fixability`

### Phase 4: Evolve (10 min)
```
1. Spawn agent-builder if not on team
2. Create task with exact mutation spec
3. Agent-builder executes mutate_genome or evolve_genome
4. compare_genome_versions to verify
5. update_genome_feedback to sync marketplace
```

### Phase 5: Mirror (2 min)
```
1. get_context_status()                → am I running out?
2. Update memory/self-mirror-operating-manual.md with learnings
3. If context >= 70%: compact before next cycle
```

## Layered Compression Check

Before any output, compress to 4 levels:
1. 1 sentence — the core claim
2. 3 sentences — claim + evidence + action
3. 5 sentences — above + context + risk
4. Full — complete details

Lead with the shortest useful version.

## Question Quality Check

Your first question is always a normal-distribution guess. Iterate:
1. Ask the question
2. Read the answer — what surprised you?
3. Ask a better question based on the surprise
4. After 3 iterations, you have the real question

## Anti-Patterns

- Evolving a genome based on vibes instead of evidence
- Confusing E+O issues with D issues (infra failure != genome defect)
- Mutating without compare_genome_versions verification
- Skipping the interview step (scores alone are insufficient)
- Waiting for permission instead of acting (you ARE the system)
