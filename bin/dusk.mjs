#!/usr/bin/env node
import { fileURLToPath, pathToFileURL } from "node:url";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cliEntry = path.resolve(__dirname, "../src/cli.ts");

// 基于当前包位置解析自带 tsx loader 的绝对路径，保证在任意外部工程目录下执行均能正常载入
const require = createRequire(import.meta.url);
const tsxLoaderPath = require.resolve("tsx");
const tsxLoaderUrl = pathToFileURL(tsxLoaderPath).href;

const proc = spawn(process.execPath, ["--import", tsxLoaderUrl, cliEntry, ...process.argv.slice(2)], {
    stdio: "inherit",
    cwd: process.cwd()
});

proc.on("exit", (code) => {
    process.exit(code ?? 0);
});
