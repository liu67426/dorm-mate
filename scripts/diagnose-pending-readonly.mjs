// 复用只读快照及拦截保存逻辑；仅在本机内存诊断，不写入学生数据。
import fs from "node:fs";
const auditUrl=new URL("./audit-live-allocation.mjs",import.meta.url);
let source=fs.readFileSync(auditUrl,"utf8").replaceAll("import.meta.url",JSON.stringify(auditUrl.href));
source=source.replace("const context = vm.createContext",`let diagnosticUnits=[];
const core=window.DormAllocation;
window.DormAllocation={...core,allocateAll:(units,options)=>{diagnosticUnits=units;return core.allocateAll(units,options);}};
const context = vm.createContext`);
source+=`
const diagnosticMemberMap=new Map(diagnosticUnits.flatMap(unit=>unit.members.map(member=>[member.id,{member,unitId:unit.id}])));
const externalHardConflicts=[];
for(const room of result.rooms)for(let i=0;i<room.members.length;i++)for(let j=i+1;j<room.members.length;j++){
  const left=diagnosticMemberMap.get(room.members[i].id),right=diagnosticMemberMap.get(room.members[j].id);
  if(left&&right&&left.unitId!==right.unitId){const reason=core.hasHardConflict(left.member,right.member);if(reason)externalHardConflicts.push({room:room.roomNumber,reason});}
}
const cohortAudit={};for(const unit of diagnosticUnits){const key=unit.members[0].classId+'-'+unit.members[0].gender;if(!cohortAudit[key])cohortAudit[key]={students:0,rooms:[],minimumByCapacity:0};cohortAudit[key].students+=unit.members.length;}
for(const room of result.rooms){const key=(room.classId==='shared'?'shared':room.classId)+'-'+room.gender;if(!cohortAudit[key])cohortAudit[key]={students:0,rooms:[],minimumByCapacity:0};cohortAudit[key].rooms.push(room.members.length);}
for(const item of Object.values(cohortAudit))item.minimumByCapacity=Math.ceil(item.students/4);
// 对每个班级/性别的非四人组单元做精确装箱，验证当前寝室数能否在强冲突规则下继续减少。
for(const [key,item] of Object.entries(cohortAudit)){
  const units=diagnosticUnits.filter(unit=>unit.members[0].classId+'-'+unit.members[0].gender===key&&unit.members.length<4);
  units.sort((a,b)=>b.members.length-a.members.length||String(a.id).localeCompare(String(b.id)));
  const fixedCount=diagnosticUnits.filter(unit=>unit.members[0].classId+'-'+unit.members[0].gender===key&&unit.members.length===4).length;
  const seats=units.reduce((sum,unit)=>sum+unit.members.length,0);let nodes=0,solution=null;
  function compatible(parts,unit){return parts.every(part=>part.members.every(a=>unit.members.every(b=>!core.hasHardConflict(a,b))));}
  function fit(index,bins,target){
    if(++nodes>2000000)return false;if(index===units.length){solution=bins.map(bin=>bin.flatMap(unit=>unit.members.map(member=>member.id)));return true;}
    const unit=units[index],seen=new Set();
    for(let i=0;i<bins.length;i++){const used=bins[i].reduce((sum,part)=>sum+part.members.length,0);const signature=bins[i].map(part=>part.id).sort().join('|');if(seen.has(signature)||used+unit.members.length>4||!compatible(bins[i],unit))continue;seen.add(signature);bins[i].push(unit);if(fit(index+1,bins,target))return true;bins[i].pop();}
    if(bins.length<target){bins.push([unit]);if(fit(index+1,bins,target))return true;bins.pop();}
    return false;
  }
  let optimum=null;for(let target=Math.ceil(seats/4);target<=units.length;target++){nodes=0;solution=null;if(fit(0,[],target)){optimum={rooms:fixedCount+target,partialRoomSizes:solution.map(ids=>ids.length).filter(size=>size<4),nodes,proven: nodes<=2000000};break;}if(nodes>2000000)break;}
  item.minimumRespectingHardConflicts=optimum;
}
const publishedAssignmentsPreserved=(snapshot.assignments||[]).every(assignment=>result.rooms.some(room=>room.roomNumber===assignment.room_number&&room.members.some(member=>member.id===assignment.student_id)));
console.log(JSON.stringify({allAssignedAudit:{students:result.rooms.flatMap(room=>room.members).length,pending:result.pending.length,externalHardConflicts:externalHardConflicts.length,publishedAssignmentsPreserved,roomSizes:result.rooms.reduce((counts,room)=>{counts[room.members.length]=(counts[room.members.length]||0)+1;return counts;},{}),cohorts:cohortAudit}},null,2));
const cohort=diagnosticUnits.filter(u=>u.members[0]?.classId==='4' && u.members[0]?.gender==='男');
const pendingIds=new Set(result.pending.filter(s=>s.classId==='4' && s.gender==='男').map(s=>s.id));
const pendingUnits=cohort.filter(u=>u.members.some(s=>pendingIds.has(s.id)));
const flexible=cohort.filter(u=>u.members.length<4 && !core.validateUnit(u).length);
const pendingPeople=pendingUnits.flatMap(u=>u.members);
console.log(JSON.stringify({pendingUnits:pendingUnits.map(u=>({size:u.members.length,internalReasons:u.members.flatMap((a,i)=>u.members.slice(i+1).map(b=>core.hasHardConflict(a,b))).filter(Boolean)}))},null,2));
const conflictCounts={};
for(let i=0;i<pendingPeople.length;i++)for(let j=i+1;j<pendingPeople.length;j++){
  const reason=core.hasHardConflict(pendingPeople[i],pendingPeople[j]);
  if(reason)conflictCounts[reason]=(conflictCounts[reason]||0)+1;
}
// 穷举至多4人的组合，验证待处理者之间是否确实无解。
function enumerate(units){
  const rooms=[];
  function visit(index,selected,members){
    if(members.length===4){rooms.push({selected,members});return;}
    for(let i=index;i<units.length;i++){
      const combined=[...members,...units[i].members];
      if(combined.length>4 || !core.groupCompatibility(combined).compatible)continue;
      visit(i+1,[...selected,i],combined);
    }
  }
  visit(0,[],[]);return rooms;
}
const candidates=enumerate(flexible);
const touching=flexible.map((u,i)=>({unitSize:u.members.length,pending:u.members.some(s=>pendingIds.has(s.id)),candidateRooms:candidates.filter(r=>r.selected.includes(i)).length,internalConflict:!core.groupCompatibility(u.members).compatible}));
// 对可选寝室做精确集合打包，只优化人数，保留完整组、搭档与所有硬约束。
const masks=candidates.map(r=>r.selected.reduce((m,i)=>m|(1n<<BigInt(i)),0n));
const allMask=(1n<<BigInt(flexible.length))-1n;
const memo=new Map();let nodes=0;
function solve(available){
  if(memo.has(available))return memo.get(available);
  if(++nodes>2000000)throw new Error('精确搜索超出诊断上限，未得出最优结论');
  let first=0;while(first<flexible.length && !(available&(1n<<BigInt(first))))first++;
  if(first===flexible.length)return [];
  const bit=1n<<BigInt(first);
  let best=solve(available^bit);
  for(let i=0;i<masks.length;i++)if((masks[i]&bit) && (masks[i]&available)===masks[i]){
    const proposal=[i,...solve(available^masks[i])];if(proposal.length>best.length)best=proposal;
  }
  memo.set(available,best);return best;
}
const optimal=solve(allMask);
console.log(JSON.stringify({diagnostic:'仅本机计算，未保存分配',class4Male:{completed:cohort.reduce((n,u)=>n+u.members.length,0),fullGroups:cohort.filter(u=>u.members.length===4).length,flexibleUnits:flexible.length,pending:pendingPeople.length,pendingUnitSizes:pendingUnits.map(u=>u.members.length),pendingConflictCounts:conflictCounts,compatibleRoomsAmongPending:enumerate(pendingUnits).length,units:touching,compatibleCandidateRooms:candidates.length,currentSuggestedRooms:result.rooms.filter(r=>r.classId==='4'&&r.gender==='男').length,maximumRoomsKeepingRules:optimal.length+cohort.filter(u=>u.members.length===4).length,searchNodes:nodes}},null,2));
`;
await import("data:text/javascript;base64,"+Buffer.from(source).toString("base64"));
