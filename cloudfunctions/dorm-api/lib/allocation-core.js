(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.DormAllocation = api;
}(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  // 所有分值都归一化到 1—3。权重越高，生活差异对最终分数影响越大。
  const DEFAULT_WEIGHTS = Object.freeze({
    sleep: 4, wake: 3, weekendShift: 1, alarm: 2, nap: 1, sleepDepth: 2,
    noise: 4, soundSensitivity: 2, gameFrequency: 1, gameHours: 1, gamePeriod: 2,
    gamingVoice: 3, audioDiscipline: 2, excitedNoise: 2, lateGaming: 2,
    mechanicalKeyboard: 1, speaker: 2, calls: 1,
    smoking: 5, smellSensitivity: 1, snoring: 2, temperature: 3, coldSensitive: 1,
    cleanliness: 3, cleanParticipation: 2, trash: 2, laundry: 1,
    borrow: 1, foodShare: 0.5, sharedItems: 1, showerTime: 0.5,
    study: 2, socialStyle: 2, visitors: 2, visitorTolerance: 1,
    quietHours: 2, weekendActivity: 1
  });
  const PRIORITY_FEATURES = Object.freeze({
    "作息时间": ["sleep", "wake", "weekendShift", "alarm", "nap", "sleepDepth"],
    "卫生习惯": ["cleanliness", "cleanParticipation", "trash", "laundry", "showerTime"],
    "安静程度": ["noise", "soundSensitivity", "speaker", "calls", "quietHours", "afterLights"],
    "吸烟习惯相容": ["smoking", "smellSensitivity"],
    "空调温度": ["temperature", "coldSensitive"],
    "游戏习惯": ["gameFrequency", "gameHours", "gamePeriod", "gamingVoice", "audioDiscipline", "excitedNoise", "lateGaming", "mechanicalKeyboard", "gameGenres", "gameDevices"],
    "沟通方式": ["socialStyle", "visitors", "visitorTolerance", "conflictStyle", "borrow", "foodShare", "sharedItems"],
    "兴趣相近": ["hobbies", "gameGenres", "gameDevices"]
  });
  const VERSION = "formal-v4.3";
  // 单班回溯搜索的时间预算（毫秒）：超时后降级为贪心装箱，保证辅导员一定能拿到结果。
  const DEFAULT_TIME_BUDGET_MS = 8000;

  // 仅用于辅导员的分配说明；不把自由文本或特殊需求加入自动判定。
  function explainPairConflicts(a, b) {
    const details = [];
    for (const [person, roommate] of [[a, b], [b, a]]) {
      const tolerance = Number(person.smokeTolerance || 2), smoking = Number(roommate.smoking || 1);
      if ((tolerance === 1 && smoking >= 2) || (tolerance === 2 && smoking === 3)) {
        details.push(`${roommate.name}：${smoking === 3 ? "宿舍内抽烟" : "仅宿舍外抽烟"}；${person.name}：${tolerance === 1 ? "完全不能接受烟味" : "只接受宿舍外抽烟"}，吸烟习惯与烟味接受程度不相容`);
      }
      for (const conflict of dealbreakerConflict(person, roommate)) {
        const evidence = {
          "宿舍内抽烟": "填写了宿舍内抽烟",
          "深夜开麦或外放": [
            Number(roommate.speaker) === 3 ? "填写了经常外放" : "",
            Number(roommate.gamePeriod) >= 2.5 ? `游戏时段为${Number(roommate.gamePeriod) === 3 ? "01:00以后" : "23:00—01:00"}` : "",
            Number(roommate.gamingVoice) >= 2 ? `语音习惯为${Number(roommate.gamingVoice) === 3 ? "经常多人语音" : "经常开麦"}` : "",
            Number(roommate.excitedNoise) >= 2 ? `游戏激动时${Number(roommate.excitedNoise) === 3 ? "经常大声说话或敲桌" : "偶尔提高音量"}` : "",
            Number(roommate.lateGaming) === 3 ? "勾选了可能因游戏熬夜" : ""
          ].filter(Boolean).join("、") || "深夜声音相关指标触发了该底线（需核实实际情况）",
          "长期不打扫": [Number(roommate.cleanParticipation || 2) === 1 ? "打扫参与度为1分（5分制）" : "", Number(roommate.trash || 2) === 3 ? "垃圾处理经常需要别人提醒" : ""].filter(Boolean).join("、"),
          "频繁带人回寝": "填写了经常带人来往",
          "严重打呼噜": "填写了别人提醒打鼾比较明显",
          "空调温度差异大": "双方选择的空调温度区间差异较大，且均未选择不太在意"
        }[conflict];
        details.push(`${person.name}：不能接受“${conflict}”；${roommate.name}：${evidence}`);
      }
    }
    return [...new Set(details)];
  }

  function explainGroupConflicts(members) {
    return members.flatMap((a, index) => members.slice(index + 1).flatMap(b => explainPairConflicts(a, b)));
  }

  function explainPending(units) {
    const internal = new Map(units.map(unit => [unit.id, explainGroupConflicts(unit.members)]));
    const usable = units.filter(unit => !internal.get(unit.id).length);
    const usableCount = usable.reduce((sum, unit) => sum + unit.members.length, 0);
    return units.flatMap(unit => {
      let reason;
      if (internal.get(unit.id).length) {
        reason = `搭档内部存在习惯冲突：${internal.get(unit.id).join("；")}。搭档关系已保留，请辅导员与双方确认后再安排补位。`;
      } else if (usableCount < 4) {
        reason = `人数不足：本轮剩余可继续匹配的同班同性别学生共${usableCount}人，不足4人（待确认组内冲突的搭档不计入）。不代表这些同学彼此不兼容，请等待补位或由辅导员安排。`;
      } else {
        const others = usable.filter(other => other.id !== unit.id);
        const reachable = new Set([0]);
        for (const other of others) for (const seats of [...reachable]) if (seats + other.members.length <= 4 - unit.members.length) reachable.add(seats + other.members.length);
        if (!reachable.has(4 - unit.members.length)) {
          reason = `组队人数结构限制：剩余搭档/单人单元为${usable.map(item => item.members.length).join("＋")}人，保留搭档不拆组时无法为本组凑成4人，请辅导员协调补位。`;
        } else {
          const details = [...new Set(others.flatMap(other => unit.members.flatMap(a => other.members.flatMap(b => explainPairConflicts(a, b)))))];
          reason = details.length
            ? `本轮未找到同时满足4人容量、搭档完整与生活底线的组合。与剩余同学存在以下不兼容示例：${details.slice(0, 4).join("；")}${details.length > 4 ? `；另有${details.length - 4}项` : ""}。请辅导员核实协调。`
            : "本轮搜索未找到可用的4人组合；不能据此断定没有合适室友，请辅导员复核组合安排。";
        }
      }
      return unit.members.map(member => ({...member, unitId: unit.id, reason}));
    });
  }

  function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }

  function dealbreakerConflict(person, roommate) {
    const dealbreakers = new Set(Array.isArray(person.dealbreakers) ? person.dealbreakers : []);
    const conflicts = [];
    if (dealbreakers.has("宿舍内抽烟") && Number(roommate.smoking || 1) === 3) conflicts.push("宿舍内抽烟");
    if (dealbreakers.has("深夜开麦或外放") && roommate.lateNoise) conflicts.push("深夜开麦或外放");
    if (dealbreakers.has("长期不打扫") && (Number(roommate.cleanParticipation || 2) === 1 || Number(roommate.trash || 2) === 3)) conflicts.push("长期不打扫");
    if (dealbreakers.has("频繁带人回寝") && Number(roommate.visitors || 1) === 3) conflicts.push("频繁带人回寝");
    if (dealbreakers.has("严重打呼噜") && Number(roommate.snoring || 1) === 3) conflicts.push("严重打呼噜");
    if (dealbreakers.has("空调温度差异大") && !person.temperatureFlexible && !roommate.temperatureFlexible && Math.abs(Number(person.temperature || 2) - Number(roommate.temperature || 2)) >= 1.5) conflicts.push("空调温度差异大");
    return conflicts;
  }

  function hasHardConflict(a, b) {
    function exceedsTolerance(person, roommate) {
      const tolerance = Number(person.smokeTolerance || 2);
      const smoking = Number(roommate.smoking || 1);
      if (tolerance === 1) return smoking >= 2;
      if (tolerance === 2) return smoking === 3;
      return false;
    }
    if (exceedsTolerance(a, b) || exceedsTolerance(b, a)) return "双方填写的吸烟习惯与烟味接受程度不相容";
    const conflicts = [...dealbreakerConflict(a, b), ...dealbreakerConflict(b, a)];
    return conflicts.length ? `住宿底线冲突：${[...new Set(conflicts)].join("、")}` : null;
  }

  function normalizedDistance(a, b, key) {
    if (key === "temperature" && (a.temperatureFlexible || b.temperatureFlexible)) return 0;
    if (key === "quietHours" && (a.quietHoursFlexible || b.quietHoursFlexible)) return 0;
    const left = Number(a[key] || 2), right = Number(b[key] || 2);
    return Math.abs(left - right) / 2;
  }

  function setDistance(left, right) {
    const first = new Set(Array.isArray(left) ? left.filter(Boolean) : []);
    const second = new Set(Array.isArray(right) ? right.filter(Boolean) : []);
    if (!first.size || !second.size) return 0;
    const union = new Set([...first, ...second]);
    let overlap = 0;
    first.forEach((item) => { if (second.has(item)) overlap += 1; });
    return 1 - overlap / union.size;
  }

  function categoricalDistance(left, right) {
    if (!left || !right || left === right) return 0;
    return 0.5;
  }

  function priorityBoost(person, key) {
    let boost = 0;
    Object.entries(PRIORITY_FEATURES).forEach(([category, features]) => {
      if (!features.includes(key)) return;
      const rank = (person.priorities || []).indexOf(category);
      boost = Math.max(boost, [1, 0.6, 0.3][rank] || 0);
    });
    return boost;
  }

  function personalizedWeight(a, b, key, baseWeight) {
    return Number(baseWeight || 0) * (1 + (priorityBoost(a, key) + priorityBoost(b, key)) / 2);
  }

  function pairCompatibility(a, b, weights = DEFAULT_WEIGHTS) {
    const conflict = hasHardConflict(a, b);
    if (conflict) return { compatible: false, score: -Infinity, conflicts: [conflict] };
    let penalty = 0, totalWeight = 0;
    Object.entries(weights).forEach(([key, baseWeight]) => {
      const weight = personalizedWeight(a, b, key, baseWeight);
      penalty += normalizedDistance(a, b, key) * weight;
      totalWeight += weight;
    });
    [
      ["afterLights", 1, setDistance],
      ["conflictStyle", 1, categoricalDistance],
      ["hobbies", 0.75, setDistance],
      ["gameGenres", 0.75, setDistance],
      ["gameDevices", 0.4, setDistance]
    ].forEach(([key, baseWeight, distance]) => {
      const weight = personalizedWeight(a, b, key, baseWeight);
      penalty += distance(a[key], b[key]) * weight;
      totalWeight += weight;
    });
    // 除了比较“双方是否相似”，还要检查一方的行为会不会正好影响另一方的敏感点。
    [
      ["noise", 3, Math.max(((Number(a.soundSensitivity || 2) - 1) * (Number(b.noise || 2) - 1)) / 4, ((Number(b.soundSensitivity || 2) - 1) * (Number(a.noise || 2) - 1)) / 4)],
      ["visitors", 2, Math.max(((Number(a.visitorTolerance || 2) - 1) * (Number(b.visitors || 2) - 1)) / 4, ((Number(b.visitorTolerance || 2) - 1) * (Number(a.visitors || 2) - 1)) / 4)]
    ].forEach(([key, baseWeight, distance]) => {
      const weight = personalizedWeight(a, b, key, baseWeight);
      penalty += distance * weight;
      totalWeight += weight;
    });
    const score = Math.round(clamp(100 * (1 - penalty / totalWeight), 0, 100));
    return { compatible: true, score, conflicts: [] };
  }

  // 大班分寝时同一对学生会被反复比较；按学生ID缓存两两结果，避免组合搜索退化成秒级等待。
  function createPairCache() { return new Map(); }

  function cachedPairCompatibility(a, b, weights, cache) {
    if (!cache) return pairCompatibility(a, b, weights);
    const key = a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`;
    let result = cache.get(key);
    if (!result) {
      result = pairCompatibility(a, b, weights);
      cache.set(key, result);
    }
    return result;
  }

  function groupCompatibility(members, weights = DEFAULT_WEIGHTS, cache = null) {
    if (members.length < 2) return { compatible: true, score: 100, conflicts: [] };
    const scores = [], conflicts = [];
    for (let i = 0; i < members.length; i += 1) {
      for (let j = i + 1; j < members.length; j += 1) {
        const result = cachedPairCompatibility(members[i], members[j], weights, cache);
        if (!result.compatible) conflicts.push(`${members[i].name} / ${members[j].name}：${result.conflicts[0]}`);
        else scores.push(result.score);
      }
    }
    return { compatible: conflicts.length === 0, score: conflicts.length ? -Infinity : Math.round(scores.reduce((sum, score) => sum + score, 0) / scores.length), conflicts };
  }

  // 不同组队单元之间必须通过住宿底线；原组队内部差异不在这里拆组。
  function unitCompatibility(units, weights = DEFAULT_WEIGHTS, cache = null) {
    const scores = [], conflicts = [];
    for (let left = 0; left < units.length; left += 1) {
      for (let right = left + 1; right < units.length; right += 1) {
        for (const a of units[left].members) for (const b of units[right].members) {
          const result = cachedPairCompatibility(a, b, weights, cache);
          if (!result.compatible) conflicts.push(...explainPairConflicts(a, b));
          else scores.push(result.score);
        }
      }
    }
    return { compatible: conflicts.length === 0, score: conflicts.length ? -Infinity : (scores.length ? Math.round(scores.reduce((sum, score) => sum + score, 0) / scores.length) : 100), conflicts };
  }

  function validateUnit(unit) {
    const errors = [];
    if (!unit.members?.length || unit.members.length > 4) errors.push("组队人数必须为1至4人");
    if (new Set(unit.members.map((member) => member.id)).size !== unit.members.length) errors.push("组内存在重复学生");
    if (new Set(unit.members.map((member) => member.classId)).size > 1) errors.push("组内存在跨班成员");
    if (new Set(unit.members.map((member) => member.gender || "未登记")).size > 1) errors.push("组内存在不同性别成员");
    if (unit.members.some((member) => !["男", "女"].includes(member.gender))) errors.push("存在未登记性别的成员");
    if (unit.members.some((member) => !member.surveyCompleted)) errors.push("存在未完成问卷的成员");
    if (unit.members.length > 1 && !unit.allConfirmed) errors.push("意向组尚未全员确认");
    return errors;
  }

  function packUnitsGlobally(units, weights, options = {}) {
    if (!units.length) return { rooms: [], proven: true };
    const cache = options.pairCache || createPairCache();
    // 回溯搜索按搜索步数和时间双重限流：步数防死循环，时间防大班组合爆炸。
    // 超出预算时退回贪心装箱——宁可通过更多未满寝室分完，也不能让整班学生拿不到结果。
    const nodeLimit = 500000;
    const timeBudgetMs = Number(options.timeBudgetMs ?? DEFAULT_TIME_BUDGET_MS) || DEFAULT_TIME_BUDGET_MS;
    const startedAt = Date.now();
    let timeExhausted = false;
    const compatibilityCount = new Map(units.map(unit => [unit.id, units.filter(other => other.id !== unit.id && unitCompatibility([unit, other], weights, cache).compatible).length]));
    const ordered = [...units].sort((a, b) => b.members.length - a.members.length || compatibilityCount.get(a.id) - compatibilityCount.get(b.id) || a.id.localeCompare(b.id));
    const totalSeats = ordered.reduce((sum, unit) => sum + unit.members.length, 0);
    for (let target = Math.ceil(totalSeats / 4); target <= ordered.length; target += 1) {
      let nodes = 0, result = null;
      function visit(index, bins) {
        if (++nodes > nodeLimit) return false;
        if ((nodes & 255) === 0 && Date.now() - startedAt > timeBudgetMs) { timeExhausted = true; return false; }
        if (index === ordered.length) { result = bins.map(bin => [...bin.parts]); return true; }
        const unit = ordered[index];
        const choices = bins.map((bin, binIndex) => ({ binIndex, compatibility: bin.seats + unit.members.length <= 4 ? unitCompatibility([...bin.parts, unit], weights, cache) : { compatible: false, score: -Infinity } }))
          .filter(choice => choice.compatibility.compatible)
          .sort((a, b) => b.compatibility.score - a.compatibility.score || b.binIndex - a.binIndex);
        for (const choice of choices) {
          const bin = bins[choice.binIndex];
          bin.parts.push(unit); bin.seats += unit.members.length;
          if (visit(index + 1, bins)) return true;
          bin.seats -= unit.members.length; bin.parts.pop();
        }
        if (bins.length < target) {
          bins.push({ parts: [unit], seats: unit.members.length });
          if (visit(index + 1, bins)) return true;
          bins.pop();
        }
        return false;
      }
      if (visit(0, [])) {
        return { proven: nodes <= nodeLimit, rooms: result.map(parts => {
          const members = parts.flatMap(unit => unit.members);
          const compatibility = unitCompatibility(parts, weights, cache);
          return { members, fixed: false, partial: members.length < 4, score: compatibility.score, warnings: [...new Set(parts.flatMap(unit => [...(unit.warnings || []), ...explainGroupConflicts(unit.members)]))] };
        }) };
      }
      if (nodes > nodeLimit || timeExhausted) break;
    }
    // 兜底：贪心装箱，保证每个学生都进寝室（部分寝室人数可能不足4人）。
    const bins = [];
    ordered.forEach((unit) => {
      let best = null;
      bins.forEach((bin) => {
        if (bin.seats + unit.members.length > 4) return;
        const compatibility = unitCompatibility([...bin.parts, unit], weights, cache);
        if (!compatibility.compatible) return;
        if (!best || compatibility.score > best.compatibility.score) best = { bin, compatibility };
      });
      if (best) { best.bin.parts.push(unit); best.bin.seats += unit.members.length; }
      else bins.push({ parts: [unit], seats: unit.members.length });
    });
    return { proven: false, degraded: true, rooms: bins.map(parts => {
      const members = parts.flatMap(unit => unit.members);
      const compatibility = unitCompatibility(parts, weights, cache);
      return { members, fixed: false, partial: members.length < 4, score: compatibility.score, warnings: [...new Set(parts.flatMap(unit => [...(unit.warnings || []), ...explainGroupConflicts(unit.members)]))] };
    }) };
  }

  function allocateClass(units, options = {}) {
    const weights = { ...DEFAULT_WEIGHTS, ...(options.weights || {}) };
    const fixedRooms = [], review = [];
    const validUnits = [];
    units.forEach((unit) => {
      const errors = validateUnit(unit);
      if (errors.length) review.push({ unitId: unit.id, members: unit.members || [], reasons: errors });
      else validUnits.push(unit);
    });
    const pairCache = createPairCache();
    const fixed = validUnits.filter((unit) => unit.members.length === 4);
    const pool = validUnits.filter((unit) => unit.members.length < 4).sort((a, b) => b.members.length - a.members.length || a.id.localeCompare(b.id));
    fixed.forEach((unit) => {
      const compatibility = groupCompatibility(unit.members, weights, pairCache);
      fixedRooms.push({ members: unit.members, fixed: true, preferredRoom: unit.preferredRoom || null, score: Number.isFinite(compatibility.score) ? compatibility.score : 0, warnings: explainGroupConflicts(unit.members) });
    });
    const packed = packUnitsGlobally(pool, weights, { timeBudgetMs: options.timeBudgetMs, pairCache });
    if (!packed) return { rooms: fixedRooms, pending: explainPending(pool), review };
    fixedRooms.push(...packed.rooms);
    return { rooms: fixedRooms, pending: [], review, degraded: Boolean(packed.degraded) };
  }

  function canChooseBed(assignments, studentId, bedNo) {
    const normalizedBedNo = Number(bedNo);
    if (!Number.isInteger(normalizedBedNo) || normalizedBedNo < 1 || normalizedBedNo > 4) return false;
    return !(assignments || []).some((item) => item.studentId !== studentId && Number(item.bedNo) === normalizedBedNo);
  }

  function allocateAll(units, options = {}) {
    const byCohort = new Map();
    units.forEach((unit) => {
      const classId = unit.members?.[0]?.classId || "unknown";
      const gender = unit.members?.[0]?.gender || "未登记";
      const cohortKey = `${classId}|${gender}`;
      if (!byCohort.has(cohortKey)) byCohort.set(cohortKey, { classId, gender, units: [] });
      byCohort.get(cohortKey).units.push(unit);
    });
    const result = { version: VERSION, classes: {}, crossClassPending: [], degraded: false };
    byCohort.forEach(({ classId, gender, units: cohortUnits }) => {
      const allocation = allocateClass(cohortUnits, options);
      if (!result.classes[classId]) result.classes[classId] = { rooms: [], pending: [], review: [] };
      result.classes[classId].rooms.push(...allocation.rooms.map((room) => ({ ...room, gender })));
      result.classes[classId].pending.push(...allocation.pending);
      result.classes[classId].review.push(...allocation.review);
      if (allocation.degraded) result.degraded = true;
      result.crossClassPending.push(...allocation.pending.map((student) => ({ ...student, gender })));
    });
    return result;
  }

  function assignRoomNumbers(allocation, roomInventory) {
    const pools = new Map();
    (roomInventory || []).filter((room) => room.active !== false).forEach((room) => {
      const key = `${room.classId}|${room.gender}`;
      if (!pools.has(key)) pools.set(key, []);
      pools.get(key).push(room);
    });
    pools.forEach((rooms) => rooms.sort((a, b) => String(a.roomNumber).localeCompare(String(b.roomNumber), "zh-CN", { numeric: true })));

    const rooms = [], pending = [...(allocation.crossClassPending || [])];
    Object.entries(allocation.classes || {}).forEach(([classId, classResult]) => {
      classResult.rooms.forEach((room) => {
        const key = `${classId}|${room.gender}`;
        const roomPool = pools.get(key) || [];
        const preferredIndex = room.preferredRoom ? roomPool.findIndex(item => String(item.roomNumber) === String(room.preferredRoom)) : -1;
        const inventoryRoom = preferredIndex >= 0 ? roomPool.splice(preferredIndex, 1)[0] : roomPool.shift();
        if (!inventoryRoom) {
          pending.push(...room.members.map((student) => ({ ...student, unitId: `room-unit:${JSON.stringify(room.members.map(member => member.id))}`, gender: room.gender, reason: `本班${room.gender}寝室床位不足，等待辅导员处理` })));
          return;
        }
        rooms.push({ ...room, classId, roomNumber: String(inventoryRoom.roomNumber), capacity: Number(inventoryRoom.capacity || 4) });
      });
    });
    const sharedFemaleRooms = pools.get("shared|女") || [];
    while (sharedFemaleRooms.length) {
      const candidates = pending.filter((student) => student.gender === "女" && ["1", "2", "3", "4"].includes(String(student.classId)));
      if (!candidates.length) break;
      const inventoryRoom = sharedFemaleRooms.shift();
      // 备用寝室也只能整组补位，不能从三人组或两人组中截取一部分。
      const byUnit = new Map();
      candidates.forEach(student => {
        const key = student.unitId || `single:${student.id}`;
        if (!byUnit.has(key)) byUnit.set(key, []);
        byUnit.get(key).push(student);
      });
      const selected = [];
      [...byUnit.values()].sort((a,b) => b.length-a.length).forEach(members => {
        if (selected.length + members.length <= Number(inventoryRoom.capacity || 4) &&
          groupCompatibility([...selected, ...members]).compatible) selected.push(...members);
      });
      if (!selected.length) continue;
      const selectedIds = new Set(selected.map((student) => student.id));
      for (let index = pending.length - 1; index >= 0; index -= 1) if (selectedIds.has(pending[index].id)) pending.splice(index, 1);
      rooms.push({
        classId: "shared", gender: "女", roomNumber: String(inventoryRoom.roomNumber), capacity: Number(inventoryRoom.capacity || 4),
        members: selected, fixed: false, score: 0, warnings: ["跨班机动女寝，需辅导员最终确认"]
      });
    }
    return { version: allocation.version, rooms, pending };
  }

  return { VERSION, DEFAULT_WEIGHTS, PRIORITY_FEATURES, dealbreakerConflict, setDistance, hasHardConflict, pairCompatibility, groupCompatibility, validateUnit, allocateClass, allocateAll, assignRoomNumbers, canChooseBed };
}));
