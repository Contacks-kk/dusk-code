import type { AgentMessage, AgentTool } from "@mariozechner/pi-agent-core";
import { estimateTokenCount, messageTokens } from "./token";
export { messageTokens } from "./token";

/** 按完整历史轮次裁剪上下文并为本轮输入预留空间 */
export function fitHistory(history: AgentMessage[], promptTokens: number, systemPrompt: string,
    tools: AgentTool<any>[], contextWindow: number, outputBudget: number): AgentMessage[] {
    const toolTokens = estimateTokenCount(JSON.stringify(tools.map(({ name, description, parameters }) => ({ name, description, parameters }))));
    const available = contextWindow - outputBudget - 2048 - promptTokens - estimateTokenCount(systemPrompt) - toolTokens - 12;
    if (available < 0) {
        throw new Error("上下文不足：本轮输入、工具定义和输出预算无法同时放入模型窗口");
    }
    const groups: AgentMessage[][] = [];
    for (const message of history) {
        if (message.role === "user" || groups.length === 0) {
            groups.push([]);
        }
        groups[groups.length - 1].push(message);
    }
    /** 估算当前保留轮次的总用量 */
    const tokens = () => groups.reduce((total, group) => total + group.reduce((sum, message) => sum + messageTokens(message), 0), 0);
    while (groups.length > 0 && tokens() > available) {
        groups.shift();
    }
    return groups.flat();
}
