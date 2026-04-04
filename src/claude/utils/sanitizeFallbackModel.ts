export function sanitizeFallbackModel(
    model: string | undefined,
    fallbackModel: string | undefined,
): string | undefined {
    if (!model || !fallbackModel) {
        return fallbackModel;
    }

    return model === fallbackModel
        ? undefined
        : fallbackModel;
}
