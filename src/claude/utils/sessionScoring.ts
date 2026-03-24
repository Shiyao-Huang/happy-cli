export interface SessionScore {
    taskCompletion: number;
    codeQuality: number;
    collaboration: number;
    overall: number;
}

function clampScore(value: number): number {
    if (!Number.isFinite(value)) return 0;
    return Math.max(0, Math.min(100, Math.round(value)));
}

export function computeSessionScoreFromDimensions(dimensions: {
    delivery: number;
    integrity: number;
    efficiency: number;
    collaboration: number;
    reliability: number;
}): SessionScore {
    const taskCompletion = clampScore(dimensions.delivery);
    const codeQuality = clampScore((dimensions.integrity + dimensions.reliability) / 2);
    const collaboration = clampScore(dimensions.collaboration);

    return {
        taskCompletion,
        codeQuality,
        collaboration,
        overall: clampScore((taskCompletion + codeQuality + collaboration) / 3),
    };
}

export function computeSessionScoreOverall(input: {
    taskCompletion: number;
    codeQuality: number;
    collaboration: number;
}): SessionScore {
    const taskCompletion = clampScore(input.taskCompletion);
    const codeQuality = clampScore(input.codeQuality);
    const collaboration = clampScore(input.collaboration);

    return {
        taskCompletion,
        codeQuality,
        collaboration,
        overall: clampScore((taskCompletion + codeQuality + collaboration) / 3),
    };
}

export function validateScoreGap(
    hardMetricsScore: number | null | undefined,
    overallScore: number,
    maxGap: number = 20
): { ok: boolean; gap: number; maxGap: number } {
    if (hardMetricsScore == null || !Number.isFinite(hardMetricsScore)) {
        return { ok: true, gap: 0, maxGap };
    }

    const gap = Math.abs(Math.round(hardMetricsScore) - Math.round(overallScore));
    return {
        ok: gap <= maxGap,
        gap,
        maxGap,
    };
}
