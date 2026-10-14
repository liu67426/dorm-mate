const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const tenantCore = require("../shared/tenant-core.js");

const config = { mode: "cloud", schools: {
  alpha: { name: "甲校", envId: "env-alpha", adminUsername: "teacher-a" },
  beta: { name: "乙校", envId: "env-beta", adminUsername: "teacher-b" },
  gamma: { name: "丙校", envId: "env-gamma", adminUsername: "teacher-c" }
} };

test("同一网站的三所学校分别选中独立云环境，未知学校不回退到其他环境", () => {
  for (const [code, envId] of [["alpha", "env-alpha"], ["beta", "env-beta"], ["gamma", "env-gamma"]]) {
    assert.equal(tenantCore.resolve(config, `?school=${code}`).envId, envId);
  }
  assert.equal(tenantCore.resolve(config, "?school=unknown"), null);
  assert.equal(tenantCore.resolve(config, ""), null);
});

test("辅导员登录和首次导入只会调用所选学校的云环境", async () => {
  const calls = [];
  const window = { DORM_CONFIG: config, DormTenant: tenantCore, cloudbase: { init({ env }) {
    calls.push(["init", env]);
    return { auth: () => ({ getLoginState: async () => ({}), signOut: async () => {}, signInWithPassword: async ({ username }) => { calls.push(["login", username]); return {}; } }),
      rdb: () => ({ rpc: async (name, params) => { calls.push(["rpc", name, params]); return { data: {} }; } }) };
  } } };
  const sandbox = { window, location: { search: "?school=beta" }, URLSearchParams, localStorage: { getItem: () => null }, console };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../shared/api.js"), "utf8"), sandbox);
  assert.equal(await window.DormApi.adminLogin("test"), true);
  await window.DormApi.initializeSchool([{ studentId: "D001" }], [{ roomNumber: "A101" }]);
  assert.deepEqual(calls.slice(0, 2), [["init", "env-beta"], ["login", "teacher-b"]]);
  assert.equal(calls.filter(item => item[0] === "rpc").at(-1)[1], "dorm_admin_initialize");
  assert.equal(calls.some(item => JSON.stringify(item).includes("env-alpha")), false);
});

test("未知学校无法登录或写入，也不会改用旧单校环境", async () => {
  const window = { DORM_CONFIG: { ...config, envId: "old-pilot" }, DormTenant: tenantCore };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../shared/api.js"), "utf8"),
    { window, location: { search: "?school=unknown" }, URLSearchParams, console });
  await assert.rejects(() => window.DormApi.adminLogin("test"), /请先选择已开通的学校/);
  await assert.rejects(() => window.DormApi.initializeSchool([], []), /请先选择已开通的学校/);
});

test("首次初始化数据库函数必须校验辅导员身份和空环境", () => {
  const sql = fs.readFileSync(path.join(__dirname, "../database/013_multi_school_initialization.sql"), "utf8");
  assert.match(sql, /auth\.uid\(\)/);
  assert.match(sql, /public\.dorm_admins/);
  assert.match(sql, /已有学生或分寝数据，禁止重新初始化/);
  assert.match(sql, /SECURITY DEFINER/);
  assert.match(sql, /dorm_public_classes\(\)/);
  const capacity = fs.readFileSync(path.join(__dirname, "../database/014_room_capacity_guard.sql"), "utf8");
  assert.match(capacity, /FOR UPDATE/);
  assert.match(capacity, /v_occupied >= v_capacity/);
});
