/** 判断候选回复是否仍在等待确认方案，供运行时和终端共用 */
export function isAwaitingPlanConfirmation(reply: string): boolean {
    return [
        "请问是否确认执行",
        "是否确认执行",
        "确认执行该修改",
        "是否同意执行",
        "请确认是否执行",
        "是否确认开始执行",
        "请确认是否开始修改",
        "是否确认继续"
    ].some(keyword => reply.includes(keyword));
}

/** 对用户明确要求的分析和规划保留只读边界，模型分类不能扩大授权 */
export function explicitReadOnlyTask(input: string): "plan" | "explain" | undefined {
    const text = input.trim();
    if (text.startsWith("【PLANNING")) {
        return "plan";
    }
    if (/(?:[，,；;]|并|然后|同时|之后|再).{0,6}(?:修复|修改|实现|执行|实施)|\band\s+(?:fix|implement|build)\b/i.test(text)) {
        return undefined;
    }
    if (/^(?:请|帮我|先)?(?:设计|制定|拟定).{0,20}(?:计划|方案)/.test(text)) {
        return "plan";
    }
    if (/^(?:请|帮我|先)?(?:只|仅)?(?:解释|讲解|分析|阅读|梳理|评审)|^(?:please\s+)?(?:explain|review|analyze)\b/i.test(text)) {
        return "explain";
    }
    return /^(?:please\s+)?plan\b/i.test(text) ? "plan" : undefined;
}
