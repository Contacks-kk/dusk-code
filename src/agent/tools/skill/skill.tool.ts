import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { skillActivator } from "../../skills/activator";

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

        if (!result.success) {
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
