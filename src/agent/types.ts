import type { AssistantMessage } from "@mariozechner/pi-ai";
import type { ContextRecord } from "./context/types";
import type { RequestDiagnostics } from "./runtime/model-adapter";

export type StepType = 
"thought" | 
"thinking_delta" | 
"tool_call" | 
"tool_result" | 
"answer" | 
"status" | 
"turn_start" | 
"turn_end" | 
"intermediate_text" | 
"recovery_start" | 
"recovery_progress";
export type RunStatus = 
"completed" | 
"truncated" | 
"empty" | 
"failed" | 
"timeout" | 
"aborted";
export type TruncationStage = 
"thinking" | 
"text" | 
"tool_call";
export type RecoveryAction = 
"reuse_reasoning" | 
"boost_budget_original" | 
"checkpoint_continue" | 
"text_continuation" | 
"retry_tool_call";

export interface RecoveryStepRecord {
    recoveryAttemptNo: number;
    stage: TruncationStage;
    actionTaken: RecoveryAction;
    previousTokens: number;
    newTokens: number;
    accumulatedTextLength: number;
    success: boolean;
    note?: string;
}

export interface GenerationUsage {
    inputTokens: number | null;
    outputTokens: number | null;
    reasoningTokens: number | null;
    cacheReadTokens: number | null;
    totalTokens: number | null;
}

export interface GenerationCall {
    diagnostics?: RequestDiagnostics;
    phase?: "streaming" | "finished";
    callNo: number;
    maxTokens: number;
    status: RunStatus;
    stopReason?: string;
    durationMs: number;
    usage: GenerationUsage;
    thinkingChars: number;
    hasText: boolean;
    toolCallCount: number;
    sideEffectStarted: boolean;
    error?: string;
    response?: AssistantMessage;
}

export interface GenerationAttempt {
    attemptNo: number;
    maxTokens: number;
    status: RunStatus;
    stopReason?: string;
    durationMs: number;
    sideEffectStarted: boolean;
    calls: GenerationCall[];
    error?: string;
    recoveryStage?: TruncationStage;
    recoveryAction?: RecoveryAction;
}

export interface ExecutionRecord {
    auxiliaryRequests?: RequestDiagnostics[];
    context?: ContextRecord;
    phase?: "running" | "recovering" | "finished";
    effectiveCallRefs?: Array<{ attemptNo: number; callNo: number }>;
    pendingToolCallIds?: string[];
    status: RunStatus;
    error?: string;
    config: {
        diagnostics?: RequestDiagnostics;
        model: string;
        requestedReasoningEffort: string;
        thinking: "enabled" | "disabled" | "sdk-default";
        contextWindow: number;
        maxTokens: number;
        retryMaxTokens: number;
        generationTimeoutMs?: number;
    };
    attempts: GenerationAttempt[];
    recoverySteps?: RecoveryStepRecord[];
    totalDurationMs: number;
}

export interface AgentExecutionStep {
    callNo?: number;
    type: StepType;
    content?: string;
    delta?: string;
    toolName?: string;
    toolCallId?: string;
    args?: Record<string, any>;
    result?: any;
    durationMs?: number;
    isError?: boolean;
    timestamp: number;
    attemptNo?: number;
    turnNo?: number;
}

import type { ResponseQuality, SalvagedContent } from "./runtime/response-salvager";

export interface AgentRunResult {
    sessionId: number;
    turnId: number;
    turnNo: number;
    reply: string;
    modelReply?: string;
    steps: AgentExecutionStep[];
    totalDurationMs?: number;
    isTruncated?: boolean;
    stopReason?: string;
    status: RunStatus;
    execution: ExecutionRecord;
    responseQuality?: ResponseQuality;
    salvaged?: SalvagedContent;
}
