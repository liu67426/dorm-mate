import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(scriptDir, "..");
const distDir = path.join(projectDir, "dist");

// 直接运行 npm run build 时也读取本机部署配置；已有环境变量优先。
try {
  const localEnv = await readFile(path.join(projectDir, ".env.local"), "utf8");
  localEnv.split(/\r?\n/).forEach((line) => {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!match || Object.hasOwn(process.env, match[1])) return;
    process.env[match[1]] = match[2].trim().replace(/^['"]|['"]$/g, "");
  });
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}

// dist 只包含要公开的网站文件，不把云函数、测试和内部文档上传到静态托管。
await rm(distDir, { recursive: true, force: true });
await mkdir(distDir, { recursive: true });
await cp(path.join(projectDir, "index.html"), path.join(distDir, "index.html"));
await cp(path.join(projectDir, "student"), path.join(distDir, "student"), { recursive: true });
await cp(path.join(projectDir, "admin"), path.join(distDir, "admin"), { recursive: true });
await cp(path.join(projectDir, "shared"), path.join(distDir, "shared"), { recursive: true });

let envId = String(process.env.CLOUDBASE_ENV_ID || "").trim();
// 防呆：忘改 .env.example 里的中文占位符时，不把垃圾环境 ID 构建成“云端模式”。
if (/[\u4e00-\u9fff]/.test(envId)) {
  console.warn("提示：CLOUDBASE_ENV_ID 仍是中文占位符，本次构建使用本机演示模式。正式部署前请在 .env.local 填写真实环境 ID。");
  envId = "";
}
const region = String(process.env.CLOUDBASE_REGION || "ap-shanghai").trim();
const adminUsername = String(process.env.CLOUDBASE_ADMIN_USERNAME || "counselor").trim();
const configPath = path.join(distDir, "shared", "config.js");
const config = `window.DORM_CONFIG = ${JSON.stringify({
  mode: envId ? "cloud" : "mock",
  envId,
  region,
  functionName: "dorm-api",
  adminUsername
}, null, 2)};\n`;
await writeFile(configPath, config, "utf8");

const landing = await readFile(path.join(distDir, "index.html"), "utf8");
if (!landing.includes("student/") || !landing.includes("admin/")) throw new Error("网站入口文件不完整，停止构建");
console.log(`静态网站已构建到：${distDir}`);
console.log(envId ? `联网模式：${envId}` : "本机演示模式：尚未填写 CloudBase 环境 ID");
