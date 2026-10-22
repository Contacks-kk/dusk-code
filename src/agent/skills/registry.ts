import type { SkillItem } from "./types";
import { skillLoader } from "./loader";

export class SkillRegistry {
    private skills: Map<string, SkillItem> = new Map();
    private isInitialized = false;

    /** 初始化并加载各层级技能清单 */
    public async init(projectCwd: string = process.cwd()): Promise<void> {
        this.skills = await skillLoader.loadAllSkills(projectCwd);
        this.isInitialized = true;
    }

    /** 确保技能注册中心完成初始化 */
    private async ensureInitialized(): Promise<void> {
        if (!this.isInitialized) {
            await this.init();
        }
    }

    /** 重新扫描并热重载所有技能 */
    public async reload(projectCwd: string = process.cwd()): Promise<number> {
        this.skills = await skillLoader.loadAllSkills(projectCwd);
        this.isInitialized = true;
        return this.skills.size;
    }

    /** 获取所有已登记的技能列表 */
    public async getAll(): Promise<SkillItem[]> {
        await this.ensureInitialized();
        return Array.from(this.skills.values());
    }

    /** 同步获取所有已加载技能列表（若未初始化则为空） */
    public getAllSync(): SkillItem[] {
        return Array.from(this.skills.values());
    }

    /** 根据技能名称获取技能信息 */
    public async get(name: string): Promise<SkillItem | undefined> {
        await this.ensureInitialized();
        const normalized = name.trim().toLowerCase();
        return this.skills.get(normalized) || Array.from(this.skills.values()).find((s) => s.name.toLowerCase() === normalized);
    }

    /** 根据关键词模糊搜索匹配的技能 */
    public async search(query: string): Promise<SkillItem[]> {
        await this.ensureInitialized();
        const trimmed = query.trim().toLowerCase();
        if (!trimmed) {
            return this.getAll();
        }

        return Array.from(this.skills.values()).filter((s) => {
            const inName = s.name.toLowerCase().includes(trimmed);
            const inDesc = s.metadata.description.toLowerCase().includes(trimmed);
            const inTags = s.metadata.tags?.some((t) => t.toLowerCase().includes(trimmed));
            return inName || inDesc || inTags;
        });
    }

    /** 生成注入 Agent System Prompt 的轻量技能索引目录 */
    public generatePromptCatalog(): string {
        const list = this.getAllSync();
        if (list.length === 0) {
            return "";
        }

        const lines = [
            "<skills>",
            "当且仅当用户的任务需求与某个专业技能高度相关时，你必须先调用 `activate_skill` 工具激活并阅读该技能的执行流程，再开展后续工作。",
            "可用技能清单："
        ];

        for (const item of list) {
            const cleanDesc = item.metadata.description.replace(/[\r\n]+/g, " ").trim();
            lines.push(`- **${item.name}**: ${cleanDesc}`);
        }

        lines.push("</skills>");
        return lines.join("\n");
    }
}

export const skillRegistry = new SkillRegistry();
