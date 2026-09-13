import { chromium } from "playwright-core";

const baseUrl = process.env.DEPLOY_BASE_URL || "";
if (!baseUrl) throw new Error("请先设置 DEPLOY_BASE_URL，例如 https://你的环境ID-你的账号后缀.tcloudbaseapp.com");
const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  headless: true
});

try {
  const page = await browser.newPage();
  const consoleErrors = [];
  const requestFailures = [];
  const functionRequestAuth = [];
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const sourceUrl = message.location()?.url || "";
    if (sourceUrl.endsWith("/favicon.ico") || sourceUrl.includes("/rpc/dorm_bind_student")) return;
    consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => consoleErrors.push(error.message));
  page.on("requestfailed", (request) => requestFailures.push(`${request.url()}：${request.failure()?.errorText || "失败"}`));
  page.on("request", (request) => {
    if (!request.url().includes("/v1/functions/")) return;
    const headers = request.headers();
    functionRequestAuth.push({
      hasAuthorization: Boolean(headers.authorization),
      hasAccessToken: Boolean(headers["x-cloudbase-access-token"] || headers["x-cloudbase-authorization"]),
      headerNames: Object.keys(headers).filter((name) => name.includes("auth") || name.includes("token"))
    });
  });
  page.on("response", (response) => {
    if (response.status() >= 400 && !response.url().includes("/rpc/dorm_bind_student")) requestFailures.push(`${response.status()} ${response.url()}`);
  });
  let studentResponse = await page.goto(`${baseUrl}/student/`, { waitUntil: "domcontentloaded" });
  if (await page.title() === "风险提醒") {
    consoleErrors.length = 0;
    requestFailures.length = 0;
    [studentResponse] = await Promise.all([
      page.waitForNavigation({ waitUntil: "domcontentloaded" }),
      page.locator("#submitBtn").click()
    ]);
  }
  await page.waitForTimeout(5000);
  const loadState = await page.evaluate(() => ({ url: location.href, title: document.title, text: document.body.innerText.slice(0, 500), dormApi: Boolean(window.DormApi), cloudbase: Boolean(window.cloudbase), scripts: [...document.scripts].map((item) => item.src), actions: [...document.querySelectorAll('a,button')].map((item) => ({ text: item.innerText.trim(), href: item.href || '', id: item.id, className: item.className })) }));
  loadState.httpStatus = studentResponse?.status();
  if (!loadState.dormApi || !loadState.cloudbase) {
    console.log(JSON.stringify({ loadState, consoleErrors, requestFailures }, null, 2));
    throw new Error("网页依赖脚本没有加载完成");
  }
  const pageState = await page.evaluate(() => ({
    title: document.title,
    cloudMode: window.DormApi.isCloud(),
    hasRiskLabel: document.body.innerText.includes("吸烟风险") || document.body.innerText.includes("风险标签")
  }));
  const invalidRosterMessage = await page.evaluate(async () => {
    try {
      await window.DormApi.submitSurvey({
        className: "工业机器人1班",
        classCode: "01",
        name: "联网验收占位学生",
        studentId: "NETWORK-CHECK-ONLY"
      });
      return "未按名单拦截";
    } catch (error) {
      return error.message;
    }
  });
  const loginState = await page.evaluate(async () => {
    const app = window.cloudbase.init({ env: window.DORM_CONFIG.envId, region: window.DORM_CONFIG.region });
    const auth = typeof app.auth === "function" ? app.auth() : app.auth;
    const state = await auth.getLoginState();
    return state ? { keys: Object.keys(state), userKeys: Object.keys(state.user || {}), loginType: state.loginType, isAnonymous: state.isAnonymous, uid: state.user?.uid || state.uid || null } : null;
  });

  await page.goto(`${baseUrl}/admin/`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);
  const authMethods = await page.evaluate(() => {
    const app = window.cloudbase.init({ env: window.DORM_CONFIG.envId, region: window.DORM_CONFIG.region });
    const auth = typeof app.auth === "function" ? app.auth() : app.auth;
    return {
      passwordLogin: typeof auth?.signInWithPassword === "function",
      usernamePasswordLogin: typeof auth?.signInWithUsernameAndPassword === "function",
      anonymousLogin: typeof auth?.signInAnonymously === "function"
    };
  });

  const result = { pageState, invalidRosterMessage, loginState, authMethods, functionRequestAuth, consoleErrors, requestFailures };
  console.log(JSON.stringify(result, null, 2));
  if (!pageState.cloudMode) throw new Error("线上网站没有进入联网模式");
  if (pageState.hasRiskLabel) throw new Error("页面出现了不应存在的风险标签");
  if (!invalidRosterMessage.includes("名单核验失败")) throw new Error(`名单核验未按预期工作：${invalidRosterMessage}`);
  if (!authMethods.passwordLogin) throw new Error("当前网页 SDK 不支持辅导员密码登录");
  if (consoleErrors.length) throw new Error(`页面脚本错误：${consoleErrors.join("；")}`);
} finally {
  await browser.close();
}
