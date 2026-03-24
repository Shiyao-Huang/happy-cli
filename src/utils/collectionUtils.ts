/**
 * O(1) 查找性能的去重集合
 *
 * 用于替代 Array.some() / Array.find() 等 O(n) 操作
 *
 * @example
 * const messageLookup = new FastLookupSet(messages, m => m.id);
 * if (!messageLookup.has(newMessage)) {
 *     messages.push(newMessage);
 *     messageLookup.add(newMessage);
 * }
 */
export class FastLookupSet<T> {
    private set = new Set<string>();

    /**
     * 创建查找集合
     * @param items 初始项目数组
     * @param keyFn 键提取函数
     */
    constructor(items: T[], keyFn: (item: T) => string) {
        items.forEach(item => {
            const key = keyFn(item);
            this.set.add(key);
        });
    }

    /**
     * 检查项目是否存在于集合中
     * @param item 要检查的项目
     * @returns true 如果存在，false 否则
     */
    has(item: T): boolean {
        const key = this.getKey(item);
        return this.set.has(key);
    }

    /**
     * 添加项目到集合
     * @param item 要添加的项目
     */
    add(item: T): void {
        const key = this.getKey(item);
        this.set.add(key);
    }

    /**
     * 从集合中删除项目
     * @param item 要删除的项目
     * @returns true 如果删除成功，false 如果不存在
     */
    delete(item: T): boolean {
        const key = this.getKey(item);
        return this.set.delete(key);
    }

    /**
     * 获取集合大小
     */
    get size(): number {
        return this.set.size;
    }

    /**
     * 清空集合
     */
    clear(): void {
        this.set.clear();
    }

    /**
     * 提取项目的键
     */
    private getKey(item: T): string {
        if (typeof item === 'string') {
            return item;
        }
        if (typeof item === 'object' && item !== null) {
            // 尝试提取 id 字段
            if ('id' in item && typeof item.id === 'string') {
                return item.id;
            }
        }
        // 回退到 JSON 字符串化
        return JSON.stringify(item);
    }
}

/**
 * 创建去重数组辅助函数
 *
 * @param items 原始数组（可能包含重复）
 * @param keyFn 键提取函数
 * @returns 去重后的数组
 *
 * @example
 * const uniqueMessages = uniqueBy(messages, m => m.id);
 */
export function uniqueBy<T>(items: T[], keyFn: (item: T) => string): T[] {
    const seen = new Set<string>();
    const result: T[] = [];

    for (const item of items) {
        const key = keyFn(item);
        if (!seen.has(key)) {
            seen.add(key);
            result.push(item);
        }
    }

    return result;
}
