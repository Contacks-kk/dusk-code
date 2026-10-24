import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { isToolRecord } from "../tools/result";

interface BrowserSession {
    context: BrowserContext;
    page: Page;
    console: string[];
    network: Array<{ url: string; method: string; status: number; body: string; requestBody: string | null; timestamp: number }>;
    pending: Set<Promise<void>>;
    lastInteractionAt: number;
}

export interface BrowserAction {
    action: string;
    context?: string;
    url?: string;
    selector?: string;
    text?: string;
    key?: string;
    width?: number;
    height?: number;
    jsonPath?: string;
    expected?: unknown;
    exact?: boolean;
    timeoutMs?: number;
}

export class AcceptanceBrowser {
    private browser?: Browser;
    private readonly sessions = new Map<string, BrowserSession>();

    /** 只允许访问当前任务登记的服务及保存当前任务的截图 */
    constructor(private readonly directory: string, private readonly origins: Set<string>, private readonly checkVersion?: (origin: string) => Promise<void>) { }

    /** 使用本机已安装浏览器，不隐式下载或接管用户浏览器 */
    private async launch(): Promise<Browser> {
        if (this.browser) {
            return this.browser;
        }
        const errors: string[] = [];
        for (const channel of ["chrome", "msedge"]) {
            try {
                this.browser = await chromium.launch({
                    channel,
                    headless: true,
                    timeout: 15000
                });
                return this.browser;
            } catch (error) {
                errors.push(error instanceof Error ? error.message.split("\n")[0] : String(error));
            }
        }
        throw new Error(`未找到可用的已安装 Chrome/Edge：${errors.join("；")}`);
    }

    /** 为不同测试账号创建独立的 Cookie、存储和页面 */
    private async session(name: string, width = 1440, height = 900): Promise<BrowserSession> {
        const existing = this.sessions.get(name);
        if (existing) {
            return existing;
        }
        const context = await (await this.launch()).newContext({ viewport: { width, height } });
        await context.route("**/*", route => this.origins.has(new URL(route.request().url()).origin) ? route.continue() : route.abort("blockedbyclient"));
        await context.routeWebSocket("**/*", async socket => {
            const origin = new URL(socket.url().replace(/^ws/, "http")).origin;
            if (!this.origins.has(origin)) {
                await socket.close({ code: 1008, reason: "只能连接当前受管服务" });
                return;
            }
            socket.connectToServer();
        });
        const page = await context.newPage();
        page.setDefaultTimeout(10000);
        const session: BrowserSession = {
            context,
            page,
            console: [],
            network: [],
            pending: new Set(),
            lastInteractionAt: 0
        };
        page.on("console", message => session.console.push(`${message.type()}: ${message.text()}`));
        page.on("pageerror", error => session.console.push(`pageerror: ${error.message}`));
        page.on("requestfailed", request => session.console.push(`requestfailed: ${request.url()} ${request.failure()?.errorText}`));
        page.on("websocket", socket => {
            socket.on("framereceived", frame => this.captureSocketFrame(session, socket.url(), "WS_RECEIVE", frame.payload));
            socket.on("framesent", frame => this.captureSocketFrame(session, socket.url(), "WS_SEND", frame.payload));
        });
        page.on("response", response => {
            if (!["xhr", "fetch"].includes(response.request().resourceType())) {
                return;
            }
            const pending = this.captureResponse(session, response);
            session.pending.add(pending);
            void pending.finally(() => session.pending.delete(pending));
        });
        this.sessions.set(name, session);
        return session;
    }

    /** 保存真实长连接收发内容，消息验收不只依赖页面截图 */
    private captureSocketFrame(session: BrowserSession, url: string, method: string, payload: string | Buffer): void {
        session.network.push({
            url,
            method,
            status: 101,
            body: typeof payload === "string" ? payload : payload.toString("base64"),
            requestBody: null,
            timestamp: Date.now()
        });
    }

    /** 记录真实 API 响应，读取失败也保留可解释的错误 */
    private async captureResponse(session: BrowserSession, response: import("playwright-core").Response): Promise<void> {
        let body: string;
        try {
            body = await response.text();
        } catch (error) {
            body = `响应体未读取：${String(error)}`;
        }
        session.network.push({
            url: response.url(),
            method: response.request().method(),
            status: response.status(),
            body,
            requestBody: response.request().postData(),
            timestamp: response.request().timing().startTime
        });
    }

    /** 执行浏览器观察与交互，断言结果来自真实页面及网络 */
    async perform(input: BrowserAction): Promise<Record<string, unknown>> {
        const name = input.context ?? "default";
        const observations = ["snapshot", "network", "console", "screenshot", "assert_visible", "assert_text", "assert_count", "assert_enabled", "assert_layout", "assert_response"];
        if (!this.sessions.has(name) && observations.includes(input.action)) {
            throw new Error("尚无隔离浏览器上下文，请先 open 或 navigate；只读观察不会自动启动浏览器");
        }
        if (!this.sessions.has(name) && input.action === "close") {
            return { success: true, context: name };
        }
        const session = await this.session(name, input.width, input.height);
        const page = session.page;
        const origin = input.url && input.action === "navigate" ? new URL(input.url).origin : page.url() === "about:blank" ? undefined : new URL(page.url()).origin;
        if (origin && input.action !== "close") {
            await this.checkVersion?.(origin);
        }
        const timeout = Math.min(input.timeoutMs ?? 10000, 30000);
        if (input.width) {
            await page.setViewportSize({ width: input.width, height: input.height ?? 900 });
        }
        if (["click", "press"].includes(input.action)) {
            session.lastInteractionAt = Date.now();
        }
        switch (input.action) {
            case "open": return { success: true, context: input.context ?? "default" };
            case "navigate": return this.navigate(page, input.url ?? "");
            case "fill": await page.locator(input.selector ?? "").fill(input.text ?? "", { timeout }); break;
            case "click": await page.locator(input.selector ?? "").click({ timeout }); break;
            case "press": await page.locator(input.selector ?? "").press(input.key ?? "Enter", { timeout }); break;
            case "wait": await page.locator(input.selector ?? "").waitFor({ state: "visible", timeout }); break;
            case "assert_visible":
                await page.locator(input.selector ?? "").waitFor({ state: "visible", timeout });
                return { success: true, selector: input.selector };
            case "assert_text": return this.assertText(page, input, timeout);
            case "assert_layout": {
                const layout = await this.layout(page);
                return { success: !layout.horizontalOverflow, layout };
            }
            case "assert_count": {
                const actual = await page.locator(input.selector ?? "").count();
                return {
                    success: typeof input.expected === "number" && actual === input.expected,
                    expected: input.expected,
                    actual,
                    selector: input.selector
                };
            }
            case "assert_enabled": {
                const actual = await page.locator(input.selector ?? "").isEnabled({ timeout });
                return {
                    success: typeof input.expected === "boolean" && actual === input.expected,
                    expected: input.expected,
                    actual,
                    selector: input.selector
                };
            }
            case "assert_response": return this.assertResponse(session, input);
            case "network": await Promise.all([...session.pending]); return { success: true, responses: session.network };
            case "console": return { success: true, messages: session.console };
            case "snapshot": return {
                success: true,
                url: page.url(),
                html: await page.locator("body").innerHTML(),
                text: await page.locator("body").innerText(),
                layout: await this.layout(page)
            };
            case "screenshot": return this.screenshot(page);
            case "close": await session.context.close(); this.sessions.delete(input.context ?? "default"); break;
            default: throw new Error(`未知浏览器操作：${input.action}`);
        }
        return {
            success: true,
            action: input.action,
            url: page.url(),
            selector: input.selector
        };
    }

    /** 支持精确空文本，删除与重加流程可以确定旧消息已经消失 */
    private async assertText(page: Page, input: BrowserAction, timeout: number): Promise<Record<string, unknown>> {
        const deadline = Date.now() + timeout;
        let actual = "";
        let success = false;
        do {
            actual = await page.locator(input.selector ?? "").innerText({ timeout: Math.max(1, deadline - Date.now()) });
            success = typeof input.text === "string" && (input.exact ? actual === input.text : Boolean(input.text) && actual.includes(input.text));
            if (!success) {
                await delay(100);
            }
        } while (!success && Date.now() < deadline);
        return {
            success,
            selector: input.selector,
            expected: input.text,
            actual,
            exact: input.exact ?? false
        };
    }

    /** 检查导航地址属于当前隔离服务 */
    private async navigate(page: Page, url: string): Promise<Record<string, unknown>> {
        if (!this.origins.has(new URL(url).origin)) {
            throw new Error("浏览器只能访问本任务受管服务，不能把外部环境当作隔离测试");
        }
        const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
        return {
            success: Boolean(response && response.status() < 400),
            url: page.url(),
            status: response?.status()
        };
    }

    /** 对实际响应字段作严格比较，不根据 HTTP 200 推断业务成功 */
    private async assertResponse(session: BrowserSession, input: BrowserAction): Promise<Record<string, unknown>> {
        const deadline = Date.now() + Math.min(input.timeoutMs ?? 10000, 30000);
        let response: BrowserSession["network"][number] | undefined;
        do {
            await Promise.all([...session.pending]);
            response = [...session.network].reverse().find(item => item.url.includes(input.url ?? "") && item.timestamp >= session.lastInteractionAt);
            if (response) {
                break;
            }
            await delay(50);
        } while (Date.now() < deadline);
        if (!input.jsonPath || input.expected === undefined) {
            return { success: false, error: "需要真实响应、jsonPath 与 expected 才能执行业务断言" };
        }
        if (!response) {
            return {
                success: false,
                reason: "操作后未观察到对应的真实响应",
                url: input.url
            };
        }
        let actual: unknown;
        try {
            actual = JSON.parse(response.body);
        } catch {
            return {
                success: false,
                response,
                reason: "实际响应不是预期的 JSON 业务结果"
            };
        }
        const segments = input.jsonPath.replace(/^\$\.?/, "").replace(/\[(\d+)\]/g, ".$1").split(".").filter(Boolean);
        for (const part of segments) {
            if (Array.isArray(actual) && /^\d+$/.test(part)) {
                actual = actual[Number(part)];
                continue;
            }
            if (!isToolRecord(actual) || ["__proto__", "constructor", "prototype"].includes(part)) {
                actual = undefined;
                break;
            }
            actual = actual[part];
        }
        return {
            success: JSON.stringify(actual) === JSON.stringify(input.expected),
            response,
            jsonPath: input.jsonPath,
            expected: input.expected,
            actual
        };
    }

    /** 在当前视口生成原始截图 */
    private async screenshot(page: Page): Promise<Record<string, unknown>> {
        await fs.mkdir(this.directory, { recursive: true });
        const imagePath = path.join(this.directory, `${randomUUID()}.png`);
        await page.screenshot({
            path: imagePath,
            fullPage: true,
            timeout: 30000
        });
        return {
            success: true,
            imagePath,
            viewport: page.viewportSize(),
            url: page.url(),
            layout: await this.layout(page)
        };
    }

    /** 读取页面实际尺寸，避免仅凭截图猜测是否存在横向溢出 */
    private async layout(page: Page): Promise<{ clientWidth: number; scrollWidth: number; scrollHeight: number; horizontalOverflow: boolean }> {
        return page.evaluate(() => {
            const clientWidth = document.documentElement.clientWidth;
            const scrollWidth = Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth ?? 0);
            return {
                clientWidth,
                scrollWidth,
                scrollHeight: document.documentElement.scrollHeight,
                horizontalOverflow: scrollWidth > clientWidth + 1
            };
        });
    }

    /** 只关闭当前任务创建的浏览器实例 */
    async close(): Promise<void> {
        await this.browser?.close();
        this.browser = undefined;
        this.sessions.clear();
    }
}
