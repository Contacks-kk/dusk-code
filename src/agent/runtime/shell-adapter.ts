import { randomUUID } from "node:crypto";
import { createCommandOutput } from "./command-output";
import type { CommandOutputContext } from "../spill/types";
import { spawn } from "node:child_process";
import * as path from "node:path";
import * as fs from "node:fs";

export interface CommandExecutionResult {
    stdout: string;
    stderr: string;
    exitCode: number;
    timedOut: boolean;
    aborted: boolean;
    outputIncomplete: boolean;
    stdoutPath?: string;
    stderrPath?: string;
    stdoutBytes?: number;
    stderrBytes?: number;
    outputTruncated?: boolean;
    outputStorageError?: string;
    operationStarted?: boolean;
}

/** 提取命令归档信息及输出完整性标记 */
export function commandOutputDetails(result: CommandExecutionResult) {
    return {
        stdoutPath: result.stdoutPath,
        stderrPath: result.stderrPath,
        stdoutBytes: result.stdoutBytes,
        stderrBytes: result.stderrBytes,
        outputTruncated: result.outputTruncated,
        outputStorageError: result.outputStorageError,
        operationStarted: result.operationStarted,
        outputIncomplete: result.outputIncomplete,
        ...(result.outputStorageError ? { error: `输出归档失败：${result.outputStorageError}；请先核实已执行操作，不得重放` } : {})
    };
}

/** 跨平台终端执行与命令安全防护适配器 */
export class ShellAdapter {
    private isWindows = process.platform === "win32";

    /** 优先使用新版 PowerShell，保留原生命令退出码并单独处理 Shell 异常 */
    private windowsInvocation(command: string): { program: string; args: string[] } {
        const modern = path.join(process.env.ProgramFiles ?? "C:\\Program Files", "PowerShell", "7", "pwsh.exe");
        const installed = [modern, ...(process.env.PATH ?? "").split(path.delimiter).map(directory => path.join(directory, "pwsh.exe"))]
            .find(filename => fs.existsSync(filename));
        const script = `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8;
$global:LASTEXITCODE = $null;
try {
    & { ${command}
    };
    $duskShellSucceeded = $?;
    if ($null -ne $global:LASTEXITCODE) {
        exit $global:LASTEXITCODE;
    };
    if (-not $duskShellSucceeded) {
        exit 1;
    };
    exit 0;
} catch {
    [Console]::Error.WriteLine($_.ToString());
    exit 1;
}`;
        return {
            program: installed ?? "powershell.exe",
            args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script]
        };
    }

    /** 检查命令是否包含高危禁止操作 */
    public validateCommandSafety(command: string): void {
        const dangerousPatterns = [
            /rm\s+-rf\s+[\/\*]/i,
            /Remove-Item\s+.*-Recurse/i,
            /format\s+[a-zA-Z]:/i,
            /del\s+\/f\s+\/s\s+\/q/i,
            /mkfs\./i
        ];

        for (const pattern of dangerousPatterns) {
            if (pattern.test(command)) {
                throw new Error(`执行被安全拦截：检测到高风险破坏性指令 [${command}]，已被系统策略拒绝。`);
            }
        }
    }

    /** 根据当前操作系统环境执行终端命令并返回安全格式化结果 */
    public async execute(
        command: string,
        cwd: string = process.cwd(),
        timeoutMs: number = 30000,
        signal?: AbortSignal,
        outputContext?: CommandOutputContext
    ): Promise<CommandExecutionResult> {
        this.validateCommandSafety(command);

        if (signal?.aborted) {
            return {
                stdout: "",
                stderr: "",
                exitCode: -1,
                timedOut: false,
                aborted: true,
                outputIncomplete: false
            };
        }

        const targetCwd = path.isAbsolute(cwd) ? cwd : path.resolve(process.cwd(), cwd);

        const output = await createCommandOutput(outputContext ?? {
            projectRoot: targetCwd,
            sessionId: 0,
            toolName: "command",
            toolCallId: randomUUID()
        });
        if (signal?.aborted) {
            output.stdout.end();
            output.stderr.end();
            await Promise.all([output.stdout.completion, output.stderr.completion]);
            return { stdout: "", stderr: "", exitCode: -1, timedOut: false, aborted: true, outputIncomplete: false, operationStarted: false };
        }
        return new Promise<CommandExecutionResult>((resolve) => {
            let shellProgram: string;
            let shellArgs: string[];

            if (this.isWindows) {
                // Windows 环境下强制启用 PowerShell 并指定 UTF-8 编码
                const invocation = this.windowsInvocation(command);
                shellProgram = invocation.program;
                shellArgs = invocation.args;
            } else {
                // Unix/Linux/macOS 环境下使用 sh
                shellProgram = "/bin/sh";
                shellArgs = ["-c", command];
            }

            let proc: ReturnType<typeof spawn>;
            try {
                proc = spawn(shellProgram, shellArgs, {
                    cwd: targetCwd,
                    env: { ...process.env, LANG: "zh_CN.UTF-8" },
                    windowsHide: true
                });
            } catch (error) {
                output.stdout.end();
                output.stderr.end();
                void Promise.all([output.stdout.completion, output.stderr.completion]).then(() => resolve({
                    stdout: "",
                    stderr: `进程未启动：${error instanceof Error ? error.message : String(error)}`,
                    exitCode: -1,
                    timedOut: false,
                    aborted: false,
                    outputIncomplete: false,
                    operationStarted: false
                }));
                return;
            }

            let lifecycleError = "";
            let timedOut = false;
            let aborted = false;
            let exited = false;
            let settled = false;
            let exitCode = -1;
            let timer: ReturnType<typeof setTimeout> | undefined;
            let drainTimer: ReturnType<typeof setTimeout> | undefined;

            /** 清理本次命令的等待资源并只返回一次结果 */
            const finish = async (outputIncomplete: boolean = false): Promise<void> => {
                if (settled) {
                    return;
                }
                settled = true;
                clearTimeout(timer);
                clearTimeout(drainTimer);
                signal?.removeEventListener("abort", onAbort);

                // 停止接收新字节后，等待已采集字节落盘
                proc.stdout.unpipe(output.stdout);
                proc.stderr.unpipe(output.stderr);
                proc.stdin?.destroy();
                proc.stdout.destroy();
                proc.stderr.destroy();
                output.stdout.end();
                output.stderr.end();
                proc.unref();
                await Promise.all([output.stdout.completion, output.stderr.completion]);
                const storageError = output.stdout.storageError ?? output.stderr.storageError;
                resolve({
                    stdout: output.stdout.preview(),
                    stderr: output.stderr.preview() + lifecycleError,
                    stdoutPath: output.stdout.filename,
                    stderrPath: output.stderr.filename,
                    stdoutBytes: output.stdout.totalBytes,
                    stderrBytes: output.stderr.totalBytes,
                    outputTruncated: output.stdout.totalBytes > 12000 || output.stderr.totalBytes > 12000,
                    outputStorageError: storageError,
                    operationStarted: Boolean(proc.pid),
                    exitCode,
                    timedOut,
                    aborted,
                    outputIncomplete: outputIncomplete || Boolean(storageError)
                });
            };

            /** 尝试终止当前命令并结束超时或取消等待 */
            const stop = (cancelled: boolean, storageFailure = false): void => {
                if (settled) {
                    return;
                }
                aborted = cancelled;
                timedOut = !cancelled && !storageFailure;

                // Shell 已退出时保留后台进程，仅停止回收剩余输出
                if (!exited) {
                    try {
                        if (!proc.kill()) {
                            lifecycleError += "\n未能确认命令进程已终止，子进程可能仍在运行。";
                        }
                    } catch (error) {
                        const message = error instanceof Error ? error.message : String(error);
                        lifecycleError += `\n终止命令进程失败: ${message}`;
                    }
                }

                // 终止失败也必须返回，不能继续依赖进程或管道关闭
                finish(!proc.stdout.readableEnded || !proc.stderr.readableEnded);
            };

            /** 响应用户取消并结束本次命令等待 */
            const onAbort = (): void => {
                stop(true);
            };

            /** 存盘失败时停止命令，并保留已执行状态 */
            const outputFailed = (error: Error): void => {
                lifecycleError += `\n输出存盘失败：${error.message}；命令可能已产生副作用，不得直接重放。`;
                stop(false, true);
            };
            output.stdout.on("error", outputFailed);
            output.stderr.on("error", outputFailed);
            proc.stdout.on("error", outputFailed);
            proc.stderr.on("error", outputFailed);
            proc.stdout.pipe(output.stdout);
            proc.stderr.pipe(output.stderr);

            proc.once("exit", (code) => {
                if (settled) {
                    return;
                }
                exited = true;
                exitCode = code ?? -1;
                clearTimeout(timer);

                // Shell 退出后最多再回收一秒输出，避免被后台进程持有的管道拖住
                drainTimer = setTimeout(() => finish(true), 1000);
            });

            proc.once("close", (code) => {
                if (settled) {
                    return;
                }
                exitCode = code ?? exitCode;
                finish();
            });

            proc.on("error", (err) => {
                if (settled) {
                    return;
                }
                lifecycleError += `\n进程执行失败: ${err.message}`;

                // 终止进程产生的错误由超时或取消分支统一收尾
                if (!timedOut && !aborted) {
                    finish();
                }
            });

            timer = setTimeout(() => stop(false), timeoutMs);
            signal?.addEventListener("abort", onAbort, { once: true });
            if (signal?.aborted) {
                onAbort();
            }
        });
    }
}

export const shellAdapter = new ShellAdapter();
