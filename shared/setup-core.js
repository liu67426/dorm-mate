(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.DormSetup = api;
}(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  // CSV 允许带引号的逗号、换行和双引号，避免直接 split(",") 拆坏姓名或班级名。
  function parseCsv(source) {
    const text = String(source || "").replace(/^\uFEFF/, "");
    const rows = [];
    let row = [], field = "", quoted = false;
    for (let index = 0; index < text.length; index += 1) {
      const char = text[index];
      if (quoted) {
        if (char === '"' && text[index + 1] === '"') { field += '"'; index += 1; }
        else if (char === '"') quoted = false;
        else field += char;
      } else if (char === '"') {
        if (field.trim()) throw new Error("CSV 引号位置不正确");
        quoted = true;
      } else if (char === ",") {
        row.push(field.trim()); field = "";
      } else if (char === "\n" || char === "\r") {
        if (char === "\r" && text[index + 1] === "\n") index += 1;
        row.push(field.trim()); field = "";
        if (row.some(Boolean)) rows.push(row);
        row = [];
      } else field += char;
    }
    if (quoted) throw new Error("CSV 引号没有闭合");
    row.push(field.trim());
    if (row.some(Boolean)) rows.push(row);
    return rows;
  }

  function recordsFromCsv(source, required) {
    const rows = parseCsv(source);
    if (rows.length < 2) throw new Error("文件只有表头或没有数据");
    const header = rows[0];
    const missing = required.filter(name => !header.includes(name));
    if (missing.length) throw new Error(`缺少列：${missing.join("、")}`);
    if (new Set(header).size !== header.length) throw new Error("表头有重复列");
    return rows.slice(1).map((row, index) => {
      if (row.length !== header.length) throw new Error(`第${index + 2}行的列数与表头不同`);
      return Object.fromEntries(header.map((name, position) => [name, row[position]]));
    });
  }

  function validateRoster(source) {
    const required = ["classId", "className", "classCode", "studentId", "name", "gender"];
    const records = recordsFromCsv(source, required);
    const classes = new Map(), studentIds = new Set();
    records.forEach((record, index) => {
      const line = index + 2;
      if (required.some(name => !record[name])) throw new Error(`第${line}行有必填项为空`);
      if (!/^[A-Za-z0-9_-]{1,32}$/.test(record.classId)) throw new Error(`第${line}行班级编号只能用字母、数字、下划线或横线`);
      if (record.classId === "shared") throw new Error("班级编号不能使用 shared");
      if (!["男", "女"].includes(record.gender)) throw new Error(`第${line}行性别只能填男或女`);
      if (studentIds.has(record.studentId)) throw new Error(`学号重复：${record.studentId}`);
      studentIds.add(record.studentId);
      const earlier = classes.get(record.classId);
      if (earlier && (earlier.className !== record.className || earlier.classCode !== record.classCode)) {
        throw new Error(`班级 ${record.classId} 的名称或填写码前后不一致`);
      }
      classes.set(record.classId, { classId: record.classId, className: record.className, classCode: record.classCode });
    });
    const names = new Set(), codes = new Set();
    classes.forEach(item => {
      if (names.has(item.className)) throw new Error(`班级名称重复：${item.className}`);
      if (codes.has(item.classCode)) throw new Error(`班级填写码重复：${item.classCode}`);
      names.add(item.className);
      codes.add(item.classCode);
    });
    return { records: records.map(({ classId, className, classCode, studentId, name, gender }) => ({ classId, className, classCode, studentId, name, gender })), classes: [...classes.values()] };
  }

  function validateRooms(source, classes) {
    const required = ["roomNumber", "classId", "gender", "capacity"];
    const records = recordsFromCsv(source, required);
    const classIds = new Set(classes.map(item => item.classId));
    const numbers = new Set();
    records.forEach((record, index) => {
      const line = index + 2;
      if (required.some(name => !record[name])) throw new Error(`寝室文件第${line}行有必填项为空`);
      if (!classIds.has(record.classId)) throw new Error(`寝室 ${record.roomNumber} 的班级 ${record.classId} 不在名单中`);
      if (!["男", "女"].includes(record.gender)) throw new Error(`寝室文件第${line}行性别只能填男或女`);
      if (Number(record.capacity) !== 4) throw new Error(`寝室 ${record.roomNumber} 目前只支持四人间`);
      if (numbers.has(record.roomNumber)) throw new Error(`寝室号重复：${record.roomNumber}`);
      numbers.add(record.roomNumber);
    });
    return records.map(({ roomNumber, classId, gender }) => ({ roomNumber, classId, gender, capacity: 4, active: true }));
  }

  function schoolCode(value) {
    const code = String(value || "").trim().toLowerCase();
    if (!/^[a-z0-9_-]{3,32}$/.test(code)) throw new Error("学校代号须为3—32位英文字母、数字、下划线或横线");
    return code;
  }

  function storageKey(code) { return `dorm-setup-v1:${schoolCode(code)}`; }

  function readSetup(storage, code) {
    try { return JSON.parse(storage.getItem(storageKey(code))) || null; }
    catch { return null; }
  }

  function saveSetup(storage, code, setup) {
    storage.setItem(storageKey(code), JSON.stringify(setup));
  }

  return { parseCsv, validateRoster, validateRooms, schoolCode, storageKey, readSetup, saveSetup };
}));
