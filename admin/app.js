"use strict";

const AUTH_KEY = "counselor-demo-auth-v1";
const FAIL_KEY = "counselor-demo-fails-v1";
const LOCK_KEY = "counselor-demo-lock-v1";
const SESSION_LENGTH = 15 * 60 * 1000;

let classMeta = {
  "1": { name: "工业机器人1班", total: 42, submitted: 36, groups: 5, review: 3 },
  "2": { name: "工业机器人2班", total: 41, submitted: 34, groups: 4, review: 2 },
  "3": { name: "工业机器人3班", total: 43, submitted: 37, groups: 6, review: 3 },
  "4": { name: "工业机器人4班", total: 42, submitted: 35, groups: 5, review: 2 }
};

const habits = [
  ["22:50休息 · 06:40起床", "偶尔游戏 · 全程耳机", "不抽烟", "作息稳定"],
  ["23:20休息 · 07:00起床", "经常游戏 · 偶尔开麦", "不抽烟", "机械键盘"],
  ["22:30休息 · 06:30起床", "基本不玩游戏", "不抽烟", "睡眠较浅"],
  ["00:10休息 · 07:20起床", "经常游戏 · 全程耳机", "不抽烟", "晚睡型"],
  ["23:00休息 · 06:50起床", "偶尔游戏 · 不开麦", "不抽烟", "卫生主动"],
  ["23:40休息 · 07:10起床", "偶尔游戏 · 偶尔开麦", "不抽烟", "空调适中"],
  ["22:40休息 · 06:40起床", "基本不玩游戏", "不抽烟", "安静型"],
  ["00:30休息 · 07:30起床", "经常游戏 · 经常开麦", "不抽烟", "经常开麦"],
  ["23:10休息 · 06:50起床", "偶尔游戏 · 全程耳机", "只在宿舍外抽烟", "吸烟习惯已填写"],
  ["23:50休息 · 07:00起床", "经常游戏 · 偶尔开麦", "不抽烟", "卫生一般"],
  ["未填写", "未填写", "未填写", "等待问卷"],
  ["未填写", "未填写", "未填写", "等待问卷"],
  ["23:00休息 · 06:40起床", "偶尔游戏 · 全程耳机", "不抽烟", "卫生主动"],
  ["23:15休息 · 06:55起床", "偶尔游戏 · 不开麦", "不抽烟", "安静型"],
  ["22:45休息 · 06:35起床", "基本不玩游戏", "不抽烟", "作息稳定"],
  ["23:30休息 · 07:00起床", "偶尔游戏 · 全程耳机", "不抽烟", "沟通直接"]
];

let students = Object.keys(classMeta).flatMap((classId) => habits.map((habit, index) => {
  const number = index + 1;
  return {
    id: `${classId}-${number}`,
    classId,
    name: `示例学生${classId}-${String(number).padStart(2, "0")}`,
    sid: `2026****${classId}${String(number).padStart(2, "0")}`,
    status: number === 11 || number === 12 ? "pending" : number >= 8 && number <= 10 ? "review" : "completed",
    sleep: habit[0], game: habit[1], smoking: habit[2], tag: habit[3]
  };
}));

let groups = Object.keys(classMeta).flatMap((classId) => [
  { id: `${classId}-A`, classId, memberIds: [1, 2, 3, 4].map((n) => `${classId}-${n}`), score: 91 },
  { id: `${classId}-B`, classId, memberIds: [5, 6, 7].map((n) => `${classId}-${n}`), score: 86 },
  { id: `${classId}-C`, classId, memberIds: [8, 9].map((n) => `${classId}-${n}`), score: 79 },
  { id: `${classId}-D`, classId, memberIds: [13, 14, 15, 16].map((n) => `${classId}-${n}`), score: 94 }
]).map(group => ({...group, confirmedIds:[...group.memberIds], status:group.memberIds.length === 4 ? "complete" : "forming"}));

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

function showToast(message) {
  const toast = document.getElementById("toast");
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 2400);
}

function validSession() {
  const timestamp = Number(sessionStorage.getItem(AUTH_KEY));
  return timestamp > 0 && Date.now() - timestamp < SESSION_LENGTH;
}

async function openWorkspace() {
  sessionStorage.setItem(AUTH_KEY, String(Date.now()));
  loginView.hidden = true;
  app.hidden = false;
  await renderAll();
}

function closeWorkspace(message = "已安全退出工作台") {
  sessionStorage.removeItem(AUTH_KEY);
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
  sessionStorage.setItem(AUTH_KEY, String(Date.now()));
});

const pageTitles = { overview: "工作台总览", surveys: "问卷管理", groups: "组队审核", allocation: "分寝建议" };
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
  showToast(selectedClass === "all" ? "已切换到全部4个班" : `已切换到${classMeta[selectedClass].name}`);
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
  document.getElementById("roster-notice-title").textContent = `正式名单已导入 · ${summary.total}名学生`;
  document.getElementById("roster-notice-text").textContent = selectedClass === "all" ? "工业机器人1—4班名单已接入，系统按班级和性别严格分开匹配。" : `${classMeta[selectedClass].name}名单已接入，学生之间不展示完整问卷。`;
  document.getElementById("roster-notice-badge").textContent = window.DormApi?.isCloud() ? "正式运行" : "本机演示";
  document.getElementById("metric-total").textContent = summary.total;
  document.getElementById("metric-submitted").textContent = summary.submitted;
  document.getElementById("metric-rate").textContent = `完成率 ${summary.total ? Math.round(summary.submitted / summary.total * 100) : 0}%`;
  document.getElementById("metric-groups").textContent = summary.groups;
  document.getElementById("metric-review").textContent = summary.review;
  document.getElementById("class-cards").innerHTML = Object.entries(classMeta).map(([id, item]) => {
    const rate = item.total ? Math.round(item.submitted / item.total * 100) : 0;
    const capacity = Number.isFinite(item.maleBeds) ? `男${item.male || 0}/${item.maleBeds}床 · 女${item.female || 0}/${item.femaleBeds}床` : `${item.groups}个完整四人组`;
    return `<article class="class-card" data-class-card="${id}"><div class="class-card-head"><h3>${item.name}</h3><span>${rate}%</span></div><div class="mini-progress"><i style="width:${rate}%"></i></div><small>${item.submitted}人已填 / ${item.total}人 · ${capacity}</small></article>`;
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
  generatedRooms = [];
  activeClassIds().forEach((classId) => {
    const eligible = students.filter((student) => student.classId === classId && student.status !== "pending");
    const used = new Set();
    groups.filter((group) => group.classId === classId && group.memberIds.length === 4).forEach((group) => {
      const members = group.memberIds.map((id) => students.find((student) => student.id === id)).filter(Boolean);
      members.forEach((member) => used.add(member.id));
      generatedRooms.push({ classId, members, fixed: true, note: "完整意向组，四人均已填写问卷并确认" });
    });
    const remaining = eligible.filter((student) => !used.has(student.id)).sort((a, b) => a.sleep.localeCompare(b.sleep));
    for (let index = 0; index < remaining.length; index += 4) {
      const members = remaining.slice(index, index + 4);
      generatedRooms.push({ classId, members, fixed: false, note: members.some((member) => member.status === "review") ? "包含已提交的特殊住宿需求，请辅导员确认床位" : "按作息与生活习惯生成的演示建议" });
    }
  });
  renderRooms();
  showToast(`已生成${generatedRooms.length}间演示寝室建议`);
}

function renderRooms() {
  document.getElementById("allocation-empty").style.display = "none";
  const grid = document.getElementById("room-grid");
  grid.classList.add("show");
  grid.innerHTML = generatedRooms.map((room, index) => { const className = room.classId === "shared" ? "跨班机动女寝" : classMeta[room.classId].name; return `<article class="room-card"><div class="room-card-head"><div><h3>${className} · ${escapeHtml(room.roomNumber || `建议寝室${String(index + 1).padStart(2, "0")}`)}</h3><small>${escapeHtml(room.gender || "未登记性别")}寝 · 4人间</small></div><span>${room.fixed ? "固定意向组" : room.members.length === 4 ? "系统建议" : `待补${4 - room.members.length}人`}</span></div><ul>${room.members.map((member) => `<li><b>${escapeHtml(member.name)}</b><span>${escapeHtml(member.tag)}</span></li>`).join("")}</ul><p>${escapeHtml(room.note)}</p><p class="bed-rule">发布后学生可查看寝室号和同寝室成员</p></article>`; }).join("");
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
  if (window.DormApi?.isCloud()) {
    try {
      const remote = await window.DormApi.getAdminDashboard(selectedClass);
      if (remote?.classMeta) classMeta = remote.classMeta;
      if (Array.isArray(remote?.students)) students = remote.students;
      if (Array.isArray(remote?.groups)) groups = remote.groups;
    } catch (error) {
      showToast(`云端数据读取失败：${window.DormApi.userMessage(error)}`);
    }
  }
  renderOverview();
  renderStudents();
  renderGroups();
}

if (validSession()) openWorkspace();
else closeWorkspace("");

// 演示模式在登录卡片上直接给出演示密码,免得新用户翻 README。
if (!window.DormApi?.isCloud()) {
  const hint = document.getElementById("demo-password-hint");
  if (hint) hint.hidden = false;
}
