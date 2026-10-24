import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import * as net from "node:net";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { shellAdapter } from "../runtime/shell-adapter";

interface OwnedProcess {
    id: string;
    child: ChildProcess;
    stdout: string;
    stderr: string;
    streams: fs.WriteStream[];
    closed: Promise<number | null>;
    port?: number;
    stopped?: boolean;
    error?: string;
}

export interface ProcessInput {
    program: string;
    args: string[];
    cwd: string;
    env?: Record<string, string>;
    port?: number;
}

/** 分配仅供当前测试环境使用的本机空闲端口 */
export async function availablePort(): Promise<number> {
    const server = net.createServer();
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address() as net.AddressInfo;
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    return address.port;
}

/** 判断端口是否已经被其他服务占用 */
async function portAvailable(port: number): Promise<void> {
    const server = net.createServer();
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", resolve);
    });
    await new Promise<void>(resolve => server.close(() => resolve()));
}

export class AcceptanceProcesses {
    private readonly owned = new Map<string, OwnedProcess>();
    readonly origins = new Set<string>();
    readonly originVersions = new Map<string, string>();

    /** 绑定任务目录，不接管用户已经启动的进程 */
    constructor(private readonly directory: string) { }

    /** 将服务端口绑定到真正启动的源码版本 */
    bindVersion(port: number, hash: string): void {
        this.originVersions.set(`http://127.0.0.1:${port}`, hash);
        this.originVersions.set(`http://localhost:${port}`, hash);
    }

    /** 将 Windows 批处理参数转换为不会触发额外命令的调用 */
    private invocation(input: ProcessInput): { program: string; args: string[] } {
        shellAdapter.validateCommandSafety([input.program, ...input.args].join(" "));
        if (process.platform !== "win32" || !/\.(?:cmd|bat)$/i.test(input.program)) {
            return { program: input.program, args: input.args };
        }
        if ([input.program, ...input.args].some(value => /[\r\n"&|<>%]/.test(value))) {
            throw new Error("Windows 批处理参数含命令控制字符，请改用原生可执行文件");
        }
        return {
            program: process.env.ComSpec || "cmd.exe",
            args: ["/d", "/s", "/c", `"${[input.program, ...input.args].map(value => `"${value}"`).join(" ")}"`]
        };
    }

    /** 启动受管原生命令并将完整输出写入任务目录 */
    async start(input: ProcessInput, signal?: AbortSignal): Promise<OwnedProcess> {
        signal?.throwIfAborted();
        if (input.port) {
            await portAvailable(input.port);
        }
        await fsp.mkdir(this.directory, { recursive: true });
        const id = randomUUID();
        const command = this.invocation(input);
        const streams = [fs.createWriteStream(path.join(this.directory, `${id}.stdout.log`)),
        fs.createWriteStream(path.join(this.directory, `${id}.stderr.log`))];
        const child = spawn(command.program, command.args, {
            cwd: input.cwd,
            env: { ...this.baseEnvironment(), ...input.env },
            windowsHide: true,
            detached: process.platform !== "win32",
            stdio: ["ignore", "pipe", "pipe"]
        });
        const closed = new Promise<number | null>(resolve => {
            child.once("close", code => {
                this.removeOrigins(record);
                resolve(code);
            });
            child.once("error", error => {
                record.error = error.message;
                streams[1].write(String(error));
                resolve(-1);
            });
        });
        const record: OwnedProcess = {
            id,
            child,
            streams,
            closed,
            stdout: path.join(this.directory, `${id}.stdout.log`),
            stderr: path.join(this.directory, `${id}.stderr.log`),
            port: input.port
        };
        this.owned.set(id, record);
        this.observePipeErrors(record);
        child.stdout?.pipe(streams[0]);
        child.stderr?.pipe(streams[1]);
        if (input.port) {
            this.origins.add(`http://127.0.0.1:${input.port}`);
            this.origins.add(`http://localhost:${input.port}`);
        }
        await delay(50, undefined, { signal });
        if (record.error) {
            throw new Error(`受管进程启动失败：${record.error}；日志：${record.stderr}`);
        }
        return record;
    }

    /** 管道与日志错误作为受管工具失败记录，不能使整个 Node 进程崩溃 */
    private observePipeErrors(record: OwnedProcess): void {
        const failed = (error: Error): void => {
            record.error = record.error ? `${record.error}；${error.message}` : error.message;
            void this.stop(record.id).catch(stopError => {
                record.error += `；停止失败：${String(stopError)}`;
            });
        };
        record.child.stdout?.on("error", failed);
        record.child.stderr?.on("error", failed);
        for (const stream of record.streams) {
            stream.on("error", failed);
        }
    }

    /** 进程关闭后撤销对应端口授权，避免其他进程复用端口后被误访问 */
    private removeOrigins(record: OwnedProcess): void {
        if (!record.port || [...this.owned.values()].some(item => item !== record && item.port === record.port && !item.stopped && item.child.exitCode === null)) {
            return;
        }
        for (const host of ["127.0.0.1", "localhost"]) {
            const origin = `http://${host}:${record.port}`;
            this.origins.delete(origin);
            this.originVersions.delete(origin);
        }
    }

    /** 只继承运行程序所需的系统环境，不把用户数据库或邮件凭据带入副本 */
    private baseEnvironment(): NodeJS.ProcessEnv {
        return Object.fromEntries(Object.entries(process.env).filter(([name]) =>
            /^(?:PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|JAVA_HOME|MAVEN_HOME|M2_HOME|LANG|LC_.+|NUMBER_OF_PROCESSORS|PROCESSOR_ARCHITECTURE)$/i.test(name)));
    }

    /** 等待受管构建或检查，取消和超时只终止本次启动的进程 */
    async run(input: ProcessInput, signal?: AbortSignal): Promise<Record<string, unknown>> {
        const record = await this.start(input, signal);
        const abort = () => {
            void this.stop(record.id).catch(error => record.streams[1].write(`取消受管进程失败：${String(error)}`));
        };
        signal?.addEventListener("abort", abort, { once: true });
        let timer: ReturnType<typeof setTimeout>;
        let timedOut = false;
        try {
            const exitCode = await Promise.race([record.closed, new Promise<number>(resolve => {
                timer = setTimeout(() => { timedOut = true; resolve(-1); }, 120000);
            })]);
            if (timedOut || signal?.aborted) {
                await this.stop(record.id);
            }
            await Promise.all(record.streams.map(stream => stream.closed ? Promise.resolve() : new Promise<void>(resolve => stream.once("close", resolve))));
            return {
                ...await this.logs(record.id),
                exitCode,
                timedOut,
                aborted: Boolean(signal?.aborted),
                success: exitCode === 0 && !timedOut && !signal?.aborted && !record.error
            };
        } finally {
            clearTimeout(timer!);
            signal?.removeEventListener("abort", abort);
        }
    }

    /** 读取受管进程输出，完整原文保留在日志文件中 */
    async logs(id: string): Promise<Record<string, unknown>> {
        const record = this.get(id);
        const [stdout, stderr] = await Promise.all([fsp.readFile(record.stdout, "utf8"), fsp.readFile(record.stderr, "utf8")]);
        return {
            id,
            pid: record.child.pid,
            stdout: stdout.slice(-16000),
            stderr: stderr.slice(-16000),
            stdoutPath: record.stdout,
            stderrPath: record.stderr,
            error: record.error,
            exitCode: record.child.exitCode
        };
    }

    /** 探测本次启动的服务是否在规定时间内可用 */
    async ready(id: string, url: string, signal?: AbortSignal): Promise<boolean> {
        const record = this.get(id);
        const address = new URL(url);
        if (!this.origins.has(address.origin) || Number(address.port) !== record.port || record.stopped) {
            throw new Error("探活地址不属于本次受管服务");
        }
        const deadline = Date.now() + 30000;
        while (Date.now() < deadline && record.child.exitCode === null) {
            signal?.throwIfAborted();
            try {
                const response = await fetch(url, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(1500)]) : AbortSignal.timeout(1500) });
                if (response.status < 500) {
                    return true;
                }
            } catch (error) {
                signal?.throwIfAborted();
            }
            await delay(250, undefined, { signal });
        }
        return false;
    }

    /** 只接受本任务持有的进程标识 */
    private get(id: string): OwnedProcess {
        const record = this.owned.get(id);
        if (!record) {
            throw new Error("不能访问不属于当前任务的进程");
        }
        return record;
    }

    /** 停止自己创建的进程树，不按端口或程序名杀进程 */
    async stop(id: string): Promise<void> {
        const record = this.get(id);
        if (record.stopped) {
            return;
        }
        record.stopped = true;
        if (record.port) {
            for (const host of ["127.0.0.1", "localhost"]) {
                const origin = `http://${host}:${record.port}`;
                this.origins.delete(origin);
                this.originVersions.delete(origin);
            }
        }
        if (record.child.exitCode === null && record.child.signalCode === null && record.child.pid) {
            if (process.platform === "win32") {
                const killer = spawn("taskkill", ["/PID", String(record.child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
                await new Promise<void>(resolve => {
                    killer.once("close", () => resolve());
                    killer.once("error", () => { record.child.kill(); resolve(); });
                });
            } else {
                try {
                    process.kill(-record.child.pid, "SIGTERM");
                } catch (error) {
                    if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
                        throw error;
                    }
                }
            }
        }
        for (const stream of record.streams) {
            stream.end();
        }
    }

    /** 在正常结束及取消后回收当前任务创建的服务 */
    async close(): Promise<void> {
        for (const id of this.owned.keys()) {
            await this.stop(id);
        }
    }
}
