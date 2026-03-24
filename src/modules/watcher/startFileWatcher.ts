import { logger } from "@/ui/logger";
import { delay } from "@/utils/time";
import { watch } from "fs/promises";
import { basename, dirname } from "path";

export function startFileWatcher(file: string, onFileChange: (file: string) => void) {
    const abortController = new AbortController();
    const watchedDir = dirname(file);
    const watchedName = basename(file);

    void (async () => {
        while (true) {
            try {
                logger.debug(`[FILE_WATCHER] Starting watcher for ${file} via parent dir ${watchedDir}`);
                const watcher = watch(watchedDir, { persistent: true, signal: abortController.signal });
                for await (const event of watcher) {
                    if (abortController.signal.aborted) {
                        return;
                    }
                    if (event.filename && event.filename !== watchedName) {
                        continue;
                    }
                    logger.debug(`[FILE_WATCHER] File changed: ${file}`);
                    onFileChange(file);
                }
            } catch (e: any) {
                if (abortController.signal.aborted) {
                    return;
                }
                logger.debug(`[FILE_WATCHER] Watch error: ${e.message}, restarting watcher in a second`);
                await delay(1000);
            }
        }
    })();

    return () => {
        abortController.abort();
    };
}
