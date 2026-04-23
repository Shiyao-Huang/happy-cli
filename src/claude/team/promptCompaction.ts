const DEFAULT_NOTICE = '[truncated; use the live team tools for the full source]';

export function truncateForPrompt(
    input: string | null | undefined,
    maxChars: number,
    notice = DEFAULT_NOTICE,
): string {
    const text = input ?? '';
    if (maxChars <= 0 || text.length <= maxChars) {
        return text;
    }

    const marker = `\n\n${notice} original_chars=${text.length} kept_chars=${maxChars}\n\n`;
    if (marker.length >= maxChars) {
        return marker.slice(0, maxChars);
    }

    const remaining = maxChars - marker.length;
    const headLength = Math.ceil(remaining * 0.7);
    const tailLength = remaining - headLength;

    return `${text.slice(0, headLength)}${marker}${text.slice(text.length - tailLength)}`;
}

export function stringifyForPrompt(value: unknown, maxChars: number): string {
    let text: string;
    try {
        text = JSON.stringify(value, null, 2);
    } catch {
        text = String(value);
    }

    return truncateForPrompt(
        text,
        maxChars,
        '[team context truncated; call get_team_info/list_tasks/read_team_log for complete live state]',
    );
}
