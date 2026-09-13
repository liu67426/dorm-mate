import { readFile } from "node:fs/promises";
import crypto from "node:crypto";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(scriptDir, "..");

// 用法：node scripts/import-students.mjs [名单.csv] [--dry-run]
// 名单格式与 data/students-template.csv 一致：
//   classId,className,classCode,studentId,name,gender
const args = process.argv.slice(2).filter((item) => item !== "--");
const dryRun = args.includes("--dry-run");
const csvArg = args.find((item) => !item.startsWith("--"));
const csvPath = path.resolve(projectDir, csvArg || "data/students.csv");
const BATCH_SIZE = 100;

function parseEnv(text) {
  return Object.fromEntries(text.split(/\r?\n/).map((line) => line.match(/^([A-Z0-9_]+)=(.*)$/)).filter(Boolean).map((match) => [match[1], match[2].trim().replace(/^['"]|['"]$/g, "")]));
}

// 支持带引号字段（字段内可含逗号、换行、双引号转义）。
function parseCsv(text) {
  text = text.replace(/^\uFEFF/, "");
  const rows = [];
  let row = [], field = "", inQuotes = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (inQuotes) {
      if (character === '"') {
        if (text[index + 1] === '"') { field += '"'; index += 1; }
        else inQuotes = false;
      } else field += character;
      continue;
    }
    if (character === '"') { inQuotes = true; continue; }
    if (character === ",") { row.push(field); field = ""; continue; }
    if (character === "\n" || character === "\r") {
      if (character === "\r" && text[index + 1] === "\n") index += 1;
      row.push(field); field = "";
      if (row.some((value) => value.trim() !== "")) rows.push(row);
      row = [];
      continue;
    }
    field += character;
  }
  row.push(field);
  if (row.some((value) => value.trim() !== "")) rows.push(row);
  return rows;
}

function fail(message) {
  console.error(`✖ ${message}`);
  process.exit(1);
}

const csvText = await readFile(csvPath, "utf8").catch(() => fail(`没有找到名单文件：${csvPath}（可用 --参数 指定其他路径）`));
const rows = parseCsv(csvText);
if (rows.length < 2) fail("名单内容为空或只有表头。请参照 data/students-template.csv 填写。");

const header = rows[0].map((value) => value.trim());
const required = ["classId", "className", "classCode", "studentId", "name", "gender"];
const missing = required.filter((column) => !header.includes(column));
if (missing.length) fail(`表头缺少列：${missing.join("、")}。请保持与 data/students-template.csv 相同的表头。`);
const columnOf = (name) => header.indexOf(name);

const students = [];
const problems = [];
rows.slice(1).forEach((row, rowIndex) => {
  const line = rowIndex + 2;
  const record = Object.fromEntries(required.map((name) => [name, (row[columnOf(name)] ?? "").trim()]));
  for (const name of required) if (!record[name]) problems.push(`第${line}行：${name} 为空`);
  if (!["1", "2", "3", "4"].includes(record.classId)) problems.push(`第${line}行：classId 必须是 1/2/3/4，当前为“${record.classId}”`);
  if (!["男", "女"].includes(record.gender)) problems.push(`第${line}行：gender 必须是 男或女，当前为“${record.gender}”`);
  students.push(record);
});

const seenIds = new Map();
students.forEach((record, index) => {
  if (seenIds.has(record.studentId)) problems.push(`学号重复：${record.studentId}（第${seenIds.get(record.studentId)}行与第${index + 2}行）`);
  else seenIds.set(record.studentId, index + 2);
});
if (problems.length) {
  console.error(`✖ 名单有 ${problems.length} 处问题，未导入任何数据：`);
  problems.slice(0, 20).forEach((problem) => console.error(`  - ${problem}`));
  if (problems.length > 20) console.error(`  ...其余 ${problems.length - 20} 条省略`);
  process.exit(1);
}

function sqlValue(text) { return `'${String(text).replace(/'/g, "''")}'`; }

function buildInsert(batch) {
  const values = batch.map((record) => `(${sqlValue(crypto.randomUUID())}, ${sqlValue(record.classId)}, ${sqlValue(record.className)}, ${sqlValue(record.classCode)}, ${sqlValue(record.studentId)}, ${sqlValue(record.name)}, ${sqlValue(record.gender)})`).join(",\n  ");
  return `INSERT INTO public.dorm_students (id, class_id, class_name, class_code, student_id, name, gender) VALUES\n  ${values}\nON CONFLICT (student_id) DO NOTHING;`;
}

const batches = [];
for (let index = 0; index < students.length; index += BATCH_SIZE) batches.push(students.slice(index, index + BATCH_SIZE));

const perClass = {};
students.forEach((record) => {
  perClass[record.classId] ??= { 男: 0, 女: 0 };
  perClass[record.classId][record.gender] += 1;
});
console.log(`名单共 ${students.length} 名学生：`);
Object.keys(perClass).sort().forEach((classId) => {
  const counts = perClass[classId];
  console.log(`  ${classId}班（${students.find((record) => record.classId === classId).className}）：男 ${counts.男} 人、女 ${counts.女} 人`);
});

if (dryRun) {
  console.log("\n-- 试运行模式，不连接云端、不检查部署配置。第一批插入语句预览：");
  console.log(buildInsert(batches[0]).split("\n").slice(0, 4).join("\n") + "\n  ...");
  console.log(`\n共将执行 ${batches.length} 个批次。去掉 --dry-run 参数后正式导入。`);
  process.exit(0);
}

const envText = await readFile(path.join(projectDir, ".env.local"), "utf8").catch(() => {
  fail("没有找到 .env.local。请先复制 .env.example 为 .env.local 并填写 CLOUDBASE_ENV_ID。");
});
const envId = process.env.CLOUDBASE_ENV_ID || parseEnv(envText).CLOUDBASE_ENV_ID;
if (!envId) fail(".env.local 中缺少 CLOUDBASE_ENV_ID");
const cloudbaseCli = path.join(projectDir, "node_modules", "@cloudbase", "cli", "bin", "tcb");
let done = 0;
for (const batch of batches) {
  const result = spawnSync(process.execPath, [cloudbaseCli, "db", "execute", "-e", envId, "--sql", buildInsert(batch), "--json"], { cwd: projectDir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 10 * 1024 * 1024 });
  if (result.status !== 0) {
    process.stderr.write(result.stdout || "");
    process.stderr.write(result.stderr || "");
    fail(`导入失败在已完成 ${done}/${students.length} 人处。请检查网络后重试；已导入的学号不会重复插入。`);
  }
  done += batch.length;
  console.log(`  已处理 ${done}/${students.length}`);
}

console.log(`\n✔ 导入完成。重复学号会被自动跳过，不影响已绑定账号和已完成的问卷。`);
console.log(`后续要更正个别学生信息时，可在 CloudBase 控制台“数据库”中直接修改 dorm_students 表，或重新执行本脚本只补录新学生。`);
