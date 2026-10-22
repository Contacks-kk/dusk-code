import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { SkillActivationResult } from "./types";
import { skillRegistry } from "./registry";
import { parseSkillMarkdown } from "./parser";

export class SkillActivator {
    /** 激活并加载指定技能的主指令正文与配套文档目录 */
    public async activate(skillName: string): Promise<SkillActivationResult> {
        const skill = await skillRegistry.get(skillName);
        if (!skill) {
            return {
                success: false,
                name: skillName,
                description: "",
                content: "",
                references: [],
                error: `未找到名称为 "${skillName}" 的技能，请检查名称是否正确。`
            };
        }

        try {
            // 读取 SKILL.md 的实际内容
            const mdPath = skill.skillMdPath || path.join(skill.skillDir, "SKILL.md");
            const rawContent = await fs.readFile(mdPath, "utf-8");
            const { content } = parseSkillMarkdown(rawContent, skill.name);

            return {
                success: true,
                name: skill.name,
                description: skill.metadata.description,
                content,
                references: skill.references.map((r) => ({
                    name: r.name,
                    path: r.relativePath
                }))
            };
        } catch (err: any) {
            return {
                success: false,
                name: skill.name,
                description: skill.metadata.description,
                content: "",
                references: [],
                error: `读取技能 "${skillName}" 失败: ${err?.message || String(err)}`
            };
        }
    }

    /** 读取指定技能配套的细分参考手册或文档全文 */
    public async readReference(skillName: string, referenceName: string): Promise<string> {
        const skill = await skillRegistry.get(skillName);
        if (!skill) {
            return `错误: 未找到技能 "${skillName}"。`;
        }

        const cleanRefName = path.basename(referenceName);
        const refItem = skill.references.find((r) => r.name.toLowerCase() === cleanRefName.toLowerCase());

        if (!refItem) {
            const available = skill.references.map((r) => r.name).join(", ");
            return `错误: 技能 "${skillName}" 不存在名为 "${referenceName}" 的参考文档。当前可用文档: [${available || "无"}]`;
        }

        try {
            // 读取参考文档内容
            const content = await fs.readFile(refItem.absolutePath, "utf-8");
            return content;
        } catch (err: any) {
            return `读取参考文档 "${referenceName}" 失败: ${err?.message || String(err)}`;
        }
    }
}

export const skillActivator = new SkillActivator();
