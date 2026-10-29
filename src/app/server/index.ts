import express from "express";
import { getAppConfig } from "../../config/env";
import { apiRouter } from "../../routes";

/** 创建并配置 Express Web 应用实例 */
export function createServerApp(): express.Express {
    const app = express();

    app.use(express.json());

    // 注册核心 API 模块路由
    app.use("/api", apiRouter);

    return app;
}

/** 启动 Web 服务并监听端口 */
export function startServer(port?: number): void {
    const config = getAppConfig();
    const listenPort = port ?? config.port;
    const app = createServerApp();

    // 绑定端口并开始监听
    app.listen(listenPort, () => {
        console.log(`Dusk Web 服务已启动，正在监听端口：http://localhost:${listenPort}`);
    });
}
