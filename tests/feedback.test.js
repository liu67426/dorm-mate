const {test}=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const vm=require("node:vm");
const window={DORM_CONFIG:{mode:"mock"}};
vm.runInNewContext(fs.readFileSync(path.join(__dirname,"../shared/api.js"),"utf8"),{window});
const message=raw=>window.DormApi.userMessage(new Error(raw));

test("组队和基础服务错误转为正确的中文建议且不暴露内部详情",()=>{
  assert.match(message("permission denied for function dorm_student_match_view"),/访问权限/);
  assert.match(message("Failed to fetch"),/网络/);
  assert.match(message("statement timeout"),/先刷新状态确认结果/);
  assert.match(message("邀请不存在或已经处理"),/邀请已处理或已失效/);
  assert.match(message("加入申请不存在或已经处理"),/加入申请已处理或已失效/);
  assert.match(message("该小组已满或不再有效"),/状态已变化/);
  assert.match(message("你已经加入其他多人小组，不能直接换组"),/已有确认的搭档/);
  assert.equal(message("对方尚未完成问卷"),"对方尚未完成问卷");
  assert.doesNotMatch(message("SQLSTATE 42703 SELECT private_student_name"),/SQL|private|42703/);
  assert.doesNotMatch(message("内部查询错误 SELECT student_id"),/SELECT|student_id/);
});
