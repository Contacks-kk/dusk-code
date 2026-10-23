export interface SkillMetadata {
    name: string;
    description: string;
    tags?: string[];
    author?: string;
    version?: string;
    argumentHint?: string;
}

export interface SkillReference {
    name: string;
    relativePath: string;
    absolutePath: string;
    sizeBytes: number;
}

export interface SkillItem {
    name: string;
    description: string;
    metadata: SkillMetadata;
    skillDir: string;
    skillMdPath: string;
    path: string;
    scope: "project" | "user" | "builtin";
    source: "project" | "user" | "builtin";
    references: SkillReference[];
    scripts: string[];
}

export interface SkillDetail extends SkillItem {
    content: string;
}

export interface SkillActivationSuccess {
    success: true;
    name: string;
    description: string;
    content: string;
    skillDir: string;
    skillMdPath: string;
    source: SkillItem["source"];
    scripts: Array<{ name: string; path: string }>;
    references: Array<{
        name: string;
        path: string;
        absolutePath: string;
    }>;
}

export interface SkillActivationFailure {
    success: false;
    name: string;
    description: string;
    content: "";
    references: [];
    error: string;
}

export type SkillActivationResult = SkillActivationSuccess | SkillActivationFailure;

export interface SessionSkillState {
    pinned: string[];
    disabled: string[];
}

export interface SkillSelection {
    skills: Array<{ name: string; reason: string }>;
    needsVisualVerification: boolean;
}

export interface SkillSnapshot {
    name: string;
    description: string;
    origin: "manual" | "auto" | "tool";
    reason: string;
    source: SkillItem["source"];
    skillDir: string;
    skillMdPath: string;
    content: string;
    hash: string;
    references: Array<{ name: string; path: string; absolutePath: string }>;
    scripts: Array<{ name: string; path: string }>;
    missingDependencies?: string[];
    status: "loaded" | "budget_excluded";
}

export interface SkillEvent {
    kind: "loaded" | "reference" | "command" | "image" | "image_request" | "image_failure" | "change" | "budget";
    timestamp: number;
    success: boolean;
    name?: string;
    path?: string;
    toolCallId?: string;
    callKey?: string;
    detail?: string;
}

export interface SkillExecutionRecord {
    selection: {
        status: "completed" | "failed" | "skipped";
        skills: SkillSelection["skills"];
        error?: string;
    };
    disabled: string[];
    snapshots: SkillSnapshot[];
    failures: Array<{ name: string; error: string }>;
    events: SkillEvent[];
    needsVisualVerification: boolean;
    visual: {
        status: "not_required" | "pending" | "feedback_received" | "incomplete";
        reason?: string;
    };
}
