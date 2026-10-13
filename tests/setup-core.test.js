const { test } = require("node:test");
const assert = require("node:assert/strict");
const setup = require("../shared/setup-core.js");

test("首次导入可识别任意班级并保留带逗号的引用字段", () => {
  const data = setup.validateRoster('classId,className,classCode,studentId,name,gender\nclass-a,"示例,一班",A01,DEMO001,同学甲,男\nclass-a,"示例,一班",A01,DEMO002,同学乙,女\n');
  assert.equal(data.classes.length, 1);
  assert.equal(data.records[0].className, "示例,一班");
  assert.equal(data.records.length, 2);
});

test("重复学号、未知班级和重复寝室会阻止导入", () => {
  assert.throws(() => setup.validateRoster("classId,className,classCode,studentId,name,gender\na,一班,A01,1,甲,男\na,一班,A01,1,乙,女"), /学号重复/);
  const classes = [{ classId: "a" }];
  assert.throws(() => setup.validateRooms("roomNumber,classId,gender,capacity\nA101,b,男,4", classes), /不在名单中/);
  assert.throws(() => setup.validateRooms("roomNumber,classId,gender,capacity\nA101,a,男,4\nA101,a,女,4", classes), /寝室号重复/);
});

test("学校代号生成独立的本机存储键", () => {
  assert.notEqual(setup.storageKey("school-a"), setup.storageKey("school-b"));
  assert.throws(() => setup.schoolCode("../bad"));
});
