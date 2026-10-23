import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { SkillActivationFailure, SkillActivationResult, SkillActivationSuccess, SkillItem } from "./types";
import { skillRegistry, type SkillRegistry } from "./registry";
import { parseSkillMarkdown } from "./parser";

export class SkillActivator {
    /** 绑定本次任务使用的技能注册表 */
    constructor(private readonly registry: SkillRegistry = skillRegistry) {}

    /** 激活并加载指定技能的主指令正文与配套文档目录 */
    public async activate(skillName: string): Promise<SkillActivationResult> {
        const skill = await this.registry.get(skillName);
        if (!skill) {
            return this.activationFailure(skillName, "", `未找到名称为 "${skillName}" 的技能，请检查名称是否正确。`);
        }
        try {
            return await this.readSkill(skill);
        } catch (error) {
            return this.activationFailure(skill.name, skill.metadata.description,
                `读取技能 "${skillName}" 失败: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    /** 读取技能正文并补齐资源的绝对路径 */
    private async readSkill(skill: SkillItem): Promise<SkillActivationSuccess> {
        const mdPath = skill.skillMdPath || path.join(skill.skillDir, "SKILL.md");
        const rawContent = await fs.readFile(mdPath, "utf-8");
        const { content } = parseSkillMarkdown(rawContent, skill.name);
        return {
            success: true,
            name: skill.name,
            description: skill.metadata.description,
            content,
            skillDir: path.resolve(skill.skillDir),
            skillMdPath: path.resolve(mdPath),
            source: skill.source,
            scripts: skill.scripts.map(name => ({
                name,
                path: path.resolve(skill.skillDir, "scripts", name)
            })),
            references: skill.references.map(reference => ({
                name: reference.name,
                path: reference.relativePath,
                absolutePath: path.resolve(reference.absolutePath)
            }))
        };
    }

    /** 构造与既有调用方兼容的技能加载失败结果 */
    private activationFailure(name: string, description: string, error: string): SkillActivationFailure {
        return {
            success: false,
            name,
            description,
            content: "",
            references: [],
            error
        };
    }

    /** 读取指定技能配套的细分参考手册或文档全文 */
    public async readReference(skillName: string, referenceName: string): Promise<string> {
        const skill = await this.registry.get(skillName);
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
        } catch (error) {
            return `读取参考文档 "${referenceName}" 失败: ${error instanceof Error ? error.message : String(error)}`;
        }
    }
}

export const skillActivator = new SkillActivator();
