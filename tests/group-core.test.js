const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const groupCore = require('../shared/group-core.js');
const group = (n, confirmations = n, status = 'forming') => ({ memberIds: Array.from({length:n}, (_, i) => String(i)), confirmedIds: Array.from({length:confirmations}, (_, i) => String(i)), status });
test('单人即使历史状态写成完整也仍然是未组队', () => {
  assert.equal(groupCore.classify(null).kind, 'solo');
  assert.equal(groupCore.classify(group(1, 1, 'complete')).kind, 'solo');
});
test('二三人全确认是待补位搭档，四人全确认才是完整组', () => {
  assert.equal(groupCore.classify(group(2)).kind, 'partial');
  assert.equal(groupCore.classify(group(3)).kind, 'partial');
  assert.equal(groupCore.classify(group(4,4,'complete')).kind, 'complete');
  assert.equal(groupCore.classify(group(4,3,'complete')).kind, 'review');
  assert.equal(groupCore.classify(group(2,1)).kind, 'review');
});
test('重复成员和驳回记录不能当成完整固定组', () => {
  assert.equal(groupCore.classify({memberIds:['a','a','b','c'],confirmedIds:['a','b','c']}).kind, 'review');
  assert.equal(groupCore.classify(group(4,4,'rejected')).kind, 'inactive');
});
test('分组统计排除单人、空组和异常组', () => {
  assert.deepEqual(groupCore.count([group(1), group(2), group(3), group(4,4,'complete'), group(4,3), group(0,0,'rejected')]), {solo:1,partial:2,complete:1,review:1,inactive:1});
});
test('网页与云函数使用相同的组队分类器', () => {
  assert.equal(fs.readFileSync(path.join(__dirname,'../shared/group-core.js'),'utf8'), fs.readFileSync(path.join(__dirname,'../cloudfunctions/dorm-api/lib/group-core.js'),'utf8'));
});
