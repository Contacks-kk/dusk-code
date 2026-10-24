import { SMTPServer } from "smtp-server";
import { simpleParser } from "mailparser";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

export class AcceptanceMailbox {
    private server?: SMTPServer;
    private readonly messages: Array<{ to: string[]; subject: string; text: string; path: string }> = [];
    private port?: number;
    private starting?: Promise<Record<string, unknown>>;

    /** 使用当前任务目录保存邮件原文，不提供对外转发能力 */
    constructor(private readonly directory: string) { }

    /** 启动只绑定回环地址且不认证的隔离收件服务 */
    async start(): Promise<Record<string, unknown>> {
        if (this.starting) {
            return this.starting;
        }
        this.starting = this.listen();
        try {
            return await this.starting;
        } finally {
            this.starting = undefined;
        }
    }

    /** 所有并行调用共用同一次绑定，避免返回尚未分配的 SMTP 端口 */
    private async listen(): Promise<Record<string, unknown>> {
        if (this.server) {
            return {
                host: "127.0.0.1",
                port: this.port,
                secure: false,
                authentication: false
            };
        }
        await fs.mkdir(this.directory, { recursive: true });
        this.server = new SMTPServer({
            authOptional: true,
            disabledCommands: ["AUTH", "STARTTLS"],
            onData: (stream, session, callback) => {
                void this.receive(stream, session.envelope.rcptTo.map(item => item.address)).then(() => callback(), callback);
            },
            logger: false
        });
        await new Promise<void>((resolve, reject) => {
            this.server!.once("error", reject);
            this.server!.listen(0, "127.0.0.1", resolve);
        });
        this.port = (this.server.server.address() as { port: number }).port;
        return {
            host: "127.0.0.1",
            port: this.port,
            secure: false,
            authentication: false
        };
    }

    /** 同时保存邮件字节及可供页面验证码流程读取的内容 */
    private async receive(stream: NodeJS.ReadableStream, to: string[]): Promise<void> {
        const chunks: Buffer[] = [];
        for await (const chunk of stream) {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        const raw = Buffer.concat(chunks);
        const parsed = await simpleParser(raw);
        const filename = path.join(this.directory, `${randomUUID()}.eml`);
        await fs.writeFile(filename, raw);
        this.messages.push({
            to,
            subject: parsed.subject ?? "",
            text: parsed.text ?? "",
            path: filename
        });
    }

    /** 只读取本次隔离收件箱中符合收件人的邮件 */
    read(recipient?: string): Array<{ to: string[]; subject: string; text: string; path: string }> {
        return this.messages.filter(message => !recipient || message.to.some(to => to.toLowerCase() === recipient.toLowerCase()));
    }

    /** 修复后清除已读取邮件的视图，原始邮件证据仍保留 */
    clear(): void {
        this.messages.length = 0;
    }

    /** 关闭当前任务的隔离邮件服务 */
    async close(): Promise<void> {
        if (this.server) {
            await new Promise<void>(resolve => this.server!.close(resolve));
            this.server = undefined;
        }
    }
}
