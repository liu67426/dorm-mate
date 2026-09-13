import { readFile, readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(scriptDir, "..");

function parseEnv(text) {
  return Object.fromEntries(text.split(/\r?\n/).map((line) => line.match(/^([A-Z0-9_]+)=(.*)$/)).filter(Boolean).map((match) => [match[1], match[2].trim().replace(/^['"]|['"]$/g, "")]));
}

function splitSql(source) {
  const statements = [];
  let current = "";
  let inDollarBlock = false;
  for (let index = 0; index < source.length; index += 1) {
    if (source.slice(index, index + 2) === "$$") {
      inDollarBlock = !inDollarBlock;
      current += "$$";
      index += 1;
      continue;
    }
    const character = source[index];
    current += character;
    if (character === ";" && !inDollarBlock) {
      if (current.trim()) statements.push(current.trim());
      current = "";
    }
  }
  if (current.trim()) statements.push(current.trim());
  if (inDollarBlock) throw new Error("SQL 文件中的 $$ 没有成对闭合");
  return statements;
}

const envText = await readFile(path.join(projectDir, ".env.local"), "utf8");
const localEnv = parseEnv(envText);
const envId = process.env.CLOUDBASE_ENV_ID || localEnv.CLOUDBASE_ENV_ID;
if (!envId) throw new Error("缺少 CLOUDBASE_ENV_ID");
const adminUid = process.env.ADMIN_UID || localEnv.ADMIN_UID;
if (!adminUid) throw new Error("缺少 ADMIN_UID（辅导员云开发账号的UID）");
const cloudbaseCli = path.join(projectDir, "node_modules", "@cloudbase", "cli", "bin", "tcb");

const databaseDir = path.join(projectDir, "database");
const sqlFiles = (await readdir(databaseDir)).filter((name) => /^\d+.*\.sql$/i.test(name)).sort();
const statements = [];
for (const file of sqlFiles) {
  const raw = await readFile(path.join(databaseDir, file), "utf8");
  const sql = raw.replaceAll("{{ADMIN_UID}}", adminUid);
  splitSql(sql).forEach((statement) => statements.push({ file, statement }));
}
console.log(`准备向 ${envId} 执行 ${sqlFiles.length} 个迁移文件、共 ${statements.length} 条数据库语句`);

for (let index = 0; index < statements.length; index += 1) {
  const item = statements[index];
  const result = spawnSync(process.execPath, [cloudbaseCli,
    "db", "execute", "-e", envId, "--sql", item.statement, "--json"
  ], { cwd: projectDir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 10 * 1024 * 1024 });
  if (result.status !== 0) {
    process.stderr.write(`失败的迁移文件：${item.file}\n失败的 SQL：\n${item.statement}\n`);
    process.stderr.write(result.stdout || "");
    process.stderr.write(result.stderr || "");
    if (result.error) process.stderr.write(`${result.error.message}\n`);
    throw new Error(`第 ${index + 1} 条数据库语句执行失败`);
  }
  console.log(`数据库进度：${index + 1}/${statements.length}（${item.file}）`);
}

console.log("数据库结构与安全规则已完成");
