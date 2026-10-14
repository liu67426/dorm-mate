(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.DormTenant = api;
}(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";
  function resolve(config, search) {
    if (config.mode !== "cloud") return null;
    const schools = config.schools || {};
    if (Object.keys(schools).length) {
      const code = new URLSearchParams(search).get("school") || "";
      const school = Object.hasOwn(schools, code) ? schools[code] : null;
      return school?.envId ? { code, ...school } : null;
    }
    return config.envId ? { code: "", name: "单校试点", envId: config.envId, region: config.region, adminUsername: config.adminUsername } : null;
  }
  return { resolve };
}));
