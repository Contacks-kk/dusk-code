import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";
import type { SkillItem, SkillReference } from "./types";
import { parseSkillMarkdown } from "./parser";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export class SkillLoader {
    /** 检查路径是否存在并为目录 */
    private async isDirectory(targetPath: string): Promise<boolean> {
        try {
            const stat = await fs.stat(targetPath);
            return stat.isDirectory();
        } catch {
            return false;
        }
    }

    /** 扫描指定技能目录下的参考文档列表 */
    private async scanReferences(skillDir: string): Promise<SkillReference[]> {
        const refDir = path.join(skillDir, "references");
        if (!(await this.isDirectory(refDir))) {
            return [];
        }

        const references: SkillReference[] = [];
        try {
            const entries = await fs.readdir(refDir, { withFileTypes: true });
            for (const entry of entries) {
                if (entry.isFile()) {
                    const fullPath = path.join(refDir, entry.name);
                    const stat = await fs.stat(fullPath);
                    references.push({
                        name: entry.name,
                        relativePath: `references/${entry.name}`,
                        absolutePath: fullPath,
                        sizeBytes: stat.size
                    });
                }
            }
        } catch {
            // 忽略读取异常
        }

        return references;
    }

    /** 扫描指定技能目录下的配套脚本名称列表 */
    private async scanScripts(skillDir: string): Promise<string[]> {
        const scriptDir = path.join(skillDir, "scripts");
        if (!(await this.isDirectory(scriptDir))) {
            return [];
        }

        try {
            const entries = await fs.readdir(scriptDir, { withFileTypes: true });
            return entries.filter((e) => e.isFile()).map((e) => e.name);
        } catch {
            return [];
        }
    }

    /** 尝试从具体目录加载单个技能 */
    private async loadSingleSkill(
        skillDir: string,
        scope: "project" | "user" | "builtin"
    ): Promise<SkillItem | null> {
        const skillMdPath = path.join(skillDir, "SKILL.md");
        try {
            const rawContent = await fs.readFile(skillMdPath, "utf-8");
            const fallbackName = path.basename(skillDir);
            const { metadata } = parseSkillMarkdown(rawContent, fallbackName);

            // 扫描配套的 references 和 scripts
            const references = await this.scanReferences(skillDir);
            const scripts = await this.scanScripts(skillDir);

            return {
                name: metadata.name,
                description: metadata.description,
                metadata,
                skillDir,
                skillMdPath,
                path: skillDir,
                scope,
                source: scope,
                references,
                scripts
            };
        } catch {
            return null;
        }
    }

    /** 扫描指定根目录下的所有技能目录 */
    private async scanSkillRoot(
        rootDir: string,
        scope: "project" | "user" | "builtin"
    ): Promise<SkillItem[]> {
        if (!(await this.isDirectory(rootDir))) {
            return [];
        }

        const items: SkillItem[] = [];
        try {
            const entries = await fs.readdir(rootDir, { withFileTypes: true });
            for (const entry of entries) {
                if (entry.isDirectory()) {
                    const skillPath = path.join(rootDir, entry.name);
                    const item = await this.loadSingleSkill(skillPath, scope);
                    if (item) {
                        items.push(item);
                    }
                }
            }
        } catch {
            // 忽略根目录扫描异常
        }

        return items;
    }

    /** 多层级发现并加载所有可用技能，并按优先级去重覆盖 */
    public async loadAllSkills(projectCwd: string = process.cwd()): Promise<Map<string, SkillItem>> {
        const skillMap = new Map<string, SkillItem>();

        // 1. 系统核心内置技能根目录 (优先级最低，作为基础兜底)
        let builtinRoot = path.resolve(__dirname, "../../../skills");
        if (!(await this.isDirectory(builtinRoot))) {
            const cwdBuiltin = path.resolve(projectCwd, "skills");
            if (await this.isDirectory(cwdBuiltin)) {
                builtinRoot = cwdBuiltin;
            }
        }
        const builtinSkills = await this.scanSkillRoot(builtinRoot, "builtin");
        for (const s of builtinSkills) {
            skillMap.set(s.name, s);
        }

        // 2. 用户家目录全局技能 ~/.dusk/skills (次高优先级，覆盖同名内置技能)
        const userRoot = path.join(os.homedir(), ".dusk", "skills");
        const userSkills = await this.scanSkillRoot(userRoot, "user");
        for (const s of userSkills) {
            skillMap.set(s.name, s);
        }

        // 3. 项目工作区技能 <cwd>/.dusk/skills (最高优先级，覆盖同名全局/内置技能)
        const projectRoot = path.join(projectCwd, ".dusk", "skills");
        const projectSkills = await this.scanSkillRoot(projectRoot, "project");
        for (const s of projectSkills) {
            skillMap.set(s.name, s);
        }

        return skillMap;
    }
}

export const skillLoader = new SkillLoader();
