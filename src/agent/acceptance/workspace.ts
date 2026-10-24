import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { projectSourceHash } from "./evidence";
import { duskDataDirectory } from "../../config/data-directory";

const EXCLUDED = new Set([".git", "node_modules", ".dusk", ".taste-skill", "coverage", ".cache"]);

export class AcceptanceWorkspace {
    private sourceHash?: string;
    private directory?: string;
    private preparing?: Promise<{ cwd: string; sourceHash: string }>;

    /** 为代码快照建立运行副本，数据写入不会落在用户项目中 */
    constructor(private readonly sourceRoot: string, private readonly artifacts: string) { }

    /** 创建或复用当前源码的隔离副本，依赖只复用读取 */
    async resolve(cwd: string): Promise<{ cwd: string; sourceHash: string }> {
        const relative = path.relative(this.sourceRoot, path.resolve(this.sourceRoot, cwd));
        if (relative.startsWith("..") || path.isAbsolute(relative)) {
            throw new Error("受管进程的 cwd 必须属于当前目标项目");
        }
        while (this.preparing) {
            await this.preparing;
        }
        const preparation = this.prepare(relative);
        this.preparing = preparation;
        try {
            return await preparation;
        } finally {
            this.preparing = undefined;
        }
    }

    /** 完整复制并核对源码版本后才允许启动服务 */
    private async prepare(relative: string): Promise<{ cwd: string; sourceHash: string }> {
        const hash = await projectSourceHash(this.sourceRoot);
        if (hash !== this.sourceHash) {
            const directory = path.join(this.artifacts, "workspaces", randomUUID().replace(/-/g, "").slice(0, 16));
            await fs.mkdir(directory, { recursive: true });
            await this.copySources(this.sourceRoot, directory);
            await this.linkDependencies(this.sourceRoot, directory);
            if (await projectSourceHash(directory) !== hash || await projectSourceHash(this.sourceRoot) !== hash) {
                throw new Error("复制期间源码发生变化或副本不完整，请重新准备隔离环境");
            }
            this.directory = directory;
            this.sourceHash = hash;
        }
        if (!this.directory) {
            throw new Error("隔离工程副本尚未准备成功");
        }
        return { cwd: path.join(this.directory, relative), sourceHash: hash };
    }

    /** 逐目录复制以支持数据目录位于项目内，并跳过指向原工程的符号链接 */
    private async copySources(source: string, target: string): Promise<void> {
        for (const entry of await fs.readdir(source, { withFileTypes: true })) {
            const from = path.join(source, entry.name);
            if (entry.isSymbolicLink() || !this.shouldCopy(from)) {
                continue;
            }
            const to = path.join(target, entry.name);
            if (entry.isDirectory()) {
                await fs.mkdir(to, { recursive: true });
                await this.copySources(from, to);
            } else {
                await fs.copyFile(from, to);
            }
        }
    }

    /** 排除真实凭据、持久化数据库及自身证据，保留业务源码和静态资料 */
    private shouldCopy(source: string): boolean {
        if (source === this.sourceRoot) {
            return true;
        }
        const name = path.basename(source);
        const relative = path.relative(this.artifacts, source);
        const inArtifacts = !relative.startsWith("..") && !path.isAbsolute(relative);
        return !EXCLUDED.has(name) && !/^\.env(?:\.|$)|\.(?:db|sqlite|sqlite3)(?:-wal|-shm)?$/i.test(name) &&
            path.relative(this.sourceRoot, source) !== "data" && path.relative(duskDataDirectory(), source) !== "" && !inArtifacts;
    }

    /** 复用已安装的前端依赖，隔离验收不安装或更新这些目录 */
    private async linkDependencies(source: string, target: string): Promise<void> {
        for (const entry of await fs.readdir(source, { withFileTypes: true })) {
            if (!entry.isDirectory() || entry.isSymbolicLink()) {
                continue;
            }
            if (entry.name === "node_modules") {
                try {
                    await fs.symlink(path.join(source, entry.name), path.join(target, entry.name), process.platform === "win32" ? "junction" : "dir");
                } catch (error) {
                    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
                        throw error;
                    }
                }
            } else if (this.shouldCopy(path.join(source, entry.name))) {
                await this.linkDependencies(path.join(source, entry.name), path.join(target, entry.name));
            }
        }
    }
}
