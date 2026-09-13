const {test}=require("node:test");
const assert=require("node:assert/strict");
const core=require("../shared/allocation-core.js");
const person=(id,extra={})=>({id,name:id,classId:"4",gender:"男",surveyCompleted:true,smoking:1,smokeTolerance:2,...extra});
const unit=(id,members)=>({id,members,allConfirmed:true});

test("两组内部强冲突不拆组并给辅导员具体警告",()=>{
  const result=core.allocateAll([
    unit("p1",[person("甲",{smoking:2}),person("乙",{smokeTolerance:1})]),
    unit("p2",[person("丙",{lateNoise:true}),person("丁",{dealbreakers:["深夜开麦或外放"]})]),
    unit("s1",[person("戊")]),unit("s2",[person("己")])
  ]);
  assert.equal(result.crossClassPending.length,0);
  assert.equal(result.classes["4"].rooms.flatMap(room=>room.members).length,6);
  for(const original of [["甲","乙"],["丙","丁"]])assert.ok(result.classes["4"].rooms.some(room=>original.every(id=>room.members.some(member=>member.id===id))));
  const warnings=result.classes["4"].rooms.flatMap(room=>room.warnings).join("；");
  assert.match(warnings,/甲：仅宿舍外抽烟；乙：完全不能接受烟味/);
  assert.match(warnings,/丁：不能接受“深夜开麦或外放”；丙：/);
});

test("单人不足及三加三都生成未满寝室",()=>{
  const singles=core.allocateClass([unit("a",[person("甲")]),unit("b",[person("乙")])]);
  assert.equal(singles.pending.length,0);assert.equal(singles.rooms[0].members.length,2);
  const trios=core.allocateClass([unit("a",[1,2,3].map(String).map(id=>person(id))),unit("b",[4,5,6].map(String).map(id=>person(id)))]);
  assert.equal(trios.pending.length,0);assert.deepEqual(trios.rooms.map(room=>room.members.length),[3,3]);
});

test("剩余单人强冲突不放一起，原四人意向组不拆并提示",()=>{
  const members=[person("甲",{smoking:3}),person("乙"),person("丙"),person("丁")];
  const result=core.allocateClass(members.map(p=>unit(p.id,[p])));
  assert.equal(result.pending.length,0);
  assert.equal(result.rooms.flatMap(room=>room.members).length,4);
  const fixed=core.allocateClass([unit("fixed",members)]);
  assert.equal(fixed.rooms.length,1);
  assert.equal(fixed.rooms.some(room=>room.members.some(m=>m.id==="甲")&&room.members.some(m=>m.id==="乙")),true);
  assert.match(fixed.rooms.flatMap(room=>room.warnings).join(""),/乙：只接受宿舍外抽烟/);
});

test("网页与云函数的原因生成规则一致",()=>{
  const fs=require("node:fs"),path=require("node:path");
  assert.equal(fs.readFileSync(path.join(__dirname,"../shared/allocation-core.js"),"utf8"),fs.readFileSync(path.join(__dirname,"../cloudfunctions/dorm-api/lib/allocation-core.js"),"utf8"));
});
