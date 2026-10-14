"use strict";

const AUTH_KEY = "counselor-demo-auth-v1";
const FAIL_KEY = "counselor-demo-fails-v1";
const LOCK_KEY = "counselor-demo-lock-v1";
const SESSION_LENGTH = 15 * 60 * 1000;

let classMeta = {};
let students = [];
let groups = [];
let currentSchool = new URLSearchParams(location.search).get("school") || "";
try { if (currentSchool) currentSchool = window.DormSetup.schoolCode(currentSchool); }
catch { currentSchool = ""; }
let setupState = null;
let stagedRoster = null;
let stagedRooms = null;
let cloudRoster = null;

let selectedClass = "all";
let groupFilter = "all";
let generatedRooms = [];
let generatedPending = [];
let generatedRunId = null;
let toastTimer;

const loginView = document.getElementById("login-view");
const app = document.getElementById("app");
const loginForm = document.getElementById("login-form");
const loginButton = document.getElementById("login-button");
const loginError = document.getElementById("login-error");
const passwordInput = document.getElementById("password");

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[character]));
}

function updateClassPicker() {
  const picker = document.getElementById("class-select");
  picker.innerHTML = '<option value="all">全部班级</option>' + Object.entries(classMeta).map(([id, item]) => `<option value="${escapeHtml(id)}">${escapeHtml(item.name)}</option>`).join("");
  if (selectedClass !== "all" && !classMeta[selectedClass]) selectedClass = "all";
  picker.value = selectedClass;
}

function updateSetupView() {
  if (window.DormApi?.isCloud()) {
    const school = window.DormApi.schoolInfo?.() || null;
    const initialized = students.length > 0;
    document.getElementById("setup-status").textContent = initialized ? `当前环境已有${students.length}名学生；为保护已使用的数据，网页禁止再次初始化。` : cloudRoster ? "名单已核对，请选择寝室文件；最后一步会一次性写入云端。" : "当前环境尚未导入学生名单，请先上传并核对名单。";
    document.getElementById("setup-warning").textContent = school ? `当前学校：${school.name}。首次初始化会将名单和寝室一次性写入该校独立环境。请先核对学校及文件；已有学生数据的环境不能再次初始化。` : "未选择已开通的学校，请返回网站首页选择。";
    document.getElementById("school-name").value = school?.name || "";
    document.getElementById("school-code").value = school?.code || "";
    document.getElementById("school-name").disabled = true;
    document.getElementById("school-code").disabled = true;
    document.getElementById("select-school").disabled = true;
    document.getElementById("roster-file").disabled = !school || initialized;
    document.getElementById("rooms-file").disabled = !school || initialized || !cloudRoster;
    document.getElementById("roster-preview").textContent = initialized ? "已完成首次初始化" : cloudRoster ? `已核对${cloudRoster.records.length}名学生、${cloudRoster.classes.length}个班。` : "尚未选择名单文件";
    document.getElementById("rooms-preview").textContent = initialized ? "寝室已由云端保存" : "请先核对学生名单";
    document.getElementById("import-roster").textContent = "名单核对通过，继续寝室";
    document.getElementById("import-rooms").textContent = "确认启用本校数据";
    return;
  }
  document.getElementById("school-name").value = setupState?.schoolName || document.getElementById("school-name").value;
  document.getElementById("school-code").value = currentSchool;
  document.getElementById("roster-file").disabled = !currentSchool;
  document.getElementById("rooms-file").disabled = !setupState?.roster?.length;
  document.getElementById("roster-preview").textContent = setupState?.roster?.length ? `已保存${setupState.roster.length}名学生、${setupState.classes.length}个班；选择新文件可重新导入。` : "尚未导入名单";
  document.getElementById("rooms-preview").textContent = setupState?.rooms?.length ? `已保存${setupState.rooms.length}间寝室。` : "尚未导入寝室";
  const studentUrl = currentSchool ? new URL(`../student/?school=${encodeURIComponent(currentSchool)}`, location.href).href : "";
  document.getElementById("setup-status").innerHTML = setupState?.roster?.length
    ? `当前：${escapeHtml(setupState.schoolName)}；${setupState.roster.length}名学生，${setupState.rooms?.length || 0}间寝室。学生演示入口：<a href="${escapeHtml(studentUrl)}">${escapeHtml(studentUrl)}</a>（仅本浏览器可读取演示名单）`
    : "尚未导入名单，不能生成分寝建议。";
}

function applyDemoState() {
  setupState = currentSchool ? window.DormSetup.readSetup(localStorage, currentSchool) : null;
  const roster = setupState?.roster || [];
  const surveys = new Map(window.DormApi.getMockSurveys().map(item => [item.studentId, item]));
  students = roster.map(item => {
    const answer = surveys.get(item.studentId);
    return { id: item.studentId, sid: item.studentId, classId: item.classId, name: item.name, gender: item.gender,
      status: answer ? (answer.bedNeed && answer.bedNeed !== "无" ? "review" : "completed") : "pending",
      sleep: answer ? `${answer.bedTime || "未填"}上床` : "未填写", game: answer?.gamer || "未填写",
      smoking: answer?.smoking || "未填写", tag: answer?.socialStyle || "等待问卷", bedNeed: answer?.bedNeed, specialNote: answer?.specialNote };
  });
  groups = [];
  classMeta = Object.fromEntries((setupState?.classes || []).map(item => {
    const own = students.filter(student => student.classId === item.classId);
    const beds = (setupState.rooms || []).filter(room => room.classId === item.classId);
    return [item.classId, { name: item.className, total: own.length, submitted: own.filter(student => student.status !== "pending").length,
      groups: 0, review: own.filter(student => student.status === "review").length,
      male: own.filter(student => student.gender === "男").length, female: own.filter(student => student.gender === "女").length,
      maleBeds: beds.filter(room => room.gender === "男").length * 4, femaleBeds: beds.filter(room => room.gender === "女").length * 4 }];
  }));
  updateClassPicker();
  updateSetupView();
  document.getElementById("run-allocation").disabled = !setupState?.roster?.length || !setupState?.rooms?.length;
}

document.getElementById("select-school").addEventListener("click", () => {
  try {
    const code = window.DormSetup.schoolCode(document.getElementById("school-code").value);
    const name = document.getElementById("school-name").value.trim();
    if (!name) throw new Error("请填写学校名称");
    currentSchool = code;
    setupState = window.DormSetup.readSetup(localStorage, code) || { schoolName: name, roster: [], classes: [], rooms: [] };
    setupState.schoolName = name;
    window.DormSetup.saveSetup(localStorage, code, setupState);
    history.replaceState(null, "", `${location.pathname}?school=${encodeURIComponent(code)}`);
    selectedClass = "all";
    resetAllocation();
    renderAll();
    showToast(`已进入${name}的本机演示空间`);
  } catch (error) { showToast(error.message); }
});

document.getElementById("roster-file").addEventListener("change", async event => {
  stagedRoster = null;
  document.getElementById("import-roster").disabled = true;
  try {
    const file = event.target.files[0];
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) throw new Error("名单文件不能超过2MB");
    stagedRoster = window.DormSetup.validateRoster(await file.text());
    document.getElementById("roster-preview").textContent = `检查通过：${stagedRoster.records.length}名学生、${stagedRoster.classes.length}个班。${window.DormApi?.isCloud() ? "继续核对寝室后，才能一次性写入本校云环境。" : "确认导入会替换该学校旧名单和问卷。"}`;
    document.getElementById("import-roster").disabled = false;
  } catch (error) { document.getElementById("roster-preview").textContent = error.message; }
});

document.getElementById("import-roster").addEventListener("click", () => {
  if (!stagedRoster) return;
  if (window.DormApi?.isCloud()) {
    if (students.length || !window.DormApi.schoolInfo()) return;
    cloudRoster = stagedRoster;
    stagedRoster = null;
    document.getElementById("import-roster").disabled = true;
    updateSetupView();
    showToast("名单已核对，请继续导入寝室");
    return;
  }
  if (!setupState || !currentSchool) return;
  if (setupState.roster.length && !confirm("重新导入会清除该学校本机演示问卷和寝室，请确认。")) return;
  setupState.roster = stagedRoster.records;
  setupState.classes = stagedRoster.classes;
  setupState.rooms = [];
  window.DormSetup.saveSetup(localStorage, currentSchool, setupState);
  localStorage.removeItem(`dorm-networked-mock-v1:${currentSchool}`);
  localStorage.removeItem(`roommate-questionnaire-standalone-demo-v1:${currentSchool}`);
  stagedRoster = null;
  document.getElementById("import-roster").disabled = true;
  resetAllocation();
  renderAll();
  showToast("名单已保存，请继续导入寝室");
});

document.getElementById("rooms-file").addEventListener("change", async event => {
  stagedRooms = null;
  document.getElementById("import-rooms").disabled = true;
  try {
    const file = event.target.files[0];
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) throw new Error("寝室文件不能超过2MB");
    stagedRooms = window.DormSetup.validateRooms(await file.text(), window.DormApi?.isCloud() ? cloudRoster?.classes || [] : setupState.classes);
    document.getElementById("rooms-preview").textContent = `检查通过：${stagedRooms.length}间寝室。`;
    document.getElementById("import-rooms").disabled = false;
  } catch (error) { document.getElementById("rooms-preview").textContent = error.message; }
});

document.getElementById("import-rooms").addEventListener("click", async () => {
  if (!stagedRooms) return;
  if (window.DormApi?.isCloud()) {
    if (!cloudRoster || students.length) return;
    if (!confirm(`确定为${window.DormApi.schoolInfo().name}首次导入${cloudRoster.records.length}名学生和${stagedRooms.length}间寝室吗？`)) return;
    const button = document.getElementById("import-rooms");
    button.disabled = true;
    button.textContent = "正在写入云端…";
    try {
      const expectedCount = cloudRoster.records.length;
      await window.DormApi.initializeSchool(cloudRoster.records, stagedRooms);
      cloudRoster = null; stagedRooms = null;
      const loaded = await renderAll();
      showToast(loaded && students.length === expectedCount ? "名单和寝室已写入本校云环境" : "云端已接收导入，但读取核对未完成；请刷新工作台确认");
    } catch (error) {
      button.disabled = false;
      showToast(`导入失败：${window.DormApi.userMessage(error)}`);
    } finally { button.textContent = "确认启用本校数据"; }
    return;
  }
  if (!setupState) return;
  setupState.rooms = stagedRooms;
  window.DormSetup.saveSetup(localStorage, currentSchool, setupState);
  stagedRooms = null;
  document.getElementById("import-rooms").disabled = true;
  resetAllocation();
  renderAll();
  showToast("寝室已保存，可以开始本机流程演示");
});

function showToast(message) {
  const toast = document.getElementById("toast");
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 2400);
}

function authKey() { return window.DormApi?.isCloud() ? `${AUTH_KEY}:${window.DormApi.schoolInfo()?.code || "unselected"}` : AUTH_KEY; }
function validSession() {
  const timestamp = Number(sessionStorage.getItem(authKey()));
  return timestamp > 0 && Date.now() - timestamp < SESSION_LENGTH;
}

async function openWorkspace() {
  sessionStorage.setItem(authKey(), String(Date.now()));
  loginView.hidden = true;
  app.hidden = false;
  await renderAll();
  if ((!window.DormApi?.isCloud() && !setupState?.roster?.length) || (window.DormApi?.isCloud() && !students.length)) activateView("setup");
}

function closeWorkspace(message = "已安全退出工作台") {
  sessionStorage.removeItem(authKey());
  app.hidden = true;
  loginView.hidden = false;
  passwordInput.value = "";
  loginError.textContent = "";
  if (window.DormApi) window.DormApi.adminLogout().catch(() => {});
  passwordInput.focus();
  if (message) showToast(message);
}

function updateLockState() {
  const lockedUntil = Number(sessionStorage.getItem(LOCK_KEY));
  if (lockedUntil > Date.now()) {
    const seconds = Math.ceil((lockedUntil - Date.now()) / 1000);
    loginButton.disabled = true;
    loginError.textContent = `密码连续输错5次，请${seconds}秒后再试。`;
    return true;
  }
  if (lockedUntil) {
    sessionStorage.removeItem(LOCK_KEY);
    sessionStorage.removeItem(FAIL_KEY);
  }
  loginButton.disabled = false;
  return false;
}

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (window.DormApi?.isCloud() && !window.DormApi.schoolInfo?.()) {
    loginError.textContent = "请先返回网站首页选择已开通的学校。";
    return;
  }
  if (updateLockState()) return;
  loginButton.disabled = true;
  loginButton.firstChild.textContent = "正在验证 ";
  let correct = false;
  try { correct = await window.DormApi.adminLogin(passwordInput.value); }
  catch (error) { loginError.textContent = window.DormApi.userMessage(error); }
  loginButton.firstChild.textContent = "进入工作台 ";
  if (correct) {
    sessionStorage.removeItem(FAIL_KEY);
    sessionStorage.removeItem(LOCK_KEY);
    loginError.textContent = "";
    openWorkspace();
    showToast("密码正确，已进入辅导员工作台");
    return;
  }
  const failures = Number(sessionStorage.getItem(FAIL_KEY) || 0) + 1;
  sessionStorage.setItem(FAIL_KEY, String(failures));
  passwordInput.select();
  if (failures >= 5) {
    sessionStorage.setItem(LOCK_KEY, String(Date.now() + 30000));
    updateLockState();
  } else {
    loginButton.disabled = false;
    loginError.textContent = `密码不正确，还可尝试${5 - failures}次。`;
  }
});

setInterval(() => {
  if (!app.hidden && !validSession()) closeWorkspace("登录已超过15分钟，请重新输入密码");
  if (!loginView.hidden) updateLockState();
}, 1000);

document.getElementById("toggle-password").addEventListener("click", (event) => {
  const showing = passwordInput.type === "text";
  passwordInput.type = showing ? "password" : "text";
  event.currentTarget.textContent = showing ? "显示" : "隐藏";
});
document.getElementById("logout").addEventListener("click", () => closeWorkspace());
app.addEventListener("click", () => {
  // 工作台已关闭时（含刚点完退出的冒泡），不允许续期会话，否则退出后刷新会免密进入。
  if (app.hidden) return;
  sessionStorage.setItem(authKey(), String(Date.now()));
});

const pageTitles = { setup: "首次设置", overview: "工作台总览", surveys: "问卷管理", groups: "组队审核", allocation: "分寝建议" };
function activateView(view) {
  document.querySelectorAll(".nav-button").forEach((item) => item.classList.toggle("active", item.dataset.view === view));
  document.querySelectorAll(".view").forEach((item) => item.classList.toggle("active", item.id === `view-${view}`));
  document.getElementById("page-title").textContent = pageTitles[view];
  if (view === "surveys") renderStudents();
  if (view === "groups") renderGroups();
  window.scrollTo({ top: 0, behavior: "smooth" });
}
document.querySelectorAll(".nav-button").forEach((button) => button.addEventListener("click", () => activateView(button.dataset.view)));

function openSpecialSituations() {
  document.getElementById("survey-status").value = "review";
  activateView("surveys");
  showToast("已筛选学生提交的特殊住宿情况");
}
document.getElementById("show-special").addEventListener("click", openSpecialSituations);
document.getElementById("open-special").addEventListener("click", openSpecialSituations);
document.getElementById("open-special").addEventListener("keydown", (event) => {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    openSpecialSituations();
  }
});

document.getElementById("class-select").addEventListener("change", (event) => {
  selectedClass = event.target.value;
  generatedRooms = [];
  renderAll();
  resetAllocation();
  showToast(selectedClass === "all" ? "已切换到全部班级" : `已切换到${classMeta[selectedClass].name}`);
});

function activeClassIds() {
  return selectedClass === "all" ? Object.keys(classMeta) : [selectedClass];
}

function totals() {
  return activeClassIds().reduce((result, id) => {
    const item = classMeta[id];
    result.total += item.total;
    result.submitted += item.submitted;
    result.groups += item.groups;
    result.review += item.review;
    return result;
  }, { total: 0, submitted: 0, groups: 0, review: 0 });
}

function renderOverview() {
  const summary = totals();
  document.getElementById("roster-notice-title").textContent = summary.total ? `${window.DormApi?.isCloud() ? "已读取名单" : "本机演示名单"} · ${summary.total}名学生` : "等待导入学生名单";
  document.getElementById("roster-notice-text").textContent = summary.total ? (selectedClass === "all" ? `${Object.keys(classMeta).length}个班级已接入。` : `${classMeta[selectedClass].name}名单已接入。`) : (window.DormApi?.isCloud() ? "尚未读取到云端名单，请检查连接与权限。" : "请在“首次设置”中选择学校并导入名单。" );
  document.getElementById("roster-notice-badge").textContent = window.DormApi?.isCloud() ? "云端试点" : "本机演示";
  document.getElementById("metric-total").textContent = summary.total;
  document.getElementById("metric-submitted").textContent = summary.submitted;
  document.getElementById("metric-rate").textContent = `完成率 ${summary.total ? Math.round(summary.submitted / summary.total * 100) : 0}%`;
  document.getElementById("metric-groups").textContent = summary.groups;
  document.getElementById("metric-review").textContent = summary.review;
  document.getElementById("class-cards").innerHTML = Object.entries(classMeta).map(([id, item]) => {
    const rate = item.total ? Math.round(item.submitted / item.total * 100) : 0;
    const capacity = Number.isFinite(item.maleBeds) ? `男${item.male || 0}/${item.maleBeds}床 · 女${item.female || 0}/${item.femaleBeds}床` : `${item.groups}个完整四人组`;
    return `<article class="class-card" data-class-card="${escapeHtml(id)}"><div class="class-card-head"><h3>${escapeHtml(item.name)}</h3><span>${rate}%</span></div><div class="mini-progress"><i style="width:${rate}%"></i></div><small>${item.submitted}人已填 / ${item.total}人 · ${capacity}</small></article>`;
  }).join("");
  document.querySelectorAll("[data-class-card]").forEach((card) => card.addEventListener("click", () => {
    selectedClass = card.dataset.classCard;
    document.getElementById("class-select").value = selectedClass;
    renderAll();
    showToast(`正在查看${classMeta[selectedClass].name}`);
  }));
  const incomplete = groups.filter(group => activeClassIds().includes(group.classId) && window.DormGroups.classify(group).kind === "partial").length;
  document.getElementById("todo-list").innerHTML = [
    ["问", "提醒未填写问卷", `${summary.total - summary.submitted}人尚未完成`, summary.total - summary.submitted],
    ["组", "处理待补位小组", `两人组和三人组共${incomplete}组`, incomplete],
    ["需", "确认特殊住宿需要", "下铺、无障碍或其他已提交需求", summary.review]
  ].map(([icon, title, detail, count]) => `<div class="todo"><span>${icon}</span><div><b>${title}</b><small>${detail}</small></div><em>${count}项</em></div>`).join("");
}

function statusLabel(status) {
  return { completed: "已完成", review: "需确认", pending: "未填写" }[status];
}

function visibleStudents() {
  const query = document.getElementById("student-search").value.trim().toLowerCase();
  const status = document.getElementById("survey-status").value;
  return students.filter((student) => activeClassIds().includes(student.classId))
    .filter((student) => status === "all" || student.status === status)
    .filter((student) => `${student.name}${student.sid}`.toLowerCase().includes(query));
}

function renderStudents() {
  const list = visibleStudents();
  document.getElementById("student-result-count").textContent = `当前显示${list.length}条${window.DormApi?.isCloud() ? "正式" : "演示"}记录`;
  const emptyMessage = document.getElementById("survey-status").value === "review" ? "当前范围内没有学生提交特殊住宿情况" : "没有符合条件的记录";
  document.getElementById("student-table").innerHTML = list.length ? list.map((student) => {
    const special = student.status === "review"
      ? `<div class="special-cell"><b>${escapeHtml(student.bedNeed || "其他特殊需求")}</b><small>${escapeHtml(student.specialNote || "未填写补充说明")}</small></div>`
      : '<span class="tag">无</span>';
    return `<tr><td><div class="student"><span>${escapeHtml(student.name.slice(-2))}</span><div><b>${escapeHtml(student.name)}</b><small>${escapeHtml(student.sid)}</small></div></div></td><td>${escapeHtml(classMeta[student.classId]?.name || student.classId)}</td><td>${escapeHtml(student.gender || "未登记")}</td><td><span class="pill ${student.status}">${statusLabel(student.status)}</span></td><td>${special}</td><td>${escapeHtml(student.sleep)}</td><td>${escapeHtml(student.game)}</td><td><span class="tag">${escapeHtml(student.smoking)}</span><span class="tag">${escapeHtml(student.tag)}</span></td><td><button class="binding-reset" type="button" data-reset-binding="${escapeHtml(student.id)}">重置设备</button></td></tr>`;
  }).join("") : `<tr><td colspan="9" style="padding:36px;text-align:center;color:#718078">${emptyMessage}</td></tr>`;
}
document.getElementById("student-search").addEventListener("input", renderStudents);
document.getElementById("survey-status").addEventListener("change", renderStudents);
document.getElementById("student-table").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-reset-binding]");
  if (!button) return;
  const student = students.find((item) => item.id === button.dataset.resetBinding);
  if (!student) return showToast("没有找到这名学生，请刷新后重试");
  if (!window.DormApi?.isCloud()) {
    button.disabled = true;
    button.textContent = "演示模式不可用";
    return showToast("演示模式不连接数据库，重置设备绑定需正式部署后使用");
  }
  const confirmed = window.confirm(`确定为${student.name}解除旧设备绑定吗？\n\n问卷、组队和住宿结果都会保留；解除后，该同学需要在新设备首页填写身份信息并点击“恢复”。`);
  if (!confirmed) return;
  button.disabled = true;
  button.textContent = "正在重置…";
  try {
    const result = await window.DormApi.resetStudentBinding(student.id);
    button.textContent = result?.wasBound ? "已解除" : "原本未绑定";
    showToast(result?.wasBound ? `已解除${student.name}的旧设备绑定，其他数据未修改` : `${student.name}当前没有绑定设备`);
  } catch (error) {
    button.disabled = false;
    button.textContent = "重置设备";
    showToast(`重置失败：${window.DormApi.userMessage(error)}`);
  }
});

function renderGroups() {
  const list = groups.filter((group) => activeClassIds().includes(group.classId)).filter((group) => {
    const kind = window.DormGroups.classify(group).kind;
    if (groupFilter === "complete") return kind === "complete";
    if (groupFilter === "incomplete") return kind === "partial";
    return kind === "partial" || kind === "complete" || kind === "review";
  });
  document.getElementById("group-grid").innerHTML = list.map((group) => {
    const members = group.memberIds.map((id) => students.find((student) => student.id === id)).filter(Boolean);
    const phase = window.DormGroups.classify(group);
    const missing = Math.max(0, 4 - members.length);
    const confirmed = new Set(group.confirmedIds || []);
    const memberHtml = members.map((member) => `<div class="group-member"><span>${escapeHtml(member.name.slice(-2))}</span><b>${escapeHtml(member.name)}</b><small>${confirmed.has(member.id) ? "✓ 已确认组队" : "待核实确认"}</small></div>`).join("");
    const emptyHtml = Array.from({ length: missing }, () => '<div class="group-empty"><b>+</b><small>等待补位</small></div>').join("");
    const scoreText = group.score == null ? "适配度尚未计算" : `整组生活习惯适配度 ${group.score}%`;
    const detail = phase.kind === "review" ? "成员确认或人数异常，请先复核" : phase.kind === "partial" ? "已保存搭档关系，无需等满员提交；分寝时整体补位" : "全员确认，可进入分寝审核";
    return `<article class="group-card"><div class="group-card-head"><div><h3>${escapeHtml(classMeta[group.classId].name)} · 意向组${escapeHtml(group.id.split("-")[1] || group.id)}</h3><p>${phase.confirmedCount}/${phase.size}名成员已确认</p></div><span class="group-status ${phase.kind === "complete" ? "complete" : "incomplete"}">${escapeHtml(phase.label)}</span></div><div class="group-members">${memberHtml}${emptyHtml}</div><div class="group-foot"><span>${escapeHtml(scoreText)}</span><span>${detail}</span></div></article>`;
  }).join("") || '<p class="empty-state">当前没有符合条件的已组队记录；单人属于未组队学生，可在问卷管理中查看。</p>';
}
document.querySelectorAll("[data-group-filter]").forEach((button) => button.addEventListener("click", () => {
  groupFilter = button.dataset.groupFilter;
  document.querySelectorAll("[data-group-filter]").forEach((item) => item.classList.toggle("active", item === button));
  renderGroups();
}));

function resetAllocation() {
  generatedRooms = [];
  generatedPending = [];
  generatedRunId = null;
  document.getElementById("allocation-empty").style.display = "block";
  document.getElementById("room-grid").classList.remove("show");
  document.getElementById("room-grid").innerHTML = "";
  document.getElementById("export-rooms").disabled = true;
  document.getElementById("publish-allocation").disabled = true;
  document.getElementById("publish-allocation").textContent = "确认发布";
  document.getElementById("pending-panel").hidden = true;
  document.getElementById("allocation-counts").hidden = true;
}

async function generateRooms() {
  if (window.DormApi?.isCloud()) {
    try {
      document.getElementById("run-allocation").disabled = true;
      document.getElementById("run-allocation").textContent = "正在计算…";
      const result = await window.DormApi.runAllocation(selectedClass);
      generatedRooms = (result.rooms || []).map((room) => ({ ...room, note: room.warnings?.length ? room.warnings.join("；") : room.note }));
      generatedPending = result.pending || [];
      generatedRunId = result.runId || null;
      renderRooms();
      showToast(`已按${result.version}规则生成${generatedRooms.length}间分寝建议`);
    } catch (error) {
      showToast(`生成失败：${window.DormApi.userMessage(error)}`);
    } finally {
      document.getElementById("run-allocation").disabled = false;
      document.getElementById("run-allocation").textContent = "生成分寝建议";
    }
    return;
  }
  if (!setupState?.roster?.length || !setupState?.rooms?.length) return showToast("请先导入名单和寝室");
  generatedRooms = [];
  generatedPending = [];
  for (const classId of activeClassIds()) for (const gender of ["男", "女"]) {
    const eligible = students.filter(student => student.classId === classId && student.gender === gender && student.status !== "pending");
    const inventory = setupState.rooms.filter(room => room.classId === classId && room.gender === gender && room.active);
    inventory.forEach((room, index) => {
      const members = eligible.slice(index * 4, index * 4 + 4);
      if (members.length) generatedRooms.push({ classId, gender, roomNumber: room.roomNumber, members, fixed: false, note: "本机演示按名单顺序放入可用床位，正式匹配须另行审核" });
    });
    eligible.slice(inventory.length * 4).forEach(student => generatedPending.push({ ...student, reason: "该班该性别床位不足，请补充寝室" }));
  }
  renderRooms();
  showToast(`已生成${generatedRooms.length}间演示寝室建议`);
}

function renderRooms() {
  document.getElementById("allocation-empty").style.display = "none";
  const grid = document.getElementById("room-grid");
  grid.classList.add("show");
  grid.innerHTML = generatedRooms.map((room, index) => { const className = room.classId === "shared" ? "跨班机动女寝" : (classMeta[room.classId]?.name || room.classId); return `<article class="room-card"><div class="room-card-head"><div><h3>${escapeHtml(className)} · ${escapeHtml(room.roomNumber || `建议寝室${String(index + 1).padStart(2, "0")}`)}</h3><small>${escapeHtml(room.gender || "未登记性别")}寝 · 4人间</small></div><span>${room.fixed ? "固定意向组" : room.members.length === 4 ? "系统建议" : `待补${4 - room.members.length}人`}</span></div><ul>${room.members.map((member) => `<li><b>${escapeHtml(member.name)}</b><span>${escapeHtml(member.tag)}</span></li>`).join("")}</ul><p>${escapeHtml(room.note)}</p><p class="bed-rule">发布后学生可查看寝室号和同寝室成员</p></article>`; }).join("");
  document.getElementById("export-rooms").disabled = false;
  const expectedIds = new Set(students.filter((student) => activeClassIds().includes(student.classId) && student.status !== "pending").map((student) => student.id));
  const placedIds = new Set(generatedRooms.flatMap((room) => room.members.map((member) => member.id)));
  const pendingIds = new Set(generatedPending.map((student) => student.id));
  const accountedIds = new Set([...placedIds, ...pendingIds]);
  const missingCount = [...expectedIds].filter((id) => !accountedIds.has(id)).length;
  const countPanel = document.getElementById("allocation-counts");
  countPanel.hidden = false;
  countPanel.innerHTML = `<span>已完成问卷 <b>${expectedIds.size}人</b></span><span>已进入寝室建议 <b>${placedIds.size}人</b></span><span>待辅导员处理 <b>${pendingIds.size}人</b></span><span>人数核对 <b>${missingCount ? `缺少${missingCount}人` : `${accountedIds.size}/${expectedIds.size}，已对上`}</b></span>`;
  const publishButton = document.getElementById("publish-allocation");
  publishButton.disabled = !generatedRunId || !window.DormApi?.isCloud() || missingCount > 0;
  if (generatedRunId && !window.DormApi?.isCloud()) {
    publishButton.title = "演示模式不连接数据库，发布功能需正式部署后使用";
    publishButton.textContent = "演示模式不可发布";
  } else {
    publishButton.title = "";
    publishButton.textContent = missingCount ? `有${missingCount}人未计入，禁止发布` : pendingIds.size ? `确认发布（${pendingIds.size}人待处理）` : "确认发布";
  }
  const pendingPanel = document.getElementById("pending-panel");
  pendingPanel.hidden = generatedPending.length === 0;
  document.getElementById("pending-list").innerHTML = generatedPending.map((item) => `<div class="pending-item"><b>${escapeHtml(item.name)} · ${escapeHtml(classMeta[item.classId]?.name || item.classId)} · ${escapeHtml(item.gender || "性别未登记")}</b><span>${escapeHtml(item.reason)}</span></div>`).join("");
}
document.getElementById("run-allocation").addEventListener("click", generateRooms);
document.getElementById("publish-allocation").addEventListener("click", async () => {
  const studentCount = generatedRooms.reduce((sum, room) => sum + room.members.length, 0);
  const pendingCount = new Set(generatedPending.map((student) => student.id)).size;
  const warning = pendingCount ? `另有${pendingCount}人仍在待处理清单中，不会收到住宿结果。` : "";
  if (!generatedRunId || !window.confirm(`确定发布当前方案吗？发布后${studentCount}名学生可以查看寝室号和同寝室成员。${warning}`)) return;
  const button = document.getElementById("publish-allocation");
  button.disabled = true;
  button.textContent = "正在发布…";
  try {
    const result = await window.DormApi.publishAllocation(generatedRunId);
    button.textContent = "已正式发布";
    showToast(`已发布${result.studentCount || 0}名学生的住宿结果`);
  } catch (error) {
    button.disabled = false;
    button.textContent = "确认发布";
    showToast(`发布失败：${window.DormApi.userMessage(error)}`);
  }
});

function csvSafeText(value) { const text = String(value ?? ""); return /^[\t\r\n ]*[=+\-@]/.test(text) ? `'${text}` : text; }

function downloadCsv(filename, rows) {
  const csv = rows.map((row) => row.map((cell) => `"${csvSafeText(cell).replace(/"/g, '""')}"`).join(",")).join("\r\n");
  const blob = new Blob(["\ufeff", csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

document.getElementById("export-surveys").addEventListener("click", () => {
  const list = visibleStudents();
  const rows = [["学生", "脱敏学号", "班级", "问卷状态", "特殊住宿情况", "补充说明", "作息摘要", "游戏与声音", "住宿标签"], ...list.map((student) => [student.name, student.sid, classMeta[student.classId].name, statusLabel(student.status), student.bedNeed || "无", student.specialNote || "", student.sleep, student.game, `${student.smoking}；${student.tag}`])];
  downloadCsv(window.DormApi?.isCloud() ? "问卷进度.csv" : "问卷进度_虚拟演示.csv", rows);
  showToast(`已导出${window.DormApi?.isCloud() ? "" : "虚拟"}问卷进度 CSV`);
});

document.getElementById("export-rooms").addEventListener("click", () => {
  const rows = [["班级", "建议寝室", "学生", "脱敏学号", "类型", "复核说明"]];
  generatedRooms.forEach((room, index) => room.members.forEach((member) => rows.push([room.classId === "shared" ? "跨班机动女寝" : classMeta[room.classId].name, room.roomNumber || `建议寝室${String(index + 1).padStart(2, "0")}`, member.name, member.sid, room.fixed ? "固定意向组" : "系统建议", room.note])));
  downloadCsv(window.DormApi?.isCloud() ? "分寝建议.csv" : "分寝建议_虚拟演示.csv", rows);
  showToast(`已导出${window.DormApi?.isCloud() ? "" : "虚拟"}分寝建议 CSV`);
});

async function renderAll() {
  let loaded = true;
  if (window.DormApi?.isCloud()) {
    try {
      const remote = await window.DormApi.getAdminDashboard(selectedClass);
      if (!remote || !remote.classMeta || !Array.isArray(remote.students) || !Array.isArray(remote.groups)) throw new Error("云端返回数据不完整");
      classMeta = remote.classMeta;
      students = remote.students;
      groups = remote.groups;
      updateClassPicker();
      updateSetupView();
      document.getElementById("run-allocation").disabled = !students.length;
    } catch (error) {
      loaded = false;
      classMeta = {}; students = []; groups = [];
      updateClassPicker();
      updateSetupView();
      document.getElementById("run-allocation").disabled = true;
      showToast(`云端数据读取失败：${window.DormApi.userMessage(error)}`);
    }
  } else applyDemoState();
  renderOverview();
  renderStudents();
  renderGroups();
  return loaded;
}

if (validSession()) openWorkspace();
else closeWorkspace("");

// 演示模式在登录卡片上直接给出演示密码,免得新用户翻 README。
if (!window.DormApi?.isCloud()) {
  const hint = document.getElementById("demo-password-hint");
  if (hint) hint.hidden = false;
}
