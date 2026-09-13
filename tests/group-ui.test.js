const {test,before,after}=require("node:test");
const assert=require("node:assert/strict");
const path=require("node:path");
const {pathToFileURL}=require("node:url");
const fs=require("node:fs");
const vm=require("node:vm");
const {chromium}=require("playwright-core");
const root=path.resolve(__dirname,"..");
let browser;
before(async()=>{browser=await chromium.launch({executablePath:"C:/Program Files/Google/Chrome/Application/chrome.exe",headless:true});});
after(async()=>{await browser?.close();});
async function pageFor(file) {
  const page=await browser.newPage();
  // 只加载本地代码、只用虚构数据，不访问线上账号或占用用户浏览器。
  const liveBase=process.env.GROUP_UI_BASE_URL;
  await page.route("https://**/*",route=>liveBase && new URL(route.request().url()).origin===new URL(liveBase).origin
    ? route.continue() : route.fulfill({contentType:"application/javascript",body:""}));
  await page.route("**/shared/config.js*",route=>route.fulfill({contentType:"application/javascript",body:'window.DORM_CONFIG={mode:"mock",envId:""};'}));
  await page.goto(liveBase ? new URL(file,liveBase+"/").href : pathToFileURL(path.join(root,file)).href);
  if(liveBase && await page.title()==="风险提醒") {
    await Promise.all([page.waitForNavigation(),page.locator("#submitBtn").click({timeout:10000})]);
  }
  return page;
}
test("辅导员真实页面排除单人卡片，按确认数分类并使用真实待补位计数",async()=>{
  const page=await pageFor("admin/index.html");
  const result=await page.evaluate(()=>{
    window.DormApi={isCloud:()=>true};
    students=Array.from({length:12},(_,i)=>({id:String(i),name:"测试"+i,classId:"1"}));
    groups=[
      {id:"g-solo",classId:"1",memberIds:["0"],confirmedIds:["0"],score:null,status:"forming"},
      {id:"g-pair",classId:"1",memberIds:["1","2"],confirmedIds:["1","2"],score:null,status:"forming"},
      {id:"g-trio",classId:"1",memberIds:["3","4","5"],confirmedIds:["3","4","5"],score:null,status:"forming"},
      {id:"g-full",classId:"1",memberIds:["6","7","8","9"],confirmedIds:["6","7","8","9"],score:null,status:"complete"},
      {id:"g-review",classId:"1",memberIds:["10","11"],confirmedIds:["10"],score:null,status:"forming"}
    ];
    selectedClass="1";groupFilter="all";renderGroups();renderOverview();
    const all=document.getElementById("group-grid").innerText;
    const count=document.querySelectorAll("#group-grid .group-card").length;
    groupFilter="incomplete";renderGroups();
    const partial=document.querySelectorAll("#group-grid .group-card").length;
    groupFilter="complete";renderGroups();
    return {all,count,partial,complete:document.querySelectorAll("#group-grid .group-card").length,todo:document.getElementById("todo-list").innerText};
  });
  assert.equal(result.count,4);
  assert.equal(result.partial,2);
  assert.equal(result.complete,1);
  assert.doesNotMatch(result.all,/意向组solo/);
  assert.match(result.all,/适配度尚未计算/);
  assert.match(result.all,/待复核/);
  assert.match(result.todo,/共2组/);
  await page.close();
});
test("学生页面区分单人未组队、二三人已保存、四人全确认",async()=>{
  const page=await pageFor("student/index.html");
  const states=await page.evaluate(()=>{
    window.DormApi={isCloud:()=>true};
    return [1,2,3,4].map(size=>{
      const ids=Array.from({length:size},(_,i)=>"s"+i);
      applyCloudState({student:{id:"s0",name:"本人",classId:"1"},group:{id:"g",memberIds:ids,confirmedIds:ids,status:size===4?"complete":"forming"},groupMembers:ids.map(id=>({id,name:"测试"+id,confirmed:true})),outgoingInvites:[],assignment:null});
      stopAssignmentWatcher();
      return {hint:document.getElementById("group-hint").textContent,button:document.getElementById("submit-group").textContent};
    });
  });
  assert.match(states[0].hint,/尚未组队/);
  assert.match(states[1].hint,/2人搭档关系已保存/);
  assert.match(states[2].hint,/3人搭档关系已保存/);
  assert.match(states[3].button,/完整固定组已保存/);
  assert.doesNotMatch(states[1].button,/还差|提交/);
  await page.close();
});
test("正式后台接口保留确认成员且不把缺确认的四人组计入完整组",async()=>{
  const sample=(id,n,confirmed=n)=>({id,class_id:"1",member_ids:Array.from({length:n},(_,i)=>id+i),confirmed_ids:Array.from({length:confirmed},(_,i)=>id+i),status:"complete",compatibility_score:null});
  const window={DORM_CONFIG:{mode:"cloud",envId:"test"},DormGroups:require("../shared/group-core.js"),cloudbase:{init:()=>({rdb:()=>({rpc:async()=>({data:{students:[],surveys:[],groups:[sample("solo",1),sample("pair",2),sample("bad",4,3),sample("full",4)],rooms:[],assignments:[]}})})})}};
  vm.runInNewContext(fs.readFileSync(path.join(root,"shared/api.js"),"utf8"),{window});
  const result=await window.DormApi.getAdminDashboard("all");
  assert.equal(result.classMeta["1"].groups,1);
  assert.equal(result.groups[1].confirmedIds.length,2);
  assert.equal(result.groups[1].score,null);
});

test("读取失败显示中文且不冒报刷新成功，恢复连接后可正常刷新",async()=>{
  const page=await pageFor("student/index.html");
  const result=await page.evaluate(async()=>{
    window.DormApi={...window.DormApi,isCloud:()=>true,getStudentState:async()=>{throw new Error("permission denied for function dorm_student_match_view");}};
    await document.getElementById("refresh-group").onclick();
    const failed={toast:document.getElementById("toast").textContent,hint:document.getElementById("group-hint").textContent,candidates:document.getElementById("group-candidates").textContent,button:document.getElementById("submit-group").textContent,disabled:document.getElementById("refresh-group").disabled};
    window.DormApi.getStudentState=async()=>({student:{id:"s0",name:"测试",classId:"1"},surveyCompleted:true,group:null,groupMembers:[],outgoingInvites:[],assignment:null});
    await document.getElementById("refresh-group").onclick();stopAssignmentWatcher();
    return {failed,recovered:document.getElementById("toast").textContent,solo:document.getElementById("submit-group").textContent};
  });
  assert.match(result.failed.toast,/读取失败/);
  assert.doesNotMatch(result.failed.toast,/已刷新/);
  assert.match(result.failed.hint,/不代表组队已取消/);
  assert.match(result.failed.candidates,/联系辅导员检查访问权限/);
  assert.doesNotMatch(result.failed.candidates,/permission|dorm_student/);
  assert.equal(result.failed.button,"组队状态待同步");
  assert.equal(result.failed.disabled,false);
  assert.equal(result.recovered,"已刷新云端组队状态");
  assert.match(result.solo,/可邀请或等待匹配/);
  await page.close();
});

test("失效邀请提示刷新而非组队成功，空身份不提示刷新成功",async()=>{
  const page=await pageFor("student/index.html");
  const result=await page.evaluate(async()=>{
    window.DormApi={...window.DormApi,isCloud:()=>true,respondInvite:async()=>{throw new Error("邀请不存在或已经处理");},getStudentState:async()=>({student:null})};
    await respondCloudInvite("fake-expired",true);
    const invite=document.getElementById("toast").textContent;
    await document.getElementById("refresh-group").onclick();
    return {invite,empty:document.getElementById("toast").textContent};
  });
  assert.match(result.invite,/已处理或已失效.*刷新/);
  assert.doesNotMatch(result.invite,/已确认加入/);
  assert.match(result.empty,/身份核验/);
  assert.doesNotMatch(result.empty,/已刷新/);
  await page.close();
});

test("辅导员寝室卡片完整展示原组队内部冲突并转义姓名",async()=>{
  const page=await pageFor("admin/index.html");
  await page.setViewportSize({width:390,height:844});
  const output=await page.evaluate(()=>{
    const make=(id,extra={})=>({id,name:id,classId:"4",gender:"男",surveyCompleted:true,smoking:1,smokeTolerance:2,...extra});
    const members=[make("甲<测试>",{smoking:2}),make("乙",{smokeTolerance:1})];
    const allocation=window.DormAllocation.allocateAll([{id:"pair",allConfirmed:true,members}]);
    selectedClass="4";students=members.map(m=>({...m,status:"completed"}));
    generatedRooms=allocation.classes["4"].rooms.map(room=>({...room,classId:"4",gender:"男",note:room.warnings.join("；")}));generatedPending=[];generatedRunId="fixture-only";
    renderRooms();
    const panel=document.getElementById("room-grid");
    return {text:panel.textContent,injected:panel.querySelector("测试")!==null};
  });
  assert.match(output.text,/甲<测试>：仅宿舍外抽烟；乙：完全不能接受烟味/);
  assert.equal(output.injected,false);
  await page.close();
});
