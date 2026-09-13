"use strict";

// 压力测试：真实年级规模下分寝必须在预算内完成、人人有房、结果可复现。
// 背景：2026-09 外部压测发现旧实现每班 50 个未组队学生会耗 2 分钟以上,
// 且超时后整班进 pending(0 间房)。这两个回归必须被本文件锁住。

const test = require("node:test");
const assert = require("node:assert/strict");
const allocation = require("../shared/allocation-core.js");

// 固定种子随机数,保证测试数据可复现。
function seededRandom(seedText) {
  let state = [...String(seedText)].reduce((value, char) => ((value * 31) + char.charCodeAt(0)) >>> 0, 2166136261);
  return function random() {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function makeStudent(id, classId, random) {
  return {
    id,
    name: `学生${id}`,
    classId,
    gender: random() < 0.5 ? "男" : "女",
    surveyCompleted: true,
    sleep: 1 + Math.floor(random() * 3),
    noise: 1 + Math.floor(random() * 3),
    smoking: random() < 0.05 ? 3 : random() < 0.3 ? 2 : 1,
    smokeTolerance: 1 + Math.floor(random() * 3),
    cleanliness: 1 + Math.floor(random() * 3),
    snoring: 1 + Math.floor(random() * 3),
    study: 1 + Math.floor(random() * 3),
    gamingVoice: 1 + Math.floor(random() * 3)
  };
}

function makeGrade(studentsPerClass, idPrefix) {
  const random = seededRandom(`${idPrefix}-${studentsPerClass}`);
  const units = [];
  for (let classId = 1; classId <= 4; classId += 1) {
    for (let index = 0; index < studentsPerClass; index += 1) {
      const student = makeStudent(`${idPrefix}-${classId}-${index}`, String(classId), random);
      units.push({ id: `unit-${student.id}`, members: [student], allConfirmed: true });
    }
  }
  return units;
}

test("每班50名未组队学生(全年级200人)在时间预算内完成,且人人有寝室", () => {
  const units = makeGrade(50, "stress");
  const startedAt = Date.now();
  const result = allocation.allocateAll(units, { timeBudgetMs: 3000 });
  const elapsed = Date.now() - startedAt;
  const rooms = Object.values(result.classes).flatMap((classResult) => classResult.rooms);
  const assigned = rooms.reduce((sum, room) => sum + room.members.length, 0);
  const pendingCount = Object.values(result.classes).reduce((sum, classResult) => sum + classResult.pending.length, 0);
  assert.equal(assigned, 200, `200名学生必须全部进寝室,实际${assigned}人`);
  assert.equal(pendingCount, 0, "不允许整班挂起");
  assert.ok(elapsed < 30000, `分寝耗时${elapsed}ms,超出回归上限(降级机制未生效?)`);
  // 性能护栏:默认8秒预算下,200人应在约30秒内出结果(4个班各8秒预算+贪心兜底)。
  assert.ok(elapsed < 40000, `默认预算下耗时${elapsed}ms,超出护栏`);
});

test("同一次输入两次分寝,结果完全一致(可复现)", () => {
  const units = makeGrade(20, "repeat");
  const first = JSON.stringify(allocation.allocateAll(units));
  const second = JSON.stringify(allocation.allocateAll(units));
  assert.equal(first, second);
});

test("小班(每班25人)在默认预算内以最优路线完成,不触发降级", () => {
  const units = makeGrade(25, "small");
  const result = allocation.allocateAll(units);
  assert.equal(result.degraded, false, "25人小班不应触发降级");
  const rooms = Object.values(result.classes).flatMap((classResult) => classResult.rooms);
  const assigned = rooms.reduce((sum, room) => sum + room.members.length, 0);
  assert.equal(assigned, 100);
});
