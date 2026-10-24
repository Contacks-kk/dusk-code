import { Type } from "@sinclair/typebox";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { AcceptanceRuntime } from "./runtime";
import type { EvidenceKind } from "./types";
import { availablePort } from "./processes";
import { AcceptanceWorkspace } from "./workspace";
import { loadImageAsImageContent } from "../../utils/image";
import { setTimeout as delay } from "node:timers/promises";
import { projectSourceHash, redactEvidence } from "./evidence";
import { isToolRecord } from "../tools/result";

const browserParams = Type.Object({
    action: Type.Union(["open", "navigate", "fill", "click", "press", "wait", "assert_visible", "assert_text", "assert_count", "assert_enabled", "assert_layout", "assert_response", "network", "console", "snapshot", "screenshot", "close"].map(value => Type.Literal(value))),
    context: Type.Optional(Type.String()),
    checkId: Type.Optional(Type.String()),
    url: Type.Optional(Type.String()),
    selector: Type.Optional(Type.String()),
    text: Type.Optional(Type.String()),
    key: Type.Optional(Type.String()),
    width: Type.Optional(Type.Integer({ minimum: 320, maximum: 2560 })),
    height: Type.Optional(Type.Integer({ minimum: 480, maximum: 1600 })),
    jsonPath: Type.Optional(Type.String()),
    expected: Type.Optional(Type.Unknown()),
    exact: Type.Optional(Type.Boolean()),
    timeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 30000 }))
});

const processParams = Type.Object({
    action: Type.Union(["port", "start", "run", "ready", "logs", "stop"].map(value => Type.Literal(value))),
    checkId: Type.Optional(Type.String()),
    program: Type.Optional(Type.String()),
    args: Type.Optional(Type.Array(Type.String())),
    cwd: Type.Optional(Type.String()),
    env: Type.Optional(Type.Record(Type.String(), Type.String())),
    port: Type.Optional(Type.Integer({ minimum: 1024, maximum: 65535 })),
    id: Type.Optional(Type.String()),
    url: Type.Optional(Type.String())
});

const mailParams = Type.Object({
    action: Type.Union([Type.Literal("start"), Type.Literal("read")]),
    recipient: Type.Optional(Type.String()),
    checkId: Type.Optional(Type.String())
});

/** 将取证结果及失败按原样送入模型，截图保留原生图片块 */
async function toolResult(runtime: AcceptanceRuntime, id: string, kind: EvidenceKind, checkId: string | undefined,
    run: () => Promise<Record<string, unknown>>, signal?: AbortSignal, operation?: unknown) {
    try {
        signal?.throwIfAborted();
        if (checkId && !runtime.record.contract.checks.some(check => check.id === checkId)) {
            throw new Error(`未登记的验收项：${checkId}`);
        }
        if (!isToolRecord(operation) || !["port", "logs", "stop"].includes(String(operation.action))) {
            runtime.beginEvidence(checkId);
        }
        const beforeHash = await projectSourceHash(runtime.record.projectRoot);
        const result = await run();
        if (beforeHash !== await projectSourceHash(runtime.record.projectRoot)) {
            result.success = false;
            result.error = "取证期间源码发生变化，本次结果不能证明当前版本通过";
        }
        const imagePath = typeof result.imagePath === "string" ? result.imagePath : undefined;
        const proof = checkId ? await runtime.evidence.save(kind, checkId, result.success !== false, result, id, imagePath, operation) : undefined;
        if (isToolRecord(operation)) {
            runtime.recordResult(kind === "process" || kind === "command" ? "managed_process" : "browser_action", operation, result);
        }
        const content: Array<import("@mariozechner/pi-ai").TextContent | import("@mariozechner/pi-ai").ImageContent> = [
            {
                type: "text", text: redactEvidence({ ...result, evidenceId: proof?.id }).slice(0, 24000) +
                    (proof ? `\n完整证据：${proof.artifactPath}` : "")
            }
        ];
        if (imagePath) {
            const image = await loadImageAsImageContent(imagePath);
            if (!image) {
                throw new Error("截图已生成但不能作为原生图片读取");
            }
            content.push(image);
        }
        return {
            content, details: JSON.parse(redactEvidence({
                ...result,
                completed: true,
                evidenceId: proof?.id
            })) as Record<string, unknown>
        };
    } catch (error) {
        signal?.throwIfAborted();
        const message = error instanceof Error ? error.message : String(error);
        const failedAssertion = error instanceof Error && error.name === "TimeoutError" && isToolRecord(operation) &&
            typeof operation.action === "string" && operation.action.startsWith("assert_");
        const result = {
            success: false,
            completed: failedAssertion,
            error: failedAssertion ? undefined : message,
            reason: failedAssertion ? message : undefined
        };
        if (checkId && runtime.record.contract.checks.some(check => check.id === checkId)) {
            await runtime.evidence.save(kind, checkId, false, result, id, undefined, operation);
        }
        return { content: [{ type: "text" as const, text: message }], details: result };
    }
}

/** 生成本次任务绑定的浏览器工具 */
function browserTool(runtime: AcceptanceRuntime): AgentTool<typeof browserParams> {
    return {
        name: "browser_action",
        label: "浏览器验收",
        description: "在受管服务上使用隔离账号实际操作、读取DOM/网络/控制台并截图。断言和截图传入验收 checkId。",
        parameters: browserParams,
        execute: async (id, input, signal) => {
            const kind: EvidenceKind = input.action === "screenshot" ? "image" : input.action === "network" ? "network" : String(input.action).startsWith("assert_") ? "browser_assert" : "source";
            const abort = () => {
                void runtime.browser.close().catch(error => {
                    runtime.record.stoppedReason ??= `关闭浏览器失败：${String(error)}`;
                });
            };
            signal?.addEventListener("abort", abort, { once: true });
            try {
                return await toolResult(runtime, id, kind, input.checkId, () => runtime.browser.perform(input), signal, input);
            } finally {
                signal?.removeEventListener("abort", abort);
            }
        }
    };
}

/** 启动时强制覆盖测试邮件和数据目录，避免使用真实邮箱配置 */
async function isolatedEnvironment(runtime: AcceptanceRuntime, supplied: Record<string, string> = {}): Promise<Record<string, string>> {
    const smtp = await runtime.mailbox.start();
    return {
        ...supplied,
        NODE_ENV: "test",
        SMTP_HOST: "127.0.0.1",
        SMTP_PORT: String(smtp.port),
        SMTP_USERNAME: "",
        SMTP_PASSWORD: "",
        SPRING_MAIL_HOST: "127.0.0.1",
        SPRING_MAIL_PORT: String(smtp.port),
        SPRING_MAIL_USERNAME: "",
        SPRING_MAIL_PASSWORD: "",
        SPRING_MAIL_PROPERTIES_MAIL_SMTP_AUTH: "false",
        SPRING_MAIL_PROPERTIES_MAIL_SMTP_SSL_ENABLE: "false",
        SPRING_MAIL_PROPERTIES_MAIL_SMTP_STARTTLS_ENABLE: "false"
    };
}

/** 创建只管理本次进程及隔离副本的服务工具 */
function processTool(runtime: AcceptanceRuntime): AgentTool<typeof processParams> {
    const workspace = new AcceptanceWorkspace(runtime.record.projectRoot, runtime.evidence.directory);
    return {
        name: "managed_process",
        label: "隔离服务与检查",
        description: "以 program+args 原生运行，不使用Shell拼接。port分配端口，start启动副本服务，ready探活，run运行检查，logs读取日志，stop停止自己的进程。",
        parameters: processParams,
        execute: (id, input, signal) => toolResult(runtime, id, input.action === "run" ? "command" : "process", input.checkId, async () => {
            if (input.action === "port") {
                return { success: true, port: await availablePort() };
            }
            if (["start", "run"].includes(input.action)) {
                await runtime.prepareEnvironment();
                if (!input.program || /^(?:install|uninstall|add|remove|update|upgrade)$/.test(input.args?.[0] ?? "")) {
                    throw new Error("受管检查需要原生 program；依赖安装应在开发阶段完成，不能修改共享依赖");
                }
                const snapshot = await workspace.resolve(input.cwd ?? runtime.record.projectRoot);
                const processInput = {
                    program: input.program,
                    args: input.args ?? [],
                    port: input.port,
                    cwd: snapshot.cwd,
                    env: await isolatedEnvironment(runtime, input.env)
                };
                if (input.action === "run") {
                    return runtime.processes.run(processInput, signal);
                }
                const record = await runtime.processes.start(processInput, signal);
                if (record.child.exitCode !== null || record.child.signalCode !== null) {
                    return {
                        ...await runtime.processes.logs(record.id),
                        success: false,
                        error: "服务在启动后立即退出"
                    };
                }
                if (input.port) {
                    runtime.processes.bindVersion(input.port, snapshot.sourceHash);
                }
                return {
                    success: true,
                    id: record.id,
                    pid: record.child.pid,
                    port: input.port,
                    cwd: processInput.cwd
                };
            }
            if (!input.id) {
                throw new Error("需要本任务受管进程的 id");
            }
            if (input.action === "ready") {
                return {
                    success: await runtime.processes.ready(input.id, input.url ?? "", signal),
                    id: input.id,
                    url: input.url
                };
            }
            if (input.action === "stop") {
                await runtime.processes.stop(input.id);
            }
            return { success: true, ...await runtime.processes.logs(input.id) };
        }, signal, input)
    };
}

/** 创建不会向外转发的测试收件箱工具 */
function mailTool(runtime: AcceptanceRuntime): AgentTool<typeof mailParams> {
    return {
        name: "test_mail",
        label: "隔离收件箱",
        description: "start返回本机SMTP地址；read读取本任务收到的真实邮件和验证码，不能证明真实外部邮箱已验证。",
        parameters: mailParams,
        execute: (id, input, signal) => toolResult(runtime, id, "mail", input.checkId, async () => {
            if (input.action === "start") {
                return { success: true, ...await runtime.mailbox.start() };
            }
            for (let attempt = 0; attempt < 20; attempt++) {
                const messages = runtime.mailbox.read(input.recipient);
                if (messages.length) {
                    return { success: true, messages };
                }
                await delay(250, undefined, { signal });
            }
            return {
                success: false,
                reason: "隔离收件箱没有收到对应邮件",
                messages: []
            };
        }, signal, input)
    };
}

/** 为本次验收绑定独立工具状态 */
export function createAcceptanceTools(runtime: AcceptanceRuntime) {
    const parameters = Type.Object({ checkIds: Type.Array(Type.String(), { minItems: 1 }) });
    const checkpoint: AgentTool<typeof parameters> = {
        name: "acceptance_checkpoint",
        label: "保存单项验收结果",
        description: "一项或多项业务流程完成后提交checkIds，宿主核验证据并保存部分通过结果，不重新执行操作。",
        parameters,
        execute: async (_id, input) => {
            const result = await runtime.checkpoint(input.checkIds);
            return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
        }
    };
    return [browserTool(runtime), processTool(runtime), mailTool(runtime), checkpoint] as const;
}
