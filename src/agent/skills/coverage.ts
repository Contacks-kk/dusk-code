import type { SkillItem, SkillSelection } from "./types";

export interface SkillRequirements {
    outputs: string[];
}

/** 根据能力标签及描述识别技能适用产出，不依赖安装名称 */
export function skillCapabilities(item: SkillItem): string[] {
    const capabilities = new Set((item.metadata.tags ?? []).map(tag => tag.trim().toLowerCase()));
    const description = item.description.toLowerCase();
    if (/coding|programming|代码开发|代码实现|写代码|编程/.test(description)) {
        capabilities.add("coding");
    }
    if (capabilities.has("coding")) {
        capabilities.add("api");
        capabilities.add("cli");
    }
    if (/app screens|dashboard|admin|inbox|应用界面|后台界面/.test(description) && /design|设计|frontend/.test(description)) {
        capabilities.add("ui-app");
    }
    if (/landing page|portfolio|marketing|落地页|展示页面/.test(description) && /design|设计|frontend/.test(description)) {
        capabilities.add("ui-page");
    }
    if (/look-and-fix|screenshot|visual.*review|视觉.*评审/.test(description)) {
        capabilities.add("visual-review");
    }
    return [...capabilities];
}

/** 返回目录确有可用专业技能但选择结果遗漏的产出 */
export function missingSkillCoverage(selection: SkillSelection, catalog: SkillItem[], outputs: string[], disabled: string[], pinned: string[] = []): string[] {
    const selected = new Set([...selection.skills.map(item => item.name.toLowerCase()), ...pinned]);
    return outputs.filter(output => ["coding", "ui-app", "ui-page", "visual-review", "api", "cli"].includes(output) &&
        catalog.some(item => !disabled.includes(item.name.toLowerCase()) && skillCapabilities(item).includes(output)) &&
        !catalog.some(item => selected.has(item.name.toLowerCase()) && skillCapabilities(item).includes(output)));
}

/** 对仍遗漏的专业产出按能力覆盖及来源稳定补选 */
export function supplementSkillCoverage(selection: SkillSelection, catalog: SkillItem[], outputs: string[], disabled: string[], pinned: string[] = []): SkillSelection {
    const result = { ...selection, skills: [...selection.skills] };
    const missing = missingSkillCoverage(result, catalog, outputs, disabled, pinned);
    const priority = {
        project: 0,
        user: 1,
        builtin: 2
    };
    const candidates = catalog.filter(item => !disabled.includes(item.name.toLowerCase())).sort((left, right) =>
        missing.filter(output => skillCapabilities(right).includes(output)).length - missing.filter(output => skillCapabilities(left).includes(output)).length ||
        priority[left.source] - priority[right.source] || left.name.localeCompare(right.name));
    for (const output of missing) {
        if (!missingSkillCoverage(result, catalog, [output], disabled, pinned).length) {
            continue;
        }
        const candidate = candidates.find(item => skillCapabilities(item).includes(output));
        if (candidate && !result.skills.some(item => item.name === candidate.name)) {
            result.skills.push({ name: candidate.name, reason: `任务产出 ${output} 的覆盖补选` });
        }
    }
    result.needsVisualVerification ||= outputs.some(output => output === "ui-app" || output === "ui-page");
    result.coverage = outputs.map(output => {
        const names = new Set([...result.skills.map(item => item.name.toLowerCase()), ...pinned]);
        const skills = catalog.filter(item => names.has(item.name.toLowerCase()) && !disabled.includes(item.name.toLowerCase()) && skillCapabilities(item).includes(output)).map(item => item.name);
        return {
            output,
            skills,
            reason: skills.length ? undefined : "未发现适用且已启用的专业技能，主任务继续，验收要求仍然保留"
        };
    });
    return result;
}
