import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const upgradeFiles = ["013_multi_school_initialization.sql", "014_room_capacity_guard.sql"];
const dryRun = process.argv.includes("--dry-run");

function splitSql(source) {
  const statements = [];
  let current = "", inDollarBlock = false;
  for (let index = 0; index < source.length; index += 1) {
    if (source.slice(index, index + 2) === "$$") {
      inDollarBlock = !inDollarBlock;
      current += "$$";
      index += 1;
    } else {
      const character = source[index];
      current += character;
      if (character === ";" && !inDollarBlock) { statements.push(current.trim()); current = ""; }
    }
  }
  if (inDollarBlock) throw new Error("SQL 文件中的 $$ 没有成对闭合");
  if (current.trim()) statements.push(current.trim());
  return statements.filter(Boolean);
}

const envFile = await readFile(path.join(projectDir, ".env.local"), "utf8").catch(() => "");
const envMatch = envFile.match(/^CLOUDBASE_ENV_ID=(.*)$/m);
const envId = process.env.CLOUDBASE_ENV_ID || envMatch?.[1]?.trim().replace(/^['"]|['"]$/g, "");
if (!envId) throw new Error("缺少 CLOUDBASE_ENV_ID；只对明确指定的一个环境执行安全升级");

const statements = [];
for (const name of upgradeFiles) {
  const source = await readFile(path.join(projectDir, "database", name), "utf8");
  for (const sql of splitSql(source)) statements.push({ name, sql });
}
console.log(`目标环境：${envId}；仅执行 ${upgradeFiles.join("、")}，共${statements.length}条语句。`);
if (dryRun) {
  console.log("试运行结束：未连接云端，也未改动数据库。");
  process.exit(0);
}

const cli = path.join(projectDir, "node_modules", "@cloudbase", "cli", "bin", "tcb");
for (let index = 0; index < statements.length; index += 1) {
  const { name, sql } = statements[index];
  const result = spawnSync(process.execPath, [cli, "db", "execute", "-e", envId, "--sql", sql, "--json"],
    { cwd: projectDir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 10 * 1024 * 1024 });
  if (result.status !== 0) {
    process.stderr.write(result.stdout || "");
    process.stderr.write(result.stderr || "");
    throw new Error(`${name} 第${index + 1}条语句失败；请核对后重试，未执行其他旧版迁移`);
  }
  console.log(`升级进度：${index + 1}/${statements.length}（${name}）`);
}
console.log("安全升级已执行。下一步仍须用测试账号和测试名单验收，不能只凭此输出宣布上线。");
