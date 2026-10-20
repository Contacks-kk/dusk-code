import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";

const calcParams = Type.Object({
    expression: Type.String({ description: "需要计算的数学算式，例如 '128 * 32' 或 '(45 + 15) / 3'" })
});

/** 安全计算算式结果 */
function safeEvaluate(expr: string): number {
    // 过滤只允许基础算术字符
    const sanitized = expr.replace(/\s+/g, "");
    if (!/^[0-9+\-*/().^%]+$/.test(sanitized)) {
        throw new Error("算式包含非法字符，仅支持数字和基础运算符号");
    }
    // 将 ^ 替换为 **
    const jsExpr = sanitized.replace(/\^/g, "**");
    // 使用 Function 并在受限上下文执行
    const result = new Function(`"use strict"; return (${jsExpr})`)();
    if (typeof result !== "number" || !Number.isFinite(result)) {
        throw new Error("计算结果不是有效数值");
    }
    return result;
}

/** 数学计算工具 */
export const calculatorTool: AgentTool<typeof calcParams> = {
    name: "calculator",
    label: "数学计算器",
    description: "计算给定的数学表达式。当遇到需要进行精确加减乘除、乘方等数值运算时调用此工具。",
    parameters: calcParams,
    /** 执行算式计算并返回结果 */
    execute: async (toolCallId, params) => {
        try {
            const val = safeEvaluate(params.expression);
            return {
                content: [{ type: "text", text: `计算算式 '${params.expression}' 的结果为: ${val}` }],
                details: { expression: params.expression, result: val }
            };
        } catch (error: any) {
            return {
                content: [{ type: "text", text: `计算出错: ${error.message}` }],
                details: { expression: params.expression, error: error.message }
            };
        }
    }
};
