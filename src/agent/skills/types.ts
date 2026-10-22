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

export interface SkillActivationResult {
    success: boolean;
    name: string;
    description: string;
    content: string;
    references: Array<{
        name: string;
        path: string;
    }>;
    error?: string;
}
