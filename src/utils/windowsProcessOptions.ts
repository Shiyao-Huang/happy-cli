export function withWindowsHide<T extends object>(options: T): T & { windowsHide?: boolean } {
    const typedOptions = options as T & { windowsHide?: boolean };

    if (process.platform !== 'win32' || typedOptions.windowsHide !== undefined) {
        return options as T & { windowsHide?: boolean };
    }

    return {
        ...options,
        windowsHide: true,
    } as T & { windowsHide?: boolean };
}
