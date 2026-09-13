"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const allocation = require("../shared/allocation-core.js");

function student(id, classId, overrides = {}) {
  return { id, name: `学生${id}`, classId, gender: "男", surveyCompleted: true, sleep: 1, noise: 1, smoking: 1, cleanliness: 2, snoring: 1, study: 2, gamingVoice: 1, ...overrides };
}

test("备用女寝不得把三人搭档与另一两人搭档拆成三加一", () => {
  const units = [
    {id:"trio-f",allConfirmed:true,members:[1,2,3].map(id=>student(id,"1",{gender:"女"}))},
    {id:"pair-f",allConfirmed:true,members:[4,5].map(id=>student(id,"2",{gender:"女"}))}
  ];
  const result = allocation.assignRoomNumbers(allocation.allocateAll(units), [{roomNumber:"51",classId:"shared",gender:"女",capacity:4}]);
  assert.equal(result.rooms[0].members.length,3);
  assert.deepEqual(new Set(result.pending.map(s=>s.id)),new Set([4,5]));
});

test("二人未全确认不能按固定搭档自动分配", () => {
  const result=allocation.allocateClass([{id:"pair",allConfirmed:false,members:[student(1,"1"),student(2,"1")]}]);
  assert.equal(result.review.length,1);
});

test("同班四人确认组优先保留", () => {
  const fixed = { id: "fixed", allConfirmed: true, members: [1, 2, 3, 4].map((id) => student(id, "1")) };
  const result = allocation.allocateAll([fixed]);
  assert.equal(result.classes["1"].rooms.length, 1);
  assert.equal(result.classes["1"].rooms[0].fixed, true);
});

test("跨班组队进入复核而不是自动分配", () => {
  const mixed = { id: "mixed", allConfirmed: true, members: [student(1, "1"), student(2, "2"), student(3, "1"), student(4, "1")] };
  const result = allocation.allocateAll([mixed]);
  assert.equal(result.classes["1"].review.length, 1);
  assert.match(result.classes["1"].review[0].reasons.join(""), /跨班/);
});

test("需要复核的小组仍保留成员清单，不能静默漏人", () => {
  const notFullyConfirmed = { id: "review", allConfirmed: false, members: [1, 2, 3, 4].map((id) => student(id, "1")) };
  const result = allocation.allocateAll([notFullyConfirmed]);
  assert.equal(result.classes["1"].review.length, 1);
  assert.equal(result.classes["1"].review[0].members.length, 4);
  assert.match(result.classes["1"].review[0].reasons.join(""), /尚未全员确认/);
});

test("三人组保持整体并匹配一名单人", () => {
  const trio = { id: "trio", allConfirmed: true, members: [1, 2, 3].map((id) => student(id, "1")) };
  const single = { id: "single", allConfirmed: true, members: [student(4, "1")] };
  const result = allocation.allocateAll([single, trio]);
  assert.equal(result.classes["1"].rooms[0].members.length, 4);
  assert.deepEqual(new Set(result.classes["1"].rooms[0].members.map((item) => item.id)), new Set([1, 2, 3, 4]));
});

test("吸烟习惯与接受程度不相容时不自动组合", () => {
  const cannotAccept = student(1, "1", { smoking: 1, smokeTolerance: 1 });
  const maySmokeInside = student(2, "1", { smoking: 3, smokeTolerance: 3 });
  const result = allocation.pairCompatibility(cannotAccept, maySmokeInside);
  assert.equal(result.compatible, false);
  assert.equal(result.score, -Infinity);
});

test("完全不能接受烟味时不与任何抽烟者自动组合", () => {
  const cannotAccept = student(1, "1", { smoking: 1, smokeTolerance: 1 });
  const smokesOutside = student(2, "1", { smoking: 2, smokeTolerance: 3 });
  assert.equal(allocation.pairCompatibility(cannotAccept, smokesOutside).compatible, false);
});

test("只接受宿舍外抽烟时不与宿舍内抽烟者自动组合", () => {
  const outsideOnlyTolerance = student(1, "1", { smoking: 1, smokeTolerance: 2 });
  const maySmokeInside = student(2, "1", { smoking: 3, smokeTolerance: 3 });
  assert.equal(allocation.pairCompatibility(outsideOnlyTolerance, maySmokeInside).compatible, false);
});

test("只接受宿舍外抽烟时可以与只在宿舍外抽烟者参与匹配", () => {
  const outsideOnlyTolerance = student(1, "1", { smoking: 1, smokeTolerance: 2 });
  const smokesOutside = student(2, "1", { smoking: 2, smokeTolerance: 3 });
  assert.equal(allocation.pairCompatibility(outsideOnlyTolerance, smokesOutside).compatible, true);
});

test("选择可以提前协商时允许与宿舍内抽烟者参与综合匹配", () => {
  const negotiable = student(1, "1", { smoking: 1, smokeTolerance: 3 });
  const maySmokeInside = student(2, "1", { smoking: 3, smokeTolerance: 3 });
  assert.equal(allocation.pairCompatibility(negotiable, maySmokeInside).compatible, true);
});

test("原四人组内部强冲突不拆组但提示辅导员", () => {
  const fixed = {
    id: "fixed-smoke-conflict",
    allConfirmed: true,
    members: [
      student(1, "1", { smoking: 1, smokeTolerance: 1 }),
      student(2, "1", { smoking: 2, smokeTolerance: 3 }),
      student(3, "1"),
      student(4, "1")
    ]
  };
  const rooms = allocation.allocateAll([fixed]).classes["1"].rooms;
  assert.equal(rooms.some(room=>room.members.some(m=>m.id===1)&&room.members.some(m=>m.id===2)),true);
  assert.match(rooms.flatMap(room=>room.warnings).join(""), /吸烟习惯与烟味接受程度/);
});

test("起床、游戏时段、空调、卫生与社交差异会降低适配分", () => {
  const baseline = student(1, "1", {
    wake: 1, gamePeriod: 1, temperature: 1, cleanParticipation: 1, visitors: 1
  });
  const similar = student(2, "1", {
    wake: 1, gamePeriod: 1, temperature: 1, cleanParticipation: 1, visitors: 1
  });
  const different = student(3, "1", {
    wake: 3, gamePeriod: 3, temperature: 3, cleanParticipation: 3, visitors: 3
  });
  assert.equal(allocation.pairCompatibility(baseline, similar).score, 100);
  assert.ok(allocation.pairCompatibility(baseline, different).score < 100);
});

test("学生选择的最看重前三项会真正提高对应维度权重", () => {
  const roommate = student(2, "1", { sleep: 3 });
  const ordinary = allocation.pairCompatibility(student(1, "1", { sleep: 1 }), roommate);
  const prioritized = allocation.pairCompatibility(student(1, "1", { sleep: 1, priorities: ["作息时间"] }), roommate);
  assert.ok(prioritized.score < ordinary.score);
});

test("明确选择的住宿底线会阻止对应强冲突自动匹配", () => {
  const cannotAcceptVisitors = student(1, "1", { dealbreakers: ["频繁带人回寝"] });
  const frequentVisitors = student(2, "1", { visitors: 3 });
  const result = allocation.pairCompatibility(cannotAcceptVisitors, frequentVisitors);
  assert.equal(result.compatible, false);
  assert.match(result.conflicts.join(""), /频繁带人回寝/);
});

test("兴趣相近只作低权重参考，不会覆盖生活底线", () => {
  const first = student(1, "1", { hobbies: ["运动健身", "数码科技"], dealbreakers: ["严重打呼噜"] });
  const second = student(2, "1", { hobbies: ["运动健身", "数码科技"], snoring: 3 });
  const result = allocation.pairCompatibility(first, second);
  assert.equal(result.compatible, false);
  assert.match(result.conflicts.join(""), /严重打呼噜/);
});

test("班内不足四人的剩余学生也分入本班未满寝室", () => {
  const one = { id: "one", allConfirmed: true, members: [student(1, "1")] };
  const two = { id: "two", allConfirmed: true, members: [student(2, "2")] };
  const result = allocation.allocateAll([one, two]);
  assert.equal(result.crossClassPending.length, 0);
  assert.equal(result.classes["1"].rooms[0].members.length, 1);
  assert.equal(result.classes["2"].rooms[0].members.length, 1);
});

test("同班男女生必须分开，人数不足时分别进入未满寝室", () => {
  const units = [
    ...[1, 2].map((id) => ({ id: `m${id}`, allConfirmed: true, members: [student(`m${id}`, "1", { gender: "男" })] })),
    ...[1, 2].map((id) => ({ id: `f${id}`, allConfirmed: true, members: [student(`f${id}`, "1", { gender: "女" })] }))
  ];
  const result = allocation.allocateAll(units);
  assert.equal(result.classes["1"].rooms.length, 2);
  assert.equal(result.crossClassPending.length, 0);
  assert.deepEqual(result.classes["1"].rooms.map(room=>room.gender).sort(),["女","男"]);
});

test("已确认搭档内部强冲突不拆组，补入的其他人不得与其强冲突",()=>{
  const pair={id:"pair",allConfirmed:true,members:[student("a","1",{smoking:2}),student("b","1",{smokeTolerance:1})]};
  const singles=["c","d","e","f"].map(id=>({id,allConfirmed:true,members:[student(id,"1")]}));
  const result=allocation.allocateAll([pair,...singles]);
  assert.equal(result.crossClassPending.length,0);
  assert.equal(result.classes["1"].rooms.flatMap(room=>room.members).length,6);
  const pairRoom=result.classes["1"].rooms.find(room=>room.members.some(member=>member.id==="a"));
  assert.ok(pairRoom.members.some(member=>member.id==="b"));
  for(const member of pairRoom.members.filter(member=>!["a","b"].includes(member.id))){
    assert.equal(allocation.hasHardConflict(member,pair.members[0]),null);
    assert.equal(allocation.hasHardConflict(member,pair.members[1]),null);
  }
  assert.match(pairRoom.warnings.join(""),/吸烟习惯与烟味接受程度不相容/);
});

test("固定组已有寝室号在重新生成时优先保留",()=>{
  const fixed={id:"fixed",allConfirmed:true,preferredRoom:"109",members:[1,2,3,4].map(id=>student(id,"1"))};
  const result=allocation.assignRoomNumbers(allocation.allocateAll([fixed]),[
    {roomNumber:"101",classId:"1",gender:"男",capacity:4,active:true},
    {roomNumber:"109",classId:"1",gender:"男",capacity:4,active:true}
  ]);
  assert.equal(result.rooms[0].roomNumber,"109");
});

test("寝室编号按班级和性别分别分配", () => {
  const male = { id: "male", allConfirmed: true, members: [1, 2, 3, 4].map((id) => student(id, "1", { gender: "男" })) };
  const female = { id: "female", allConfirmed: true, members: [5, 6, 7, 8].map((id) => student(id, "1", { gender: "女" })) };
  const result = allocation.assignRoomNumbers(allocation.allocateAll([female, male]), [
    { roomNumber: "11", classId: "1", gender: "女", capacity: 4, active: true },
    { roomNumber: "101", classId: "1", gender: "男", capacity: 4, active: true }
  ]);
  assert.deepEqual(result.rooms.map((room) => room.roomNumber).sort(), ["101", "11"]);
  assert.equal(result.pending.length, 0);
});

test("211人正式规模可由52间班级寝室和51号机动女寝全部容纳", () => {
  const units = [];
  const inventory = [];
  const counts = { "1": 9, "2": 8, "3": 9, "4": 9 };
  for (const classId of ["1", "2", "3", "4"]) {
    for (let index = 1; index <= 44; index += 1) {
      const id = `m-${classId}-${index}`;
      units.push({ id, allConfirmed: true, members: [student(id, classId, { gender: "男" })] });
    }
    for (let index = 1; index <= counts[classId]; index += 1) {
      const id = `f-${classId}-${index}`;
      units.push({ id, allConfirmed: true, members: [student(id, classId, { gender: "女" })] });
    }
    for (let room = 1; room <= 11; room += 1) inventory.push({ roomNumber: `${classId}${String(room).padStart(2, "0")}`, classId, gender: "男", capacity: 4, active: true });
    for (let room = 1; room <= 2; room += 1) inventory.push({ roomNumber: `${classId}${room}`, classId, gender: "女", capacity: 4, active: true });
  }
  inventory.push({ roomNumber: "51", classId: "shared", gender: "女", capacity: 4, active: true });
  const result = allocation.assignRoomNumbers(allocation.allocateAll(units), inventory);
  assert.equal(result.rooms.length, 53);
  assert.equal(result.rooms.reduce((sum, room) => sum + room.members.length, 0), 211);
  assert.equal(result.pending.length, 0);
  assert.equal(result.rooms.find((room) => room.roomNumber === "51").members.length, 3);
});
