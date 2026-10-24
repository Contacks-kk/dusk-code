/** 判断未知工具数据是否为可读取字段的对象 */
export function isToolRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** 读取工具返回的原始内容块，逐块校验由消费方完成 */
export function readToolContent(result: unknown): unknown[] | undefined {
    if (isToolRecord(result) && Array.isArray(result.content)) {
        return result.content;
    }
    return undefined;
}

/** 读取工具返回的详情字段 */
export function readToolDetails(result: unknown): Record<string, unknown> | undefined {
    if (isToolRecord(result) && isToolRecord(result.details)) {
        return result.details;
    }
    return undefined;
}

/** 读取详情中的文本字段，避免将未知值当作路径或错误说明 */
export function toolText(value: unknown): string | undefined {
    return typeof value === "string" ? value : undefined;
}

/** 判断技能、图片与命令工具是否返回失败 */
export function isManagedToolFailure(name: string, result: unknown): boolean {
    if (!["activate_skill", "read_skill_reference", "read_image", "execute_command", "managed_process", "browser_action", "test_mail", "apply_patch", "write_file"].includes(name)) {
        return false;
    }
    const details = readToolDetails(result);
    if (["managed_process", "browser_action", "test_mail"].includes(name)) {
        return Boolean(details?.error || details?.timedOut || details?.aborted || details?.completed === false);
    }
    return Boolean(details?.success === false || details?.error || details?.timedOut || details?.aborted ||
        (name === "execute_command" && details?.exitCode !== undefined && details.exitCode !== 0));
}
