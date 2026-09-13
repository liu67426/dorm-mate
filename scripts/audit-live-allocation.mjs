import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const envId = process.argv[2] || process.env.CLOUDBASE_ENV_ID;
if (!envId) throw new Error("请提供 CloudBase 环境 ID");

const cliPath = path.join(projectDir, "node_modules", "@cloudbase", "cli", "bin", "tcb");
const sql = `SELECT json_build_object(
  'students', COALESCE((SELECT json_agg(row_to_json(item)) FROM dorm_students item), '[]'::json),
  'surveys', COALESCE((SELECT json_agg(row_to_json(item)) FROM dorm_surveys item), '[]'::json),
  'groups', COALESCE((SELECT json_agg(row_to_json(item)) FROM dorm_groups item), '[]'::json),
  'rooms', COALESCE((SELECT json_agg(row_to_json(item)) FROM dorm_rooms item), '[]'::json)
)::text AS snapshot;`;
const command = spawnSync(process.execPath, [cliPath, "db", "execute", "-e", envId, "--sql", sql, "--json"], {
  cwd: projectDir,
  encoding: "utf8",
  maxBuffer: 20 * 1024 * 1024
});
if (command.status !== 0) throw new Error(command.stderr || command.stdout || "读取云端数据失败");
const output = command.stdout.slice(command.stdout.indexOf("{"));
const response = JSON.parse(output);
const row = JSON.parse(response.data.Rows[0]);
const snapshot = JSON.parse(row[0]);

let savePayload = null;
const window = {
  DORM_CONFIG: { mode: "cloud", envId },
  DormAllocation: require(path.join(projectDir, "shared", "allocation-core.js")),
  cloudbase: {
    init: () => ({
      rdb: () => ({
        rpc: async (name, params) => {
          if (name === "dorm_admin_snapshot") return { data: snapshot };
          if (name === "dorm_save_allocation") {
            savePayload = params;
            return { data: { auditedOnly: true } };
          }
          throw new Error(`只读模拟不允许调用：${name}`);
        }
      })
    })
  }
};
const context = vm.createContext({ window, localStorage: {}, crypto, console });
vm.runInContext(fs.readFileSync(path.join(projectDir, "shared", "api.js"), "utf8"), context);
const result = await window.DormApi.runAllocation("all");

const eligibleIds = new Set(snapshot.students.filter((student) => ["1", "2", "3", "4"].includes(student.class_id) && student.survey_completed).map((student) => student.id));
const accountedIds = [...result.rooms.flatMap((room) => room.members.map((member) => member.id)), ...result.pending.map((student) => student.id)];
const uniqueAccountedIds = new Set(accountedIds);
const mixedGenderRooms = result.rooms.filter((room) => new Set(room.members.map((member) => snapshot.students.find((student) => student.id === member.id)?.gender)).size > 1).length;
const missingCount = [...eligibleIds].filter((id) => !uniqueAccountedIds.has(id)).length;
const duplicateCount = accountedIds.length - uniqueAccountedIds.size;
const pendingByReason = result.pending.reduce((counts, student) => {
  const reason = student.reason || "未注明原因";
  counts[reason] = (counts[reason] || 0) + 1;
  return counts;
}, {});
const pendingByCohort = result.pending.reduce((counts, student) => {
  const key = `${student.classId || "未知班级"}-${student.gender || "未知性别"}`;
  counts[key] = (counts[key] || 0) + 1;
  return counts;
}, {});

const destinations = new Map();
result.rooms.forEach((room,index) => room.members.forEach(member => destinations.set(member.id, `room:${index}`)));
result.pending.forEach(student => destinations.set(student.id, "pending"));
const splitGroups = snapshot.groups.filter(group => group.status !== "rejected" && (group.member_ids || []).length >= 2 &&
  group.member_ids.every(id => eligibleIds.has(id))).filter(group =>
  new Set(group.member_ids.map(id => destinations.get(id))).size > 1).length;
const report = {
  mode: "只读模拟，未写入云端",
  version: result.version,
  completedSurveys: eligibleIds.size,
  suggestedRooms: result.rooms.length,
  suggestedStudents: result.rooms.reduce((sum, room) => sum + room.members.length, 0),
  pendingStudents: result.pending.length,
  pendingByReason,
  pendingByCohort,
  accountedStudents: uniqueAccountedIds.size,
  missingCount,
  duplicateCount,
  mixedGenderRooms,
  splitGroups,
  saveWasIntercepted: Boolean(savePayload)
};
console.log(JSON.stringify(report, null, 2));
if (missingCount || duplicateCount || mixedGenderRooms || splitGroups || uniqueAccountedIds.size !== eligibleIds.size) process.exitCode = 1;
