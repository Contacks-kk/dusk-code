import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { skillActivator } from "../../skills/activator";
import type { SkillRuntime } from "../../skills/runtime";

const activateSkillParams = Type.Object({
    skillName: Type.String({
        description: "要激活并阅读的专属技能名称，例如 'design-taste-frontend'、'code-review'、'bug-fix'、'codebase-reading'、'brainstorming'"
    })
});

/** 激活并加载专业领域技能工作流工具 */
export const activateSkillTool: AgentTool<typeof activateSkillParams> = {
    name: "activate_skill",
    label: "激活专属技能",
    description: "当用户任务与某个专业技能相关时，调用此工具按需加载并阅读该技能的完整指导工作流、原则与检查门禁。",
    parameters: activateSkillParams,
    /** 执行技能激活逻辑并返回完整的执行规范 */
    execute: async (toolCallId, params) => {
        // 调用激活器载入技能正文
        const result = await skillActivator.activate(params.skillName);

        if (result.success === false) {
            return {
                content: [
                    {
                        type: "text",
                        text: `激活技能失败: ${result.error}`
                    }
                ],
                details: {
                    skillName: params.skillName,
                    error: result.error
                }
            };
        }

        const refList = result.references.length > 0
            ? result.references.map((r) => `- \`${r.name}\``).join("\n")
            : "（无附属参考手册）";

        const outputText = `【已成功激活技能：${result.name}】
描述: ${result.description}

### 技能执行规范与工作流：
${result.content}

### 可用配套参考手册 (可通过 read_skill_reference 工具阅读)：
${refList}`;

        return {
            content: [
                {
                    type: "text",
                    text: outputText
                }
            ],
            details: {
                skillName: result.name,
                description: result.description,
                referenceCount: result.references.length
            }
        };
    }
};

const readSkillReferenceParams = Type.Object({
    skillName: Type.String({
        description: "技能名称，例如 'code-review'、'design-taste-frontend'、'codebase-reading'"
    }),
    referenceName: Type.String({
        description: "参考手册文件名，例如 'coding_standards.md'、'methodology.md'、'layout.md'"
    })
});

/** 读取指定技能附属参考文档工具 */
export const readSkillReferenceTool: AgentTool<typeof readSkillReferenceParams> = {
    name: "read_skill_reference",
    label: "阅读技能参考手册",
    description: "查阅已激活技能所配套的专业参考手册（如多语言编码标准、UI美学规则、代码阅读方法论等）。",
    parameters: readSkillReferenceParams,
    /** 执行参考手册读取并返回文档内容 */
    execute: async (toolCallId, params) => {
        // 调用激活器读取具体手册
        const content = await skillActivator.readReference(params.skillName, params.referenceName);

        return {
            content: [
                {
                    type: "text",
                    text: content
                }
            ],
            details: {
                skillName: params.skillName,
                referenceName: params.referenceName,
                contentLength: content.length
            }
        };
    }
};

/** 加载技能快照并将正文加入后续请求的运行时指令 */
async function activateRuntimeSkill(runtime: SkillRuntime, skillName: string, signal?: AbortSignal): Promise<AgentToolResult<unknown>> {
    signal?.throwIfAborted();
    try {
        const snapshot = await runtime.load(skillName, "tool", "主模型在执行阶段补充");
        signal?.throwIfAborted();
        return {
            content: [{ type: "text", text: `技能 ${snapshot.name} 已加载到后续请求的当前技能指令中。根目录：${snapshot.skillDir}\n参考资料：${JSON.stringify(snapshot.references)}\n脚本：${JSON.stringify(snapshot.scripts)}` }],
            details: {
                skillName: snapshot.name,
                skillDir: snapshot.skillDir,
                source: snapshot.source,
                hash: snapshot.hash
            }
        };
    } catch (error) {
        signal?.throwIfAborted();
        return {
            content: [{ type: "text", text: `技能加载失败：${String(error)}` }],
            details: { skillName, error: String(error) }
        };
    }
}

/** 读取当前已激活技能登记的参考资料并保存读取证据 */
async function readRuntimeReference(runtime: SkillRuntime, skillName: string, referenceName: string,
    toolCallId: string, signal?: AbortSignal): Promise<AgentToolResult<unknown>> {
    signal?.throwIfAborted();
    try {
        const content = await runtime.readReference(skillName, referenceName, toolCallId);
        signal?.throwIfAborted();
        return {
            content: [{ type: "text", text: content }],
            details: { skillName, referenceName, contentLength: content.length }
        };
    } catch (error) {
        signal?.throwIfAborted();
        return {
            content: [{ type: "text", text: `参考资料读取失败：${String(error)}` }],
            details: { skillName, referenceName, error: String(error) }
        };
    }
}

/** 为本轮任务绑定有状态的技能工具，避免会话之间共享激活状态 */
export function createSkillTools(runtime: SkillRuntime): [AgentTool<typeof activateSkillParams>, AgentTool<typeof readSkillReferenceParams>] {
    return [{
        ...activateSkillTool,
        /** 执行本轮技能加载 */
        execute: (_id, params, signal) => activateRuntimeSkill(runtime, params.skillName, signal)
    }, {
        ...readSkillReferenceTool,
        /** 执行本轮参考资料读取 */
        execute: (id, params, signal) => readRuntimeReference(runtime, params.skillName, params.referenceName, id, signal)
    }];
}
