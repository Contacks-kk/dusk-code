/** 估算纯文本内容的 Token 消耗量 */
export function estimateTokenCount(text?: string | null): number {
    if (!text) {
        return 0;
    }

    // 检查是否为多模态 JSON 结构（包含图片路径）
    if (text.startsWith("{") && text.endsWith("}")) {
        try {
            const parsed = JSON.parse(text);
            if (parsed && typeof parsed.text === "string" && Array.isArray(parsed.imagePaths)) {
                return estimateTokenCount(parsed.text) + parsed.imagePaths.length * 1000;
            }
        } catch {
            // 普通字符串继续向下执行估算
        }
    }

    // 匹配 CJK 中文字符（中日韩统一表意文字）
    const cjkMatches = text.match(/[\u4e00-\u9fa5\u3040-\u30ff\uac00-\ud7af]/g);
    const cjkCount = cjkMatches ? cjkMatches.length : 0;

    // 剩余非 CJK 字符（英文字母、符号、空白等），约 3.5 到 4 个字符消耗 1 个 Token
    const nonCjkCount = Math.max(0, text.length - cjkCount);
    const nonCjkTokens = Math.ceil(nonCjkCount / 3.8);

    // CJK 单字通常占用约 0.65 到 0.7 个 Token，向上取整并预留基本开销
    const cjkTokens = Math.ceil(cjkCount * 0.7);

    return Math.max(1, cjkTokens + nonCjkTokens);
}

/** 估算单轮消息或整体会话的历史记录所占用的 Token 总量 */
export function estimateHistoryTokens(history: Array<{ turn: any; messages: any[] }>): number {
    let total = 0;

    for (const item of history) {
        // 每轮 turn 的基础包装协议开销（角色标记、边界等）约预留 4 个 token
        total += 4;
        for (const msg of item.messages) {
            total += 3; // 单条 message 协议头部开销
            total += estimateTokenCount(msg.content);
        }
    }

    return total;
}
