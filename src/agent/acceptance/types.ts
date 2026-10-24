import type { AgentMessage } from "@mariozechner/pi-agent-core";

export type DeliveryStatus = "not_required" | "pending" | "verifying" | "repairing" | "passed" | "unverified" | "blocked" | "aborted";
export type EvidenceKind = "command" | "browser_assert" | "network" | "image" | "mail" | "process" | "source";
export type CheckStatus = "pending" | "running" | "awaiting_review" | "passed" | "failed" | "blocked" | "stale";

export interface VerificationOptions {
    mode?: "auto" | "off" | "only";
    taskId?: string;
}

export interface AcceptanceCheck {
    id: string;
    title: string;
    preconditions: string[];
    steps: string[];
    expected: string;
    evidenceKinds: EvidenceKind[];
    required: boolean;
    realIntegration: boolean;
    status: CheckStatus;
    evidenceIds: string[];
    feedback?: string;
}

export interface TaskContract {
    kind: "implement" | "plan" | "explain";
    originalInput: string;
    outputs: string[];
    checks: AcceptanceCheck[];
    dependencies: Array<{ name: string; kind: string; realRequired: boolean }>;
    version: number;
    changes: Array<{ version: number; reason: string; timestamp: number }>;
}

export interface AcceptanceEvidence {
    id: string;
    checkId: string;
    kind: EvidenceKind;
    success: boolean;
    isolated: boolean;
    codeHash: string;
    contractVersion?: number;
    sourcePath?: string;
    operationKey?: string;
    resultDigest?: string;
    layoutPassed?: boolean;
    artifactPath: string;
    hash: string;
    timestamp: number;
    toolCallId?: string;
    summary: string;
    imagePath?: string;
    imageHash?: string;
}

export interface DeliveryContinuation {
    id: string;
    message: AgentMessage;
    afterCall: { attemptNo: number; callNo: number };
    instructionRevision?: number;
}

export interface DeliveryRecord {
    version: 1;
    taskId: string;
    projectRoot: string;
    contract: TaskContract;
    status: DeliveryStatus;
    repairRounds: number;
    evidence: AcceptanceEvidence[];
    continuations: DeliveryContinuation[];
    rounds: Array<{ round: number; timestamp: number; failures: string[]; fingerprint: string }>;
    verificationStartedAt?: number;
    stoppedReason?: string;
    sourceHash?: string;
    planningError?: string;
    verificationOnly?: boolean;
    runStartedAt?: number;
    candidateReply?: string;
    finalReport?: string;
    reviews?: Array<{ artifactPath: string; hash: string; timestamp: number }>;
    awaitingPlan?: boolean;
    verificationElapsedMs?: number;
    processFacts?: Array<{ id: string; state: "started" | "ready" | "stopped" | "unknown"; observedAt: number; url?: string }>;
}

export interface ReviewResult {
    checks: Array<{ id: string; status: "passed" | "failed" | "unknown"; evidenceIds: string[]; reason: string }>;
}
