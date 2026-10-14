import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(scriptDir, "..");
const distDir = path.join(projectDir, "dist");
if (path.dirname(distDir) !== projectDir || path.basename(distDir) !== "dist") throw new Error("构建目录不在项目根目录内");

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

let envId = String(process.env.CLOUDBASE_ENV_ID || "").trim();
// 防呆：忘改 .env.example 里的中文占位符时，不把垃圾环境 ID 构建成“云端模式”。
if (/[\u4e00-\u9fff]/.test(envId)) {
  console.warn("提示：CLOUDBASE_ENV_ID 仍是中文占位符，本次构建使用本机演示模式。正式部署前请在 .env.local 填写真实环境 ID。");
  envId = "";
}
const region = String(process.env.CLOUDBASE_REGION || "ap-shanghai").trim();
const adminUsername = String(process.env.CLOUDBASE_ADMIN_USERNAME || "counselor").trim();
let schools = {};
if (process.env.DORM_SCHOOLS_JSON) {
  const parsed = JSON.parse(process.env.DORM_SCHOOLS_JSON);
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object" || !Object.keys(parsed).length) throw new Error("DORM_SCHOOLS_JSON 必须是非空的学校配置对象");
  const environments = new Set();
  schools = Object.fromEntries(Object.entries(parsed).map(([code, item]) => {
    if (!/^[a-z0-9_-]{3,32}$/.test(code)) throw new Error(`学校代号不合法：${code}`);
    if (!item || typeof item !== "object" || typeof item.name !== "string" || !item.name.trim() || typeof item.envId !== "string" || !item.envId.trim()) throw new Error(`学校 ${code} 缺少名称或云环境 ID`);
    const schoolEnvId = item.envId.trim();
    if (/[\s\u4e00-\u9fff]/.test(schoolEnvId)) throw new Error(`学校 ${code} 的云环境 ID 不合法`);
    if (environments.has(schoolEnvId)) throw new Error(`多个学校指向同一云环境：${schoolEnvId}`);
    environments.add(schoolEnvId);
    return [code, { name: item.name.trim(), envId: schoolEnvId, region: item.region || region, adminUsername: item.adminUsername || adminUsername }];
  }));
}
// 配置核验通过后才重建 dist；错误学校映射不能破坏上一次可用的构建产物。
await rm(distDir, { recursive: true, force: true });
await mkdir(distDir, { recursive: true });
await cp(path.join(projectDir, "index.html"), path.join(distDir, "index.html"));
await cp(path.join(projectDir, "student"), path.join(distDir, "student"), { recursive: true });
await cp(path.join(projectDir, "admin"), path.join(distDir, "admin"), { recursive: true });
await cp(path.join(projectDir, "shared"), path.join(distDir, "shared"), { recursive: true });
await mkdir(path.join(distDir, "data"), { recursive: true });
await cp(path.join(projectDir, "data", "students-template.csv"), path.join(distDir, "data", "students-template.csv"));
await cp(path.join(projectDir, "data", "students-demo-template.csv"), path.join(distDir, "data", "students-demo-template.csv"));
await cp(path.join(projectDir, "data", "rooms-template.csv"), path.join(distDir, "data", "rooms-template.csv"));
const configPath = path.join(distDir, "shared", "config.js");
const config = `window.DORM_CONFIG = ${JSON.stringify({
  mode: envId || Object.keys(schools).length ? "cloud" : "mock",
  envId,
  region,
  functionName: "dorm-api",
  adminUsername,
  schools
}, null, 2)};\n`;
await writeFile(configPath, config, "utf8");

const landing = await readFile(path.join(distDir, "index.html"), "utf8");
if (!landing.includes("student/") || !landing.includes("admin/")) throw new Error("网站入口文件不完整，停止构建");
console.log(`静态网站已构建到：${distDir}`);
console.log(Object.keys(schools).length ? `多校联网模式：${Object.keys(schools).length}所学校` : envId ? `单校联网模式：${envId}` : "本机演示模式：尚未填写 CloudBase 环境 ID");
