"use strict";

const crypto = require("node:crypto");
const cloudbase = require("@cloudbase/node-sdk");
const { z } = require("zod");
const allocationCore = require("./lib/allocation-core.js");

const app = cloudbase.init({ env: cloudbase.SYMBOL_CURRENT_ENV });
const pg = app.rdb();

const identitySchema = z.object({
  className: z.string().min(2).max(30),
  classCode: z.string().regex(/^0[1-4]$/),
  name: z.string().min(2).max(30),
  studentId: z.string().min(4).max(30)
});

const ALLOWED_ANSWER_KEYS = new Set([
  "className", "classCode", "name", "studentId", "bedTime", "wakeTime", "weekendShift", "alarm", "nap", "sleepDepth", "afterLights",
  "gamer", "gameDevice", "gameGenre", "gameTitles", "gameHours", "gamePeriod", "voiceChat", "audioDevice", "excitedNoise",
  "lateRank", "mechanicalKeyboard", "smoking", "smokeTolerance", "snoring", "temperature", "coldSensitive", "speaker", "calls",
  "soundSensitivity", "smellSensitivity", "cleanliness", "cleanParticipation", "trash", "showerTime", "laundry", "borrow", "foodShare", "sharedItems",
  "studyInDorm", "visitors", "visitorTolerance", "socialStyle", "quietHours", "weekendActivity", "hobbies", "conflictStyle", "dealbreakers",
  "priority1", "priority2", "priority3", "preferred1", "preferred2", "preferred3", "bedNeed", "otherNotes", "consent"
]);

function ok(data) { return { ok: true, data }; }
function fail(message, code = "BAD_REQUEST") { return { ok: false, code, message }; }

function unwrap(result) {
  if (result?.error) throw new Error(result.error.message || "数据库操作失败");
  return result?.data ?? null;
}

async function rows(query) {
  const data = unwrap(await query);
  if (data == null) return [];
  return Array.isArray(data) ? data : [data];
}

async function first(query) {
  return (await rows(query))[0] || null;
}

async function rpc(name, params) {
  return unwrap(await pg.rpc(name, params));
}

async function callerUid() {
  const auth = typeof app.auth === "function" ? app.auth() : app.auth;
  if (!auth || typeof auth.getUserInfo !== "function") throw new Error("无法读取调用者身份");
  const info = await auth.getUserInfo();
  return info?.uid || info?.user?.uid || info?.openId || info?.openid || null;
}

async function audit(action, uid, entityId, detail = {}) {
  unwrap(await pg.from("dorm_audit_logs").insert({ action, uid, entity_id: entityId || null, detail }));
}

// 按页读取，避免学生人数增长后只取到默认第一页。
async function fetchAll(tableName, pageSize = 500) {
  const all = [];
  for (let offset = 0; ; offset += pageSize) {
    const page = await rows(pg.from(tableName).select("*").range(offset, offset + pageSize - 1));
    all.push(...page);
    if (page.length < pageSize) return all;
  }
}

async function requireAdmin(uid) {
  const configuredUid = process.env.ADMIN_UID;
  if (!configuredUid) throw new Error("云函数尚未配置辅导员UID");
  if (uid !== configuredUid) throw new Error("没有辅导员权限");
}

async function linkedStudent(uid) {
  const student = await first(pg.from("dorm_students").select("*").eq("auth_uid", uid).limit(1));
  if (!student) throw new Error("当前账号尚未通过学生名单核验");
  return student;
}

function sanitizeValue(value) {
  if (Array.isArray(value)) return value.slice(0, 20).map(sanitizeValue);
  if (typeof value === "string") return value.trim().slice(0, 300);
  if (["number", "boolean"].includes(typeof value)) return value;
  return undefined;
}

function sanitizeAnswers(input) {
  const answers = {};
  Object.entries(input || {}).forEach(([key, value]) => {
    if (!ALLOWED_ANSWER_KEYS.has(key)) return;
    const safe = sanitizeValue(value);
    if (safe !== undefined) answers[key] = safe;
  });
  return answers;
}

async function studentLogin(uid, payload) {
  const identity = identitySchema.parse(payload);
  return rpc("dorm_bind_student", {
    p_class_name: identity.className,
    p_class_code: identity.classCode,
    p_name: identity.name,
    p_student_id: identity.studentId,
    p_uid: uid
  });
}

async function submitSurvey(uid, payload) {
  const answers = sanitizeAnswers(payload.answers);
  return rpc("dorm_submit_survey", { p_uid: uid, p_answers: answers });
}

const groupCore = require("./lib/group-core.js");

function publicGroup(group) {
  if (!group) return null;
  return {
    id: group.id,
    classId: group.class_id,
    memberIds: group.member_ids || [],
    confirmedIds: group.confirmed_ids || [],
    status: group.status,
    compatibilityScore: group.compatibility_score == null ? null : Number(group.compatibility_score)
  };
}

async function studentState(uid) {
  const student = await linkedStudent(uid);
  const survey = await first(pg.from("dorm_surveys").select("*").eq("student_id", student.id).limit(1));
  const rawGroup = student.group_id ? await first(pg.from("dorm_groups").select("*").eq("id", student.group_id).limit(1)) : null;
  const invites = await rows(pg.from("dorm_invitations").select("*").eq("to_student_id", student.id).eq("status", "pending"));
  const candidates = await rows(pg.from("dorm_students").select("id,name").eq("class_id", student.class_id).eq("survey_completed", true).is("group_id", null));

  let groupMembers = [];
  if (rawGroup?.member_ids?.length) {
    const members = await rows(pg.from("dorm_students").select("id,name").in("id", rawGroup.member_ids));
    groupMembers = members.map((item) => ({ id: item.id, name: item.name, confirmed: rawGroup.confirmed_ids?.includes(item.id) }));
  }

  const inviterIds = [...new Set(invites.map((invite) => invite.from_student_id))];
  let inviterMap = new Map();
  if (inviterIds.length) {
    const inviters = await rows(pg.from("dorm_students").select("id,name").in("id", inviterIds));
    inviterMap = new Map(inviters.map((item) => [item.id, item.name]));
  }

  return {
    student: { id: student.id, name: student.name, classId: student.class_id },
    surveyCompleted: Boolean(survey?.completed),
    group: publicGroup(rawGroup),
    groupMembers,
    incomingInvites: invites.map((invite) => ({
      id: invite.id,
      groupId: invite.group_id,
      fromStudentId: invite.from_student_id,
      fromStudentName: inviterMap.get(invite.from_student_id) || "同班同学"
    })),
    candidates: candidates.filter((item) => item.id !== student.id)
  };
}

async function inviteStudent(uid, payload) {
  return rpc("dorm_create_invite", {
    p_uid: uid,
    p_candidate_id: String(payload.studentId || ""),
    p_new_group_id: crypto.randomUUID(),
    p_invite_id: crypto.randomUUID()
  });
}

async function respondInvite(uid, payload) {
  return rpc("dorm_respond_invite", {
    p_uid: uid,
    p_invite_id: String(payload.inviteId || ""),
    p_accepted: Boolean(payload.accepted)
  });
}

function summaryFromSurvey(student, survey) {
  const answers = survey?.answers || {};
  return {
    id: student.id,
    classId: student.class_id,
    gender: student.gender,
    name: student.name,
    sid: student.student_id.replace(/.(?=.{4})/g, "*"),
    status: student.survey_completed ? (student.bed_need && student.bed_need !== "无" ? "review" : "completed") : "pending",
    sleep: student.survey_completed ? `${answers.bedTime || "未填"}休息 · ${answers.wakeTime || "未填"}起床` : "未填写",
    game: student.survey_completed ? `${answers.gamer || "未填游戏习惯"} · ${answers.voiceChat || "未填开麦习惯"}` : "未填写",
    smoking: answers.smoking || "未填写",
    tag: student.bed_need && student.bed_need !== "无" ? student.bed_need : (answers.cleanliness ? `整洁程度${answers.cleanliness}` : "已完成问卷")
  };
}

async function adminDashboard(uid, payload) {
  await requireAdmin(uid);
  const [allStudents, surveys, allGroups, roomInventory, assignments] = await Promise.all([
    fetchAll("dorm_students"), fetchAll("dorm_surveys"), fetchAll("dorm_groups"), fetchAll("dorm_rooms"), fetchAll("dorm_assignments")
  ]);
  const surveyMap = new Map(surveys.map((item) => [item.student_id, item]));
  const classMeta = {};
  ["1", "2", "3", "4"].forEach((classId) => {
    const list = allStudents.filter((item) => item.class_id === classId);
    classMeta[classId] = {
      name: list[0]?.class_name || `工业机器人${classId}班`,
      total: list.length,
      male: list.filter((item) => item.gender === "男").length,
      female: list.filter((item) => item.gender === "女").length,
      submitted: list.filter((item) => item.survey_completed).length,
      groups: allGroups.filter((item) => item.class_id === classId && groupCore.classify(item).kind === "complete").length,
      review: list.filter((item) => item.bed_need && item.bed_need !== "无").length,
      maleBeds: roomInventory.filter((item) => item.class_id === classId && item.gender === "男").reduce((sum, item) => sum + Number(item.capacity || 4), 0),
      femaleBeds: roomInventory.filter((item) => item.class_id === classId && item.gender === "女").reduce((sum, item) => sum + Number(item.capacity || 4), 0)
    };
  });
  const filteredStudents = payload.classId && payload.classId !== "all" ? allStudents.filter((item) => item.class_id === payload.classId) : allStudents;
  const filteredGroups = payload.classId && payload.classId !== "all" ? allGroups.filter((item) => item.class_id === payload.classId) : allGroups;
  return {
    classMeta,
    students: filteredStudents.map((student) => summaryFromSurvey(student, surveyMap.get(student.id))),
    groups: filteredGroups.map(publicGroup).map((group) => ({ id: group.id, classId: group.classId, memberIds: group.memberIds, confirmedIds: group.confirmedIds, score: group.compatibilityScore, status: group.status })),
    rooms: roomInventory,
    assignments
  };
}

function sleepCategory(value) {
  const match = String(value || "").match(/^(\d{1,2}):/);
  if (!match) return 2;
  const hour = Number(match[1]);
  if (hour < 6) return hour < 1 ? 2 : 3;
  return hour < 23 ? 1 : 2;
}

function answerList(value) {
  if (Array.isArray(value)) return value.filter(Boolean);
  return value ? [value] : [];
}

function ordinalAnswer(value, options, fallback = 2) {
  const index = options.indexOf(String(value || ""));
  if (index < 0) return fallback;
  return options.length < 2 ? 2 : 1 + (index * 2) / (options.length - 1);
}

function fivePointAnswer(value) {
  const number = Math.max(1, Math.min(5, Number(value || 3)));
  return 1 + (number - 1) / 2;
}

function featureStudent(student, survey) {
  const answers = survey?.answers || {};
  const wake = ordinalAnswer(answers.wakeTime, ["06:30前", "06:30—07:30", "07:30—08:30", "08:30以后"]);
  const weekendShift = ordinalAnswer(answers.weekendShift, ["基本不变", "晚1小时左右", "晚2小时以上"]);
  const alarm = ordinalAnswer(answers.alarm, ["一个闹钟就起", "需要2—3个闹钟", "闹钟经常响很久"]);
  const nap = ordinalAnswer(answers.nap, ["基本不午睡", "偶尔午睡", "经常午睡"]);
  const sleepDepth = ordinalAnswer(answers.sleepDepth, ["睡得较沉", "一般", "声音或灯光容易吵醒"]);
  const afterLights = answerList(answers.afterLights);
  const gameFrequency = ordinalAnswer(answers.gamer, ["不玩游戏", "偶尔玩", "经常玩"], 1);
  const gameHours = ordinalAnswer(answers.gameHours, ["1小时以内", "1—2小时", "2—4小时", "4小时以上"], 1);
  const gamePeriod = ordinalAnswer(answers.gamePeriod, ["白天或傍晚", "21:00以前", "21:00—23:00", "23:00—01:00", "01:00以后"], 1);
  const gamingVoice = ordinalAnswer(answers.voiceChat, ["基本不开麦", "偶尔开麦", "经常开麦", "经常多人语音"], 1);
  const audioDiscipline = ordinalAnswer(answers.audioDevice, ["始终使用耳机", "多数使用耳机", "偶尔外放", "经常外放"], 1);
  const excitedNoise = ordinalAnswer(answers.excitedNoise, ["基本能控制", "偶尔提高音量", "经常大声说话或敲桌"], 1);
  const lateGaming = answers.lateRank ? 3 : 1;
  const mechanicalKeyboard = answers.mechanicalKeyboard ? 3 : 1;
  const gameGenres = answerList(answers.gameGenre);
  const gameDevices = answerList(answers.gameDevice);
  const smokingText = String(answers.smoking || "");
  const toleranceText = String(answers.smokeTolerance || "");
  const snoring = ordinalAnswer(answers.snoring, ["基本不会", "不确定或偶尔", "别人提醒比较明显"], 1);
  const temperatureText = String(answers.temperature || "");
  const temperature = temperatureText === "不太在意" ? 2 : ordinalAnswer(answers.temperature, ["23℃及以下", "24—25℃", "26—27℃", "28℃及以上"]);
  const coldSensitive = ordinalAnswer(answers.coldSensitive, ["比较怕冷", "一般", "比较怕热"]);
  const speaker = ordinalAnswer(answers.speaker, ["基本不外放", "白天偶尔外放", "经常外放"], 1);
  const calls = ordinalAnswer(answers.calls, ["很少", "偶尔", "经常且时间较长"], 1);
  const soundSensitivity = fivePointAnswer(answers.soundSensitivity);
  const smellSensitivity = fivePointAnswer(answers.smellSensitivity);
  const cleanliness = fivePointAnswer(answers.cleanliness);
  const cleanParticipation = fivePointAnswer(answers.cleanParticipation);
  const trash = ordinalAnswer(answers.trash, ["当天及时处理", "装满后处理", "经常需要别人提醒"]);
  const laundry = ordinalAnswer(answers.laundry, ["勤洗勤换", "每周集中处理", "不固定"]);
  const showerTime = ordinalAnswer(answers.showerTime, ["18:00以前", "18:00—21:00", "21:00—23:00", "23:00以后"]);
  const borrow = ordinalAnswer(answers.borrow, ["不介意，先说一声即可", "只接受熟人借用", "希望互不借用"]);
  const foodShare = ordinalAnswer(answers.foodShare, ["愿意一起分享", "问过后可以", "希望各自保管"]);
  const sharedItems = ordinalAnswer(answers.sharedItems, ["愿意统一购买分摊", "少量可以", "更习惯各自购买"]);
  const study = ordinalAnswer(answers.studyInDorm, ["很少", "偶尔", "经常需要安静学习"]);
  const socialStyle = ordinalAnswer(answers.socialStyle, ["更喜欢安静独处", "适度交流", "喜欢热闹聊天"]);
  const visitors = ordinalAnswer(answers.visitors, ["基本不会", "偶尔短暂停留", "经常来往"], 1);
  const visitorTolerance = ordinalAnswer(answers.visitorTolerance, ["提前说就可以", "偶尔可以", "比较介意"]);
  const quietHours = ordinalAnswer(answers.quietHours, ["22:00以后", "23:00以后", "00:00以后", "协商即可"]);
  const weekendActivity = ordinalAnswer(answers.weekendActivity, ["多数外出", "不固定", "多数在寝室"]);
  const hobbies = answerList(answers.hobbies);
  const conflictStyle = String(answers.conflictStyle || "");
  const dealbreakers = answerList(answers.dealbreakers);
  const priorities = [answers.priority1, answers.priority2, answers.priority3].filter(Boolean);
  const noise = Math.max(gamingVoice, audioDiscipline, excitedNoise, speaker, calls);
  const lateNoise = (gamePeriod >= 2.5 && (gamingVoice >= 2 || excitedNoise >= 2 || answers.lateRank)) || speaker === 3;
  return {
    id: student.id,
    name: student.name,
    sid: student.student_id.replace(/.(?=.{4})/g, "*"),
    classId: student.class_id,
    gender: student.gender,
    surveyCompleted: Boolean(student.survey_completed),
    sleep: sleepCategory(answers.bedTime),
    wake, weekendShift, alarm, nap, sleepDepth, afterLights,
    gameFrequency, gameHours, gamePeriod, gamingVoice, audioDiscipline, excitedNoise, lateGaming, mechanicalKeyboard, gameGenres, gameDevices,
    noise, lateNoise, speaker, calls, soundSensitivity,
    smoking: smokingText.includes("宿舍内") ? 3 : smokingText.includes("宿舍外") ? 2 : 1,
    smokeTolerance: toleranceText.includes("完全不能") ? 1 : toleranceText.includes("宿舍外") ? 2 : 3,
    snoring, temperature, temperatureFlexible: temperatureText === "不太在意", coldSensitive, smellSensitivity,
    cleanliness, cleanParticipation, trash, laundry, showerTime, borrow, foodShare, sharedItems,
    study, socialStyle, visitors, visitorTolerance, quietHours, quietHoursFlexible: String(answers.quietHours || "") === "协商即可", weekendActivity,
    hobbies, conflictStyle, dealbreakers, priorities,
    approvedBedNeed: student.bed_need_approved ? student.bed_need : null
  };
}

async function adminAllocate(uid, payload) {
  await requireAdmin(uid);
  const [allStudents, surveys, allGroups, roomInventory, assignments] = await Promise.all([
    fetchAll("dorm_students"), fetchAll("dorm_surveys"), fetchAll("dorm_groups"), fetchAll("dorm_rooms"), fetchAll("dorm_assignments")
  ]);
  const surveyMap = new Map(surveys.map((survey) => [survey.student_id, survey]));
  const assignmentMap = new Map(assignments.map(assignment => [assignment.student_id, assignment.room_number]));
  const wantedClasses = payload.classId && payload.classId !== "all" ? [payload.classId] : ["1", "2", "3", "4"];
  const eligible = allStudents.filter((student) => wantedClasses.includes(student.class_id) && student.survey_completed);
  const matchable = eligible.filter((student) => ["男", "女"].includes(student.gender));
  const studentMap = new Map(eligible.map((student) => [student.id, featureStudent(student, surveyMap.get(student.id))]));
  const groupedIds = new Set();
  const units = [];
  const manualPending = eligible.filter((student) => !["男", "女"].includes(student.gender)).map((student) => ({ ...featureStudent(student, surveyMap.get(student.id)), reason: "名单缺少性别，不能进入正式分配" }));

  allGroups.filter((group) => wantedClasses.includes(group.class_id) && group.status !== "rejected" && (group.member_ids || []).length >= 2).forEach((group) => {
    const memberIds = group.member_ids || [];
    const members = memberIds.map((id) => studentMap.get(id)).filter(Boolean);
    if (!members.length) return;
    if (members.length !== memberIds.length) {
      members.forEach((member) => {
        groupedIds.add(member.id);
        manualPending.push({ ...member, reason: "所在意向组仍有成员未完成问卷，暂不拆组" });
      });
      return;
    }
    members.forEach((member) => groupedIds.add(member.id));
    const assignedRooms = [...new Set(memberIds.map(id => assignmentMap.get(id)).filter(Boolean))];
    units.push({ id: group.id, members, allConfirmed: members.every((member) => group.confirmed_ids?.includes(member.id)), preferredRoom: members.length === 4 && assignedRooms.length === 1 ? assignedRooms[0] : null });
  });

  matchable.filter((student) => !groupedIds.has(student.id)).forEach((student) => {
    units.push({ id: `single-${student.id}`, members: [studentMap.get(student.id)], allConfirmed: true });
  });

  const allocation = allocationCore.allocateAll(units, { weights: payload.weights || {} });
  const numbered = allocationCore.assignRoomNumbers(allocation, roomInventory.map((room) => ({ roomNumber: room.room_number, classId: room.class_id, gender: room.gender, capacity: room.capacity, active: room.active })));
  const rooms = numbered.rooms.map((room) => ({
      classId: room.classId,
      gender: room.gender,
      roomNumber: room.roomNumber,
      capacity: room.capacity,
      fixed: room.fixed,
      score: room.score,
      warnings: room.warnings,
      note: room.fixed ? "全员确认的完整四人组" : `习惯兼容分${room.score}分`,
      members: room.members.map((member) => ({ id: member.id, name: member.name, sid: member.sid, tag: member.approvedBedNeed || "已完成问卷" }))
    }));
  const reviewPending = Object.values(allocation.classes || {}).flatMap((classResult) => (classResult.review || []).flatMap((item) => (item.members || []).map((student) => ({ ...student, reason: `意向组需要人工确认：${item.reasons.join("；")}` }))));
  const pendingSource = [...numbered.pending, ...manualPending, ...reviewPending];
  const uniquePending = [...new Map(pendingSource.map((student) => [student.id, student])).values()];
  const pending = uniquePending.map((student) => ({
    id: student.id, name: student.name, classId: student.classId, gender: student.gender, reason: student.reason
  }));
  const runId = crypto.randomUUID();
  unwrap(await pg.from("dorm_allocation_runs").insert({
    id: runId,
    version: allocation.version,
    class_id: payload.classId || "all",
    rooms,
    pending,
    created_by: uid,
    status: "draft"
  }));
  await audit("ALLOCATION_GENERATE", uid, runId, { roomCount: rooms.length, pendingCount: pending.length, version: allocation.version });
  return { runId, version: allocation.version, rooms, pending };
}

async function publishAllocation(uid, payload) {
  await requireAdmin(uid);
  return rpc("dorm_publish_allocation", { p_run_id: String(payload.runId || "") });
}

async function route(action, uid, payload) {
  switch (action) {
    case "student.login": return studentLogin(uid, payload);
    case "student.submitSurvey": return submitSurvey(uid, payload);
    case "student.state": return studentState(uid);
    case "group.invite": return inviteStudent(uid, payload);
    case "group.respond": return respondInvite(uid, payload);
    case "admin.bootstrap": await requireAdmin(uid); return { role: "counselor" };
    case "admin.dashboard": return adminDashboard(uid, payload);
    case "admin.allocate": return adminAllocate(uid, payload);
    case "admin.publish": return publishAllocation(uid, payload);
    default: throw new Error("未知操作");
  }
}

exports.main = async (event) => {
  const requestId = crypto.randomUUID();
  try {
    const uid = await callerUid();
    if (!uid) return fail("请先登录", "UNAUTHORIZED");
    const data = await route(String(event.action || ""), uid, event.payload || {});
    return ok(data);
  } catch (error) {
    console.error(JSON.stringify({ requestId, error: error.message, action: event.action }));
    if (error instanceof z.ZodError) return fail("提交内容格式不正确");
    return fail(error.message || "服务器处理失败");
  }
};
