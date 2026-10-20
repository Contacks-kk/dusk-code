import express from "express";
import { getAppConfig } from "./config/env";
import { apiRouter } from "./routes";

const config = getAppConfig();
const app = express();

app.use(express.json());

// 注册 API 模块路由
app.use("/api", apiRouter);

/** 启动服务并监听端口 */
function bootstrap(): void {
    app.listen(config.port, () => {
        console.log(`服务已经启动，正在监听端口：http://localhost:${config.port}`);
    });
}

bootstrap();