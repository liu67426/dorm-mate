"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const projectDir = path.resolve(__dirname, "..");
const studentHtml = fs.readFileSync(path.join(projectDir, "student", "index.html"), "utf8");
const adminHtml = fs.readFileSync(path.join(projectDir, "admin", "index.html"), "utf8");
const adminSource = fs.readFileSync(path.join(projectDir, "admin", "app.js"), "utf8");
const functionSource = fs.readFileSync(path.join(projectDir, "cloudfunctions", "dorm-api", "index.js"), "utf8");
const apiSource = fs.readFileSync(path.join(projectDir, "shared", "api.js"), "utf8");
const joinRequestSql = fs.readFileSync(path.join(projectDir, "database", "005_join_requests.sql"), "utf8");
const groupIntegritySql = fs.readFileSync(path.join(projectDir, "database", "007_group_integrity.sql"), "utf8");
const functionAllocationSource = fs.readFileSync(path.join(projectDir, "cloudfunctions", "dorm-api", "lib", "allocation-core.js"), "utf8");
const roommateHighlightsSql = fs.readFileSync(path.join(projectDir, "database", "009_roommate_priority_highlights.sql"), "utf8");
const matchViewStudentRoleSql = fs.readFileSync(path.join(projectDir, "database", "010_match_view_student_role.sql"), "utf8");
const resetBindingSql = fs.readFileSync(path.join(projectDir, "database", "011_admin_reset_student_binding.sql"), "utf8");

test("学生问卷字段都能被云函数保存", () => {
  const formHtml = studentHtml.match(/<form[\s\S]*?<\/form>/)?.[0] || "";
  const formNames = [...formHtml.matchAll(/name="([A-Za-z][A-Za-z0-9]*)"/g)].map((match) => match[1]);
  const allowedBlock = functionSource.match(/const ALLOWED_ANSWER_KEYS = new Set\(\[([\s\S]*?)\]\);/)?.[1] || "";
  const allowedNames = new Set([...allowedBlock.matchAll(/"([A-Za-z][A-Za-z0-9]*)"/g)].map((match) => match[1]));
  const missing = [...new Set(formNames)].filter((name) => !allowedNames.has(name));
  assert.deepEqual(missing, []);
});

test("吸烟问题采用习惯与接受程度，不出现风险标签", () => {
  assert.match(studentHtml, /name="smoking"/);
  assert.match(studentHtml, /name="smokeTolerance"/);
  assert.doesNotMatch(`${studentHtml}\n${functionSource}`, /吸烟风险|风险标签|违规人员/);
});

test("特殊床位需求是单独字段", () => {
  assert.match(studentHtml, /name="bedNeed"/);
  assert.match(studentHtml, /申请下铺/);
  assert.match(studentHtml, /申请无障碍床位/);
});

test("联网版会显示正式联网与隐私用途说明", () => {
  assert.match(studentHtml, /当前是正式联网版/);
  assert.match(studentHtml, /只用于室友匹配和住宿安排/);
  assert.match(studentHtml, /id="environment-badge"/);
});

test("提交前会清理身份字段首尾空格并补齐两位填写码", async () => {
  const storage = new Map();
  const sandbox = {
    window: { DORM_CONFIG: { mode: "mock", envId: "" } },
    localStorage: {
      getItem(key) { return storage.get(key) || null; },
      setItem(key, value) { storage.set(key, value); }
    },
    crypto: { randomUUID() { return "test-uuid"; } },
    Date,
    JSON,
    console
  };
  vm.runInNewContext(apiSource, sandbox);
  await sandbox.window.DormApi.submitSurvey({ className: " 工业机器人4班 ", classCode: "4", name: " 示例同学 ", studentId: " 2026000100 " });
  const saved = JSON.parse(storage.get("dorm-networked-mock-v1")).surveys[0];
  assert.deepEqual(
    { className: saved.className, classCode: saved.classCode, name: saved.name, studentId: saved.studentId },
    { className: "工业机器人4班", classCode: "04", name: "示例同学", studentId: "2026000100" }
  );
});

test("单人可以申请加入同班同性别的2人或3人组", () => {
  assert.match(studentHtml, /申请加入缺员小组/);
  assert.match(studentHtml, /刷新云端组队状态/);
  assert.match(studentHtml, /正在读取云端最新组队信息/);
  assert.match(apiSource, /dorm_request_join_group/);
  assert.match(joinRequestSql, /candidate_group\.class_id = v_student\.class_id/);
  assert.match(joinRequestSql, /member\.gender IS DISTINCT FROM v_student\.gender/);
  assert.match(joinRequestSql, /cardinality\(candidate_group\.member_ids\) BETWEEN 2 AND 3/);
});

test("加入申请必须由目标小组现有成员处理且满员后停止", () => {
  assert.match(joinRequestSql, /v_responder\.id = ANY\(v_target_group\.member_ids\)/);
  assert.match(joinRequestSql, /cardinality\(v_target_group\.member_ids\) >= 4/);
  assert.match(joinRequestSql, /GROUP_JOIN_ACCEPT/);
});

test("已完成问卷刷新后自动恢复意向确认与组队中心", () => {
  assert.match(studentHtml, /restoreCompletedWorkspace/);
  assert.match(studentHtml, /state\.student\|\|!state\.surveyCompleted/);
  assert.match(studentHtml, /mobile-step-name.*意向确认/);
  assert.match(studentHtml, /group-center.*classList\.add\("show"\)/);
});

test("学生只查看寝室号和室友，不开放在线选床位", () => {
  assert.match(studentHtml, /住宿结果尚未发布/);
  assert.match(studentHtml, /查看寝室号和室友/);
  assert.doesNotMatch(studentHtml, /data-bed/);
  assert.doesNotMatch(apiSource, /dorm_choose_bed/);
});

test("辅导员可以直接查看特殊住宿情况和学生补充说明", () => {
  assert.match(adminHtml, /id="open-special"/);
  assert.match(adminHtml, /id="show-special"/);
  assert.match(adminHtml, /特殊住宿情况/);
  assert.match(apiSource, /bedNeed,/);
  assert.match(apiSource, /specialNote:/);
  assert.match(adminSource, /student\.specialNote/);
  assert.match(adminSource, /openSpecialSituations/);
});

test("辅导员正式工作台不再显示名单尚未导入", () => {
  assert.match(adminHtml, /正式名单已导入/);
  assert.match(adminHtml, /id="roster-notice-title"/);
  assert.match(adminSource, /正式名单已导入.*summary\.total/);
  assert.doesNotMatch(adminHtml, /正式名单尚未导入|>待导入</);
});

test("分寝建议显示已填、已入寝、待处理和人数核对", () => {
  assert.match(adminHtml, /id="allocation-counts"/);
  assert.match(adminSource, /已完成问卷/);
  assert.match(adminSource, /已进入寝室建议/);
  assert.match(adminSource, /待辅导员处理/);
  assert.match(adminSource, /missingCount/);
  assert.match(functionSource, /reviewPending/);
  assert.match(apiSource, /reviewPending/);
  assert.match(functionAllocationSource, /members: unit\.members/);
});

test("辅导员端说明吸烟接受范围属于严格匹配条件", () => {
  assert.match(adminHtml, /不同组队之间严格尊重双方填写的烟味接受范围/);
  assert.match(adminHtml, /原确认组内部若已有冲突，系统保留组队并显示复核提醒/);
});

test("核心生活问卷字段都会转换为自动匹配特征", () => {
  const featureBlock = apiSource.match(/function featureStudent[\s\S]*?\n  }\n\n  async function runAllocation/)?.[0] || "";
  const cloudFeatureBlock = functionSource.match(/function featureStudent[\s\S]*?\n}\n\nasync function adminAllocate/)?.[0] || "";
  const expectedAnswerKeys = [
    "bedTime", "wakeTime", "weekendShift", "alarm", "nap", "sleepDepth", "afterLights",
    "gamer", "gameHours", "gamePeriod", "voiceChat", "audioDevice", "excitedNoise", "lateRank", "mechanicalKeyboard",
    "smoking", "smokeTolerance", "snoring", "temperature", "coldSensitive", "speaker", "calls", "soundSensitivity", "smellSensitivity",
    "cleanliness", "cleanParticipation", "trash", "laundry", "borrow", "foodShare", "sharedItems",
    "studyInDorm", "socialStyle", "visitors", "visitorTolerance", "quietHours", "weekendActivity",
    "hobbies", "gameGenre", "conflictStyle", "dealbreakers", "priority1", "priority2", "priority3"
  ];
  expectedAnswerKeys.forEach((key) => {
    assert.match(featureBlock, new RegExp(`answers\\.${key}`), `网页分配缺少字段：${key}`);
    assert.match(cloudFeatureBlock, new RegExp(`answers\\.${key}`), `云函数分配缺少字段：${key}`);
  });
  assert.doesNotMatch(featureBlock, /answers\.gameTitles|answers\.otherNotes/);
});

test("匹配算法使用个人前三项并保留兴趣低权重和底线冲突", () => {
  assert.match(functionAllocationSource, /PRIORITY_FEATURES/);
  assert.match(functionAllocationSource, /priorityBoost/);
  assert.match(functionAllocationSource, /dealbreakerConflict/);
  assert.match(functionAllocationSource, /setDistance/);
  assert.match(functionAllocationSource, /formal-v4/);
});

test("名单重导后会清理小组中的失效成员编号", () => {
  assert.match(groupIntegritySql, /unnest\(g\.member_ids\) WITH ORDINALITY/);
  assert.match(groupIntegritySql, /student\.id = item\.member_id/);
  assert.match(groupIntegritySql, /member_ids <@ confirmed_ids/);
});

test("住宿结果发布后按本人前三项显示舍友的大致情况", () => {
  assert.match(studentHtml, /id="matching-priorities"/);
  assert.match(studentHtml, /舍友在我最看重三项中的概况/);
  assert.match(studentHtml, /不显示舍友的精确时间、完整问卷或补充说明/);
  assert.match(studentHtml, /assignmentState\.priorities/);
  assert.match(studentHtml, /roommateHighlights/);
  assert.match(apiSource, /dorm_student_match_view/);
  assert.match(roommateHighlightsSql, /student\.auth_uid = v_uid/);
  assert.match(roommateHighlightsSql, /run\.status = 'published'/);
  assert.match(roommateHighlightsSql, /roommate\.id <> v_student_id/);
  assert.match(roommateHighlightsSql, /WHEN '吸烟习惯相容'/);
  assert.match(roommateHighlightsSql, /THEN '不抽烟'/);
  assert.match(roommateHighlightsSql, /THEN '早睡型'/);
  assert.doesNotMatch(roommateHighlightsSql, /otherNotes|gameTitles|student_id.*jsonb_build_object/);
  assert.match(roommateHighlightsSql, /REVOKE ALL.*PUBLIC, anon/);
  assert.match(matchViewStudentRoleSql, /GRANT EXECUTE.*TO anon/);
});

test("辅导员发布寝室名单后在线学生会自动收到提示", () => {
  assert.match(studentHtml, /id="publish-alert"/);
  assert.match(studentHtml, /寝室名单已发布/);
  assert.match(studentHtml, /ASSIGNMENT_POLL_MS=60000/);
  assert.match(studentHtml, /setInterval\(checkPublishedAssignment,ASSIGNMENT_POLL_MS\)/);
  assert.match(studentHtml, /visibilitychange/);
  assert.match(studentHtml, /showPublishedAssignmentNotice/);
  assert.match(studentHtml, /dorm-assignment-seen-/);
  assert.match(studentHtml, /stopAssignmentWatcher/);
});

test("等待发布时只读取一次学生状态，发布后再读取舍友概况", () => {
  const stateCall = apiSource.indexOf('const state = await rpc("dorm_student_state", {})');
  const assignmentCheck = apiSource.indexOf("if (state?.assignment)", stateCall);
  const matchCall = apiSource.indexOf('rpc("dorm_student_match_view", {})', assignmentCheck);
  assert.ok(stateCall >= 0);
  assert.ok(assignmentCheck > stateCall);
  assert.ok(matchCall > assignmentCheck);
});

test("辅导员可只解除学生设备绑定且保留业务数据", () => {
  assert.match(adminHtml, /设备绑定/);
  assert.match(adminSource, /data-reset-binding/);
  assert.match(adminSource, /问卷、组队和住宿结果都会保留/);
  assert.match(apiSource, /resetStudentBinding/);
  assert.match(apiSource, /dorm_admin_reset_student_binding/);
  assert.match(resetBindingSql, /NOT EXISTS \(SELECT 1 FROM public\.dorm_admins WHERE uid = v_uid\)/);
  assert.match(resetBindingSql, /FOR UPDATE/);
  assert.match(resetBindingSql, /SET auth_uid = NULL, bound_at = NULL/);
  assert.match(resetBindingSql, /STUDENT_BINDING_RESET/);
  assert.doesNotMatch(resetBindingSql, /DELETE FROM public\.dorm_(surveys|groups|assignments)/);
});

test("学生换设备后可只核验身份恢复原问卷与住宿状态", () => {
  assert.match(studentHtml, /id="recover-device"/);
  assert.match(studentHtml, /换手机或清理浏览器后恢复/);
  assert.match(studentHtml, /DormApi\.recoverStudent/);
  assert.match(studentHtml, /openCompletedWorkspace\(\)/);
  assert.match(apiSource, /async function recoverStudent/);
  assert.match(apiSource, /await bindStudentIdentity\(data\)/);
});

test("CSV导出会中和Excel公式开头", () => {
  assert.match(adminSource, /function csvSafeText\(value\)/);
  assert.match(adminSource, /\[=\+\\-@\]/);
  assert.match(adminSource, /csvSafeText\(cell\)/);
  const functionText = adminSource.match(/function csvSafeText\(value\) \{[^\n]+\}/)?.[0];
  assert.ok(functionText);
  const sandbox = { result: null };
  vm.runInNewContext(`${functionText}; result = [csvSafeText("=1+1"), csvSafeText("  @SUM(A1)"), csvSafeText("普通文字")];`, sandbox);
  assert.deepEqual(Array.from(sandbox.result), ["'=1+1", "'  @SUM(A1)", "普通文字"]);
});
