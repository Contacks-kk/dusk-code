/**
 * Agent 领域核心引擎统一门面导出 (Facade)
 * 对外收拢 Agent 执行循环、运行时调度、权限控制、安全文件 I/O 与扩展工具能力
 */

// 1. 核心执行循环与生命周期类型
export { AgentRunner, type RunnerOptions } from "./runner";
export type {
    AgentRunResult,
    AgentExecutionStep,
    ExecutionRecord,
    TaskStatus,
    GenerationAttempt,
    GenerationCall,
    GenerationUsage
} from "./types";

// 2. 运行时权限、意图与批次调度
export { permissionManager, PermissionManager, type PermissionMode, type PermissionCheckResult } from "./runtime/permission-manager";
export {
    turnControl,
    classifyTurn,
    explicitControl,
    controlToolRejection,
    executionPolicy,
    type TurnControl,
    type TurnIntent
} from "./runtime/turn-control";
export { modelConfigManager, ModelConfigManager, type ModelConfig } from "./runtime/model-config";
export type { ResolvedModelCapabilities, LlmProvider, ModelOverride } from "./runtime/model-profile";
export { ToolBatchScheduler, isConcurrencySafe, parallelToolLimit } from "./runtime/tool-batch";

// 3. 提示词装配引擎
export { buildSystemPrompt } from "./prompt";

// 4. 任务状态栏与极简待办工具
export { TaskStatusBarTracker } from "./status/tracker";
export { createTodoWriteTool } from "./status/todo.tool";
export type { TodoItem, TodoStatus } from "./status/types";

// 5. 计划模式与审批门禁
export { createExitPlanModeTool, type PlanReviewResult, type PlanReviewHandler } from "./plan/exit-plan.tool";

// 6. 安全文件系统与观察账本
export { fileObservationManager, FileObservationManager } from "./fs/observation-manager";
export { atomicWriteFile, detectEol, convertEol, computeContentHash } from "./fs/atomic-io";
export type { EolType, FileObservationRecord, MutationVerificationResult } from "./fs/types";

// 7. 工具箱与命令绑定
export { toolRegistry } from "./tools/registry";
export { bindCommandTools } from "./tools/command-tools";

// 8. 技能与验收
export { skillRegistry } from "./skills/registry";
export { prepareTurnSkills } from "./skills/preparation";
export { AcceptanceRuntime } from "./acceptance/runtime";
export { formatTaskStatus, taskFacts, TaskStore } from "./acceptance/task-store";
export { parseVerificationOptions, prepareDelivery } from "./acceptance/requirements";
export type { VerificationOptions, DeliveryRecord } from "./acceptance/types";
