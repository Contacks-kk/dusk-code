import { Type } from "@sinclair/typebox";
import type { AgentTool } from "@mariozechner/pi-agent-core";

export interface PlanReviewResult {
    approved: boolean;
    feedback?: string;
}

export type PlanReviewHandler = (plan: string) => Promise<PlanReviewResult>;

export const exitPlanModeParams = Type.Object({
    plan: Type.String({
        description: "完整的 Markdown 格式技术实施规划方案，包含架构设计、涉及文件、步骤说明与验证策略"
    })
});

export interface ExitPlanModeOptions {
    onReviewPlan?: PlanReviewHandler;
    onApprove?: () => Promise<void> | void;
}

/** 创建计划模式退出与审批门禁工具 */
export function createExitPlanModeTool(options: ExitPlanModeOptions = {}): AgentTool<typeof exitPlanModeParams> {
    return {
        name: "exit_plan_mode",
        label: "提交方案并申请退出计划模式",
        description: "在 PLAN 规划模式下完成代码调研与方案制定后调用此工具。传入完整的 Markdown 规划方案，挂起执行流程并唤起用户审批门禁。只有在用户点击批准后，只读锁定才会解除并切入执行模式；若用户打回，反馈意见将返回给你以供调整方案。",
        parameters: exitPlanModeParams,
        /** 执行方案审批挂起与门禁判定 */
        execute: async (toolCallId, params) => {
            const planText = (params.plan || "").trim();
            if (!planText) {
                throw new Error("参数错误：plan 方案内容不能为空");
            }

            // 无审批回调时默认直接放行
            if (!options.onReviewPlan) {
                if (options.onApprove) {
                    await options.onApprove();
                }
                return {
                    content: [{
                        type: "text",
                        text: "技术方案已提交。无交互审批通道，已默认解除计划模式并恢复写权限。"
                    }],
                    details: {
                        approved: true
                    }
                };
            }

            // 挂起执行流，唤起交互式审批面板等待用户裁定
            const review = await options.onReviewPlan(planText);

            // 用户批准通过方案
            if (review.approved) {
                if (options.onApprove) {
                    await options.onApprove();
                }
                return {
                    content: [{
                        type: "text",
                        text: "✔ 用户已批准技术方案！Plan 只读规划模式已解除，工作区写权限已恢复。下一轮开始即可使用文件修改与命令工具逐步落地实施。"
                    }],
                    details: {
                        approved: true
                    }
                };
            }

            // 用户驳回方案并附带反馈
            const feedbackText = review.feedback?.trim() || "方案未获批准，请补充完善设计。";
            throw new Error(`【审批门禁驳回】用户未批准当前方案，反馈意见如下：\n${feedbackText}\n\n当前会话依然处于严格的 Plan 只读模式。请根据用户的反馈意见继续调用只读工具调研并修订方案，修改完毕后请再次调用 exit_plan_mode 提交审批。`);
        }
    };
}
