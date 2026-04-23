export function serializeErrorForLog(error: unknown): Record<string, unknown> {
    if (error instanceof Error) {
        const base: Record<string, unknown> = {
            name: error.name,
            message: error.message,
            stack: error.stack,
        };

        const anyError = error as Error & { code?: unknown; cause?: unknown };
        if (anyError.code !== undefined) {
            base.code = anyError.code;
        }
        if (anyError.cause !== undefined) {
            base.cause = anyError.cause instanceof Error
                ? {
                    name: anyError.cause.name,
                    message: anyError.cause.message,
                    stack: anyError.cause.stack,
                }
                : anyError.cause;
        }
        return base;
    }

    if (error && typeof error === 'object') {
        const objectValue = error as Record<string, unknown>;
        return Object.keys(objectValue).length > 0
            ? objectValue
            : {
                type: Object.prototype.toString.call(error),
                constructorName: (error as { constructor?: { name?: string } }).constructor?.name,
                value: String(error),
            };
    }

    return {
        type: typeof error,
        value: String(error),
    };
}
