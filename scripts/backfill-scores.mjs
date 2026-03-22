#!/usr/bin/env node

/**
 * backfill-scores.mjs — Push historical agent scores to genome-hub feedbackData
 *
 * Reads ~/.aha/scores/agent_scores.json, aggregates by target genome using
 * ROLE_TO_CANONICAL_GENOME mapping, and PATCHes to genome-hub.
 *
 * Usage: node aha-cli/scripts/backfill-scores.mjs [--dry-run] [--hub-url URL]
 *
 * Idempotent: safe to run multiple times (overwrites feedbackData each time).
 */

import { readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

// --- Configuration ---
const HUB_URL = process.argv.includes('--hub-url')
  ? process.argv[process.argv.indexOf('--hub-url') + 1]
  : 'http://localhost:3006';
const DRY_RUN = process.argv.includes('--dry-run');

// --- ROLE_TO_CANONICAL_GENOME (mirrors supervisorGenomeFeedback.ts) ---
const ROLE_TO_CANONICAL_GENOME = {
  'implementer': '@official/implementer',
  'builder': '@official/implementer',
  'framer': '@official/implementer',
  'master': '@official/master',
  'org-manager': '@official/org-manager',
  'supervisor': '@official/supervisor',
  'researcher': '@official/researcher',
  'scout': '@official/researcher',
  'qa-engineer': '@official/qa-engineer',
  'reviewer': '@official/qa-engineer',
  'architect': '@official/architect',
  'help-agent': '@official/help-agent',
  // Extended mappings for unmapped roles found in score data
  'solution-architect': '@official/architect',
};

// --- Load scores ---
const scoresPath = join(homedir(), '.aha', 'scores', 'agent_scores.json');
console.log(`Reading scores from: ${scoresPath}`);
const raw = JSON.parse(readFileSync(scoresPath, 'utf-8'));
const scores = raw.scores || [];
console.log(`Total scores: ${scores.length}`);

// --- Aggregate by target genome ---
const aggregated = {};
let mapped = 0;
let unmapped = 0;
const unmappedRoles = {};

for (const score of scores) {
  const role = score.role || '';
  const target = ROLE_TO_CANONICAL_GENOME[role];

  if (!target) {
    unmapped++;
    unmappedRoles[role] = (unmappedRoles[role] || 0) + 1;
    continue;
  }

  mapped++;
  if (!aggregated[target]) {
    aggregated[target] = {
      scores: [],
      dimensions: { delivery: [], integrity: [], efficiency: [], collaboration: [], reliability: [] }
    };
  }

  const agg = aggregated[target];
  agg.scores.push(score.overall || 0);

  if (score.dimensions) {
    for (const dim of ['delivery', 'integrity', 'efficiency', 'collaboration', 'reliability']) {
      if (score.dimensions[dim] !== undefined) {
        agg.dimensions[dim].push(score.dimensions[dim]);
      }
    }
  }
}

console.log(`Mapped: ${mapped}, Unmapped: ${unmapped}`);
if (Object.keys(unmappedRoles).length > 0) {
  console.log(`Unmapped roles:`, unmappedRoles);
}

// --- Build feedbackData payloads ---
function avg(arr) {
  return arr.length > 0 ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : 0;
}

function distribution(arr) {
  const dist = { excellent: 0, good: 0, fair: 0, poor: 0 };
  for (const v of arr) {
    if (v >= 85) dist.excellent++;
    else if (v >= 70) dist.good++;
    else if (v >= 50) dist.fair++;
    else dist.poor++;
  }
  return dist;
}

const payloads = {};
for (const [genome, data] of Object.entries(aggregated)) {
  if (data.scores.length < 1) continue; // Need at least 1 score

  payloads[genome] = {
    evaluationCount: data.scores.length,
    avgScore: avg(data.scores),
    sessionScore: {
      taskCompletion: avg(data.dimensions.delivery),
      codeQuality: avg(data.dimensions.integrity),
      collaboration: avg(data.dimensions.collaboration),
      overall: avg(data.scores),
    },
    dimensions: {
      delivery: avg(data.dimensions.delivery),
      integrity: avg(data.dimensions.integrity),
      efficiency: avg(data.dimensions.efficiency),
      collaboration: avg(data.dimensions.collaboration),
      reliability: avg(data.dimensions.reliability),
    },
    distribution: distribution(data.scores),
    latestAction: 'keep',
    suggestions: ['Backfilled from historical agent_scores.json'],
  };
}

console.log(`\n--- Payloads to upload (${Object.keys(payloads).length} genomes) ---`);
for (const [genome, payload] of Object.entries(payloads)) {
  console.log(`  ${genome}: ${payload.evaluationCount} evals, avg=${payload.avgScore}`);
}

// --- Upload to genome-hub ---
if (DRY_RUN) {
  console.log('\n[DRY RUN] Skipping upload. Run without --dry-run to push.');
  process.exit(0);
}

console.log(`\n--- Uploading to ${HUB_URL} ---`);
let success = 0;
let failed = 0;

for (const [genome, payload] of Object.entries(payloads)) {
  const [ns, name] = genome.split('/');
  const url = `${HUB_URL}/genomes/${ns}/${name}/feedback`;

  try {
    const res = await fetch(url, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (res.ok) {
      console.log(`  OK ${genome}: ${res.status}`);
      success++;
    } else {
      const body = await res.text();
      console.error(`  FAIL ${genome}: ${res.status} ${body.slice(0, 200)}`);
      failed++;
    }
  } catch (err) {
    console.error(`  ERROR ${genome}: ${err.message}`);
    failed++;
  }
}

console.log(`\n--- Done: ${success} uploaded, ${failed} failed ---`);
process.exit(failed > 0 ? 1 : 0);
