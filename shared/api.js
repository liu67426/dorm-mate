(function () {
  "use strict";

  const config = window.DORM_CONFIG || {};
  const MOCK_KEY = "dorm-networked-mock-v1";
  let cloudApp;

  // 页面只展示可理解的处理建议，不暴露数据库函数名、查询或内部错误。
  function userMessage(error) {
    const message = String(error?.message || error || "");
    const rules = [
      [/permission denied|forbidden|无权|权限不足/i, "当前操作暂时无法完成，请联系辅导员检查访问权限。"],
      [/请先登录|unauthenticated|unauthorized|token.*expired|登录.*过期/i, "登录状态已失效，请重新登录或完成身份核验后再试。"],
      [/邀请不存在或已经处理/, "这条邀请已处理或已失效，请刷新组队状态。"],
      [/加入申请不存在或已经处理/, "这条加入申请已处理或已失效，请刷新组队状态。"],
      [/该小组已满|当前小组已满/, "小组已满员或状态已变化，请刷新后查看。"],
      [/你已经加入其他多人小组|你已经加入多人小组/, "你已有确认的搭档，暂时不能直接加入其他组；需要调整请联系辅导员。"],
      [/对方已经加入多人小组|申请人已经加入其他多人小组/, "对方的组队状态已变化，请刷新后查看，必要时联系辅导员。"],
      [/当前账号尚未通过学生名单核验|当前浏览器未关联学生身份/, "当前浏览器尚未关联学生身份，请先完成身份核验或恢复原身份。"],
      [/timeout|timed out|超时|deadlock|lock.*unavailable/i, "请求暂时未完成，请先刷新状态确认结果，再决定是否重试。"],
      [/network|failed to fetch|fetch failed|网络/i, "网络连接暂时异常，请检查网络并刷新状态后再试。"],
      [/CloudBase|数据库请求失败|匿名登录失败/i, "服务暂时不可用，请稍后重试；持续出现请联系辅导员。"]
    ];
    for (const [pattern, text] of rules) if (pattern.test(message)) return text;
    // 仅保留简短、无技术内容的中文业务校验，未知错误统一兜底。
    if (message.length <= 160 && /^[\u4e00-\u9fff\d\s，。；：！？、（）—“”]+$/.test(message)) return message;
    return "操作暂时未完成，请刷新状态后再试；持续出现请联系辅导员。";
  }

  function isCloud() {
    return config.mode === "cloud" && Boolean(config.envId);
  }

  function readMock() {
    try { return JSON.parse(localStorage.getItem(MOCK_KEY)) || { surveys: [], invites: [] }; }
    catch { return { surveys: [], invites: [] }; }
  }

  function writeMock(data) {
    localStorage.setItem(MOCK_KEY, JSON.stringify(data));
  }

  async function getCloudApp() {
    if (!isCloud()) return null;
    if (!window.cloudbase) throw new Error("CloudBase SDK没有加载成功");
    if (!cloudApp) cloudApp = window.cloudbase.init({ env: config.envId, region: config.region || "ap-shanghai" });
    return cloudApp;
  }

  async function getAuth() {
    const app = await getCloudApp();
    const auth = typeof app?.auth === "function" ? app.auth() : app?.auth;
    if (!auth) throw new Error("无法初始化CloudBase身份认证");
    return auth;
  }

  async function ensureAnonymous() {
    const auth = await getAuth();
    const state = typeof auth.getLoginState === "function" ? await auth.getLoginState() : null;
    if (!state) {
      const result = await auth.signInAnonymously();
      if (result?.error) throw new Error(result.error.message || "匿名登录失败");
    }
  }

  async function rpc(name, params = {}) {
    const app = await getCloudApp();
    if (!app || typeof app.rdb !== "function") throw new Error("CloudBase PostgreSQL模块不可用");
    const response = await app.rdb().rpc(name, params);
    if (response?.error) throw new Error(response.error.message || "数据库请求失败");
    return response?.data ?? null;
  }

  async function adminLogin(password) {
    if (!isCloud()) return password === "fdy2026";
    const auth = await getAuth();
    if (typeof auth.signOut === "function") await auth.signOut({ clearStorage: true }).catch(() => {});
    const result = await auth.signInWithPassword({ username: config.adminUsername || "counselor", password });
    if (result?.error) throw new Error(result.error.message || "账号或密码错误");
    await rpc("dorm_admin_snapshot", { p_class_id: "all" });
    return true;
  }

  async function adminLogout() {
    if (!isCloud()) return;
    const auth = await getAuth();
    if (typeof auth.signOut === "function") await auth.signOut({ clearStorage: true });
  }

  function normalizeIdentity(data = {}) {
    const originalCode = String(data.classCode ?? "").trim();
    const classCode = /^[1-4]$/.test(originalCode) ? originalCode.padStart(2, "0") : originalCode;
    return {
      ...data,
      className: String(data.className ?? "").trim(),
      classCode,
      name: String(data.name ?? "").trim(),
      studentId: String(data.studentId ?? "").trim()
    };
  }

  async function bindStudentIdentity(data) {
    data = normalizeIdentity(data);
    await ensureAnonymous();
    try {
      await rpc("dorm_bind_student", {
        p_class_name: data.className,
        p_class_code: data.classCode,
        p_name: data.name,
        p_student_id: data.studentId,
        p_uid: "由数据库读取登录身份"
      });
    } catch (error) {
      const message = String(error?.message || "");
      if (message.includes("名单核验失败")) {
        throw new Error("名单核验失败，请检查所在班级、班级填写码、姓名和学号是否与正式名单完全一致");
      }
      throw error;
    }
    return data;
  }

  async function submitSurvey(data) {
    data = normalizeIdentity(data);
    if (isCloud()) {
      data = await bindStudentIdentity(data);
      return rpc("dorm_submit_survey", { p_uid: "由数据库读取登录身份", p_answers: data });
    }
    const mock = readMock();
    const record = { ...data, submittedAt: new Date().toISOString() };
    const index = mock.surveys.findIndex((item) => item.studentId === data.studentId);
    if (index >= 0) mock.surveys[index] = record; else mock.surveys.push(record);
    writeMock(mock);
    return { receipt: `LOCAL-${Date.now().toString().slice(-8)}` };
  }

  async function recoverStudent(data) {
    if (!isCloud()) throw new Error("本机演示模式不需要恢复身份");
    data = await bindStudentIdentity(data);
    return getStudentState(data);
  }

  async function getStudentState(identity) {
    if (isCloud()) {
      await ensureAnonymous();
      const state = await rpc("dorm_student_state", {});
      if (state?.assignment) {
        const matchView = await rpc("dorm_student_match_view", {});
        state.assignment.priorities = Array.isArray(matchView?.priorities) ? matchView.priorities : [];
        state.assignment.roommateHighlights = Array.isArray(matchView?.roommates) ? matchView.roommates : [];
      }
      return state;
    }
    const mock = readMock();
    return { surveyCompleted: mock.surveys.some((item) => item.studentId === identity.studentId), group: null, incomingInvites: [], incomingJoinRequests: [], joinableGroups: [], candidates: [] };
  }

  async function inviteStudent(studentId) {
    if (isCloud()) {
      await ensureAnonymous();
      return rpc("dorm_create_invite", {
        p_uid: "由数据库读取登录身份",
        p_candidate_id: String(studentId || ""),
        p_new_group_id: crypto.randomUUID(),
        p_invite_id: crypto.randomUUID()
      });
    }
    return { status: "pending" };
  }

  async function respondInvite(inviteId, accepted) {
    if (isCloud()) {
      await ensureAnonymous();
      return rpc("dorm_respond_invite", {
        p_uid: "由数据库读取登录身份",
        p_invite_id: String(inviteId || ""),
        p_accepted: Boolean(accepted)
      });
    }
    return { status: accepted ? "accepted" : "declined" };
  }

  async function requestJoinGroup(groupId) {
    if (!isCloud()) return { status: "pending" };
    await ensureAnonymous();
    return rpc("dorm_request_join_group", {
      p_group_id: String(groupId || ""),
      p_request_id: crypto.randomUUID()
    });
  }

  async function respondJoinRequest(requestId, accepted) {
    if (!isCloud()) return { status: accepted ? "accepted" : "declined" };
    await ensureAnonymous();
    return rpc("dorm_respond_join_request", {
      p_request_id: String(requestId || ""),
      p_accepted: Boolean(accepted)
    });
  }

  function isCompleteGroup(group) {
    const members = group.member_ids || [];
    return group.status !== "rejected" && members.length === 4 &&
      new Set(members).size === 4 && members.every(id => (group.confirmed_ids || []).includes(id));
  }

  function publicGroup(group) {
    return {
      id: group.id,
      classId: group.class_id,
      memberIds: group.member_ids || [],
      confirmedIds: group.confirmed_ids || [],
      status: group.status,
      compatibilityScore: group.compatibility_score == null ? null : Number(group.compatibility_score)
    };
  }

  function summaryFromSurvey(student, survey) {
    const answers = survey?.answers || {};
    const bedNeed = student.bed_need && student.bed_need !== "无" ? student.bed_need : "无";
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
      tag: answers.cleanliness ? `整洁程度${answers.cleanliness}` : (student.survey_completed ? "已完成问卷" : "等待问卷"),
      bedNeed,
      bedNeedApproved: Boolean(student.bed_need_approved),
      specialNote: bedNeed !== "无" ? String(answers.otherNotes || "未填写补充说明") : ""
    };
  }

  async function getSnapshot() {
    return rpc("dorm_admin_snapshot", { p_class_id: "all" });
  }

  async function getAdminDashboard(classId) {
    if (!isCloud()) return null;
    const snapshot = await getSnapshot();
    const allStudents = snapshot?.students || [];
    const surveys = snapshot?.surveys || [];
    const allGroups = snapshot?.groups || [];
    const surveyMap = new Map(surveys.map((item) => [item.student_id, item]));
    const classMeta = {};
    ["1", "2", "3", "4"].forEach((id) => {
      const list = allStudents.filter((item) => item.class_id === id);
      const rooms = (snapshot?.rooms || []).filter((item) => item.class_id === id && item.active !== false);
      classMeta[id] = {
        name: list[0]?.class_name || `工业机器人${id}班`,
        total: list.length,
        male: list.filter((item) => item.gender === "男").length,
        female: list.filter((item) => item.gender === "女").length,
        submitted: list.filter((item) => item.survey_completed).length,
        groups: allGroups.filter((item) => item.class_id === id && isCompleteGroup(item)).length,
        review: list.filter((item) => item.bed_need && item.bed_need !== "无").length,
        maleBeds: rooms.filter((item) => item.gender === "男").reduce((sum, item) => sum + Number(item.capacity || 4), 0),
        femaleBeds: rooms.filter((item) => item.gender === "女").reduce((sum, item) => sum + Number(item.capacity || 4), 0)
      };
    });
    const filteredStudents = classId && classId !== "all" ? allStudents.filter((item) => item.class_id === classId) : allStudents;
    const filteredGroups = classId && classId !== "all" ? allGroups.filter((item) => item.class_id === classId) : allGroups;
    return {
      classMeta,
      students: filteredStudents.map((student) => summaryFromSurvey(student, surveyMap.get(student.id))),
      groups: filteredGroups.map(publicGroup).map((group) => ({ id: group.id, classId: group.classId, memberIds: group.memberIds, confirmedIds: group.confirmedIds, score: group.compatibilityScore, status: group.status })),
      rooms: snapshot?.rooms || [],
      assignments: snapshot?.assignments || []
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

  async function runAllocation(classId) {
    if (!isCloud()) return null;
    if (!window.DormAllocation) throw new Error("分配算法模块没有加载成功");
    const snapshot = await getSnapshot();
    const allStudents = snapshot?.students || [];
    const surveys = snapshot?.surveys || [];
    const allGroups = snapshot?.groups || [];
    const assignmentMap = new Map((snapshot?.assignments || []).map(assignment => [assignment.student_id, assignment.room_number]));
    const surveyMap = new Map(surveys.map((survey) => [survey.student_id, survey]));
    const wantedClasses = classId && classId !== "all" ? [classId] : ["1", "2", "3", "4"];
    const eligible = allStudents.filter((student) => wantedClasses.includes(student.class_id) && student.survey_completed);
    const matchable = eligible.filter((student) => ["男", "女"].includes(student.gender));
    const studentMap = new Map(eligible.map((student) => [student.id, featureStudent(student, surveyMap.get(student.id))]));
    const groupedIds = new Set();
    const units = [];
    const manualPending = eligible.filter((student) => !["男", "女"].includes(student.gender)).map((student) => ({
      ...featureStudent(student, surveyMap.get(student.id)), reason: "名单缺少性别，不能进入正式分配"
    }));

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

    const allocation = window.DormAllocation.allocateAll(units);
    const inventory = (snapshot?.rooms || []).map((room) => ({ roomNumber: room.room_number, classId: room.class_id, gender: room.gender, capacity: room.capacity, active: room.active }));
    const numbered = window.DormAllocation.assignRoomNumbers(allocation, inventory);
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
    const pending = uniquePending.map((student) => ({ id: student.id, name: student.name, classId: student.classId, gender: student.gender, reason: student.reason }));
    const runId = crypto.randomUUID();
    await rpc("dorm_save_allocation", {
      p_run_id: runId,
      p_version: allocation.version,
      p_class_id: classId || "all",
      p_rooms: rooms,
      p_pending: pending
    });
    return { runId, version: allocation.version, rooms, pending };
  }

  async function publishAllocation(runId) {
    if (!isCloud()) throw new Error("本机演示模式不能发布正式结果");
    return rpc("dorm_publish_allocation", { p_run_id: String(runId || "") });
  }

  async function resetStudentBinding(studentId) {
    if (!isCloud()) throw new Error("本机演示模式不能重置设备绑定");
    return rpc("dorm_admin_reset_student_binding", { p_student_id: String(studentId || "") });
  }

  window.DormApi = { userMessage, isCloud, adminLogin, adminLogout, submitSurvey, recoverStudent, getStudentState, inviteStudent, respondInvite, requestJoinGroup, respondJoinRequest, getAdminDashboard, runAllocation, publishAllocation, resetStudentBinding };
}());
