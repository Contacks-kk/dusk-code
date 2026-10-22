import type { AgentTool } from "@mariozechner/pi-agent-core";
import { currentTimeTool } from "./system/time.tool";
import { calculatorTool } from "./system/calc.tool";
import { listFilesTool } from "./code/list-files.tool";
import { readFileTool } from "./code/read-file.tool";
import { grepSearchTool } from "./code/grep-search.tool";
import { applyPatchTool } from "./code/apply-patch.tool";
import { writeFileTool } from "./code/write-file.tool";
import { executeCommandTool } from "./code/execute-command.tool";
import { gitStatusTool } from "./code/git-status.tool";
import { gitDiffTool } from "./code/git-diff.tool";
import { activateSkillTool, readSkillReferenceTool } from "./skill/skill.tool";

class ToolRegistry {
    private tools: Map<string, AgentTool<any>> = new Map();

    constructor() {
        // 系统通用工具
        this.register(currentTimeTool);
        this.register(calculatorTool);

        // Code Agent 核心 8 大工具
        this.register(listFilesTool);
        this.register(readFileTool);
        this.register(grepSearchTool);
        this.register(applyPatchTool);
        this.register(writeFileTool);
        this.register(executeCommandTool);
        this.register(gitStatusTool);
        this.register(gitDiffTool);

        // 核心技能按需激活与手册查阅工具
        this.register(activateSkillTool);
        this.register(readSkillReferenceTool);
    }

    /** 注册新工具到注册中心 */
    public register(tool: AgentTool<any>): void {
        this.tools.set(tool.name, tool);
    }

    /** 获取所有已注册的工具列表 */
    public getAll(): AgentTool<any>[] {
        return Array.from(this.tools.values());
    }

    /** 根据名称获取对应工具 */
    public get(name: string): AgentTool<any> | undefined {
        return this.tools.get(name);
    }
}

export const toolRegistry = new ToolRegistry();
