(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.DormGroups = api;
}(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";
  // 单人记录只承载尚未接受的邀请，不代表已经结成搭档。
  function classify(group) {
    const members = group?.memberIds || group?.member_ids || [];
    const confirmed = new Set(group?.confirmedIds || group?.confirmed_ids || []);
    const size = members.length;
    const confirmedCount = members.filter(id => confirmed.has(id)).length;
    let kind;
    if (group?.status === "rejected" || (group && !size)) kind = "inactive";
    else if (size <= 1) kind = "solo";
    else if (size > 4 || new Set(members).size !== size || confirmedCount !== size) kind = "review";
    else kind = size === 4 ? "complete" : "partial";
    const label = {solo:"未组队", partial:`${size}人已确认搭档 · 待补${4-size}人`, complete:"完整固定四人组", review:"待复核", inactive:"已失效"}[kind];
    return {kind, size, confirmedCount, label};
  }
  function count(groups) {
    return (groups || []).reduce((result, group) => {
      result[classify(group).kind] += 1;
      return result;
    }, {solo:0, partial:0, complete:0, review:0, inactive:0});
  }
  return {classify, count};
}));
