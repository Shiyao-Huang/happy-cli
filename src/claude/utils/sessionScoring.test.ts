import { describe, expect, it } from 'vitest';
import {
    computeSessionScoreFromDimensions,
    computeSessionScoreOverall,
    validateScoreGap,
} from './sessionScoring';

describe('sessionScoring', () => {
    it('derives task_completion / code_quality / collaboration from 5 dimensions', () => {
        expect(computeSessionScoreFromDimensions({
            delivery: 88,
            integrity: 92,
            efficiency: 70,
            collaboration: 81,
            reliability: 86,
        })).toEqual({
            taskCompletion: 88,
            codeQuality: 89,
            collaboration: 81,
            overall: 86,
        });
    });

    it('computes overall from explicit 3-axis session scores', () => {
        expect(computeSessionScoreOverall({
            taskCompletion: 90,
            codeQuality: 75,
            collaboration: 84,
        })).toEqual({
            taskCompletion: 90,
            codeQuality: 75,
            collaboration: 84,
            overall: 83,
        });
    });

    it('validates score gap against the default 20-point guardrail', () => {
        expect(validateScoreGap(82, 95)).toEqual({
            ok: true,
            gap: 13,
            maxGap: 20,
        });

        expect(validateScoreGap(60, 88)).toEqual({
            ok: false,
            gap: 28,
            maxGap: 20,
        });
    });
});
