# /self-evolve

Run a complete self-evolution cycle: observe your own behavior, analyze gaps against your genome spec, and — if warranted — trigger a genome evolution.

**Requires**: `genome.evolve` authority in your genome spec, team member record, or team overlay.

---

## Prerequisites

Before starting, verify you have access to the evolution pipeline:

```
get_effective_permissions()
```

Check that `genome.evolve` is listed in your authorities, or that your role is `supervisor`. If neither is true, this workflow will be blocked at the evolution step.

---

## Workflow

### Phase 1 — Self-Assessment (gather evidence)

1. **Snapshot your identity and context:**
   ```
   get_self_view()
   get_context_status()
   ```

2. **Review your recent behavior (CC log):**
   ```
   read_cc_log(sessionId=<your_session_id>, limit=50)
   ```

3. **Check your genome spec:**
   ```
   get_genome_spec(specId=<your_spec_id>)
   ```
   Note the `responsibilities`, `protocol`, `evalCriteria`, `memory.learnings`, and `authorities` fields.

### Phase 2 — Reflexivity Check (optional but recommended)

4. **List available reflexivity cases:**
   ```
   reflexivity_list_cases()
   ```

5. **Build a fixture from your current state:**
   ```
   reflexivity_build_fixture()
   ```

6. **Answer each prompt yourself**, then score your answers:
   ```
   reflexivity_score_case(caseId=<id>, fixture=<fixture_json_from_step_5>, responses=[...])
   ```
   Note: `fixture` is the full JSON object from `reflexivity_build_fixture`, not an ID.
   `responses` is an array of structured turn answers, one per prompt.
   This reveals blind spots in your self-awareness. Focus on cases where you score below `passThreshold`.

### Phase 3 — Mirror Analysis (identify evolution gaps)

7. **Score yourself** (if no recent scores exist):
   ```
   score_agent(
     teamId=<your_team_id>,
     sessionId=<your_session_id>,
     role=<your_role>,
     action="keep",
     rationale="Self-assessment based on reflexivity results and task performance",
     scores={ delivery: <0-10>, integrity: <0-10>, efficiency: <0-10>, collaboration: <0-10>, reliability: <0-10> }
   )
   ```

8. **Aggregate feedback into your genome:**
   ```
   update_genome_feedback(
     genomeNamespace="@official",
     genomeName=<your_genome_name>,
     role=<your_role>
   )
   ```
   This collects all scores for your genome and prepares feedbackData for evolution.

9. **Gather your scoring history** from the feedback aggregation output.
   Note the `avgScore`, `dimensions`, and `evaluationCount` values.

10. **Run mirror analysis:**
   ```
   mirror_analyze(
     sessionId=<your_session_id>,
     genomeNamespace="@official",
     genomeName=<your_genome_name>,
     genomeVersion=<current_version>,
     avgScore=<your_avg_score>,
     dimensions={ delivery, integrity, efficiency, collaboration, reliability },
     latestAction=<latest_feedback_action>,
     suggestions=[...],
     evaluationCount=<count>,
     existingLearnings=[...]
   )
   ```
   Read the output carefully:
   - `shouldEvolve` — whether the analysis recommends evolution
   - `observations` — specific gaps between spec and behavior
   - `proposedLearnings` — new learnings to merge
   - `safetyCheck.blocked` — if true, evolution is blocked for safety

11. **Check convergence** (if you have prior evolution history):
   ```
   mirror_check_convergence(
     scoreHistory=[...],
     currentDepth=<iteration>,
     maxDepth=3
   )
   ```
   If `converged: true`, stop iterating.

### Phase 4 — Decide

12. **Evaluate the evidence:**
    - If `shouldEvolve: false` or `safetyCheck.blocked: true` or `converged: true` — **STOP**. Report findings but do not evolve.
    - If `shouldEvolve: true` — proceed to Phase 5.

### Phase 5 — Evolve (requires authority)

13. **Trigger genome evolution:**
    ```
    evolve_genome(
      genomeNamespace="@official",
      genomeName=<your_genome_name>,
      newLearnings=[...from_mirror_analysis...],
      minPromoteScore=60,
      dryRun=true
    )
    ```
    **Always start with `dryRun: true`** to preview the merged spec before committing.

14. **Review the dry-run output.** If the merged spec looks correct, run again with `dryRun: false`.

### Phase 6 — Verify

15. **Compare versions to confirm improvement:**
    ```
    compare_genome_versions(
      genomeNamespace="@official",
      genomeName=<your_genome_name>
    )
    ```
    Check the recommendation: `keep_newer`, `rollback_older`, or `insufficient_data`.

16. **Generate a report:**
    ```
    mirror_format_report(
      analysis={ observations, proposedLearnings, summary, shouldEvolve },
      convergence={ depth, maxDepth, scoreHistory, converged },
      dryRun=false
    )
    ```

17. **Share the report with your team:**
    ```
    send_team_message(content=<report>, type="task-update")
    ```

---

## Safety Rules

- **Never skip the dry-run step.** Always preview before committing.
- **Respect convergence.** If `mirror_check_convergence` says converged, do not evolve further.
- **Respect safety blocks.** If `safetyCheck.blocked: true`, do not attempt to evolve.
- **One evolution per cycle.** Do not chain multiple evolutions without re-assessing.
- **Report outcomes.** Always share results with your team, whether you evolved or not.

---

## When to Use

- After receiving low scores from supervisor evaluation
- When team feedback suggests behavioral gaps
- During scheduled self-improvement cycles
- When you notice repeated failures in a specific area
- After a context compaction, as a fresh-start calibration

## When NOT to Use

- In the middle of an active task (finish your work first)
- When context usage is above 70% (compact first, then self-evolve)
- Without `genome.evolve` authority (request it from your supervisor)
- When the last evolution was recent and scores haven't changed
