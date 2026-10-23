import type { SessionSkillState, SkillExecutionRecord } from "./types";

/** 校验会话技能设置并兼容旧会话 */
export function normalizeSkillState(value: unknown): SessionSkillState {
    const state = value !== null && typeof value === "object" ? value : {};

    /** 清理重复和无效的技能名称 */
    const names = (items: unknown): string[] => {
        if (!Array.isArray(items)) {
            return [];
        }
        return [...new Set(items.filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
            .map(item => item.trim().toLowerCase()))];
    };
    const disabled = names("disabled" in state ? state.disabled : undefined);
    return {
        pinned: names("pinned" in state ? state.pinned : undefined).filter(name => !disabled.includes(name)),
        disabled
    };
}

/** 收集当前执行记录中的技能降级与视觉缺口 */
export function skillWarnings(record: SkillExecutionRecord): string[] {
    const warnings: string[] = [];
    if (record.selection.status === "failed") {
        warnings.push(`自动选择技能失败：${record.selection.error}`);
    }
    warnings.push(...record.failures.map(item => `${item.name} 加载失败：${item.error}`));
    warnings.push(...record.snapshots.filter(hasMissingSkillDependencies)
        .map(item => `${item.name} 引用的技能未安装：${item.missingDependencies?.join("、")}`));
    const excluded = record.snapshots.filter(item => item.status === "budget_excluded");
    if (excluded.length) {
        warnings.push(`上下文不足，未加载：${excluded.map(item => item.name).join("、")}`);
    }
    if (record.needsVisualVerification && record.visual.status !== "feedback_received") {
        warnings.push(`视觉未验收：${record.visual.reason ?? "未取得最新截图的模型反馈"}`);
    }
    return warnings;
}

/** 判断已加载的技能是否缺少它明确引用的其他技能 */
export function hasMissingSkillDependencies(snapshot: SkillExecutionRecord["snapshots"][number]): boolean {
    return snapshot.status === "loaded" && Boolean(snapshot.missingDependencies?.length);
}

/** 判断历史展示中是否需要提示技能降级或未验收 */
export function hasSkillNotice(record: SkillExecutionRecord): boolean {
    return record.selection.status === "failed" || record.failures.length > 0 ||
        record.snapshots.some(item => item.status === "budget_excluded" || Boolean(item.missingDependencies?.length)) ||
        record.visual.status === "incomplete";
}

/** 按用户操作启用、关闭或清空会话技能 */
export function changeSkillState(value: unknown, action: "pin" | "off" | "clear", name = ""): SessionSkillState {
    const state = normalizeSkillState(value);
    const key = name.trim().toLowerCase();
    if (action === "clear") {
        return { pinned: [], disabled: [] };
    }
    if (!key) {
        throw new Error("技能名称不能为空");
    }
    return {
        pinned: action === "pin" ? [...state.pinned.filter(item => item !== key), key] : state.pinned.filter(item => item !== key),
        disabled: action === "off" ? [...state.disabled.filter(item => item !== key), key] : state.disabled.filter(item => item !== key)
    };
}
