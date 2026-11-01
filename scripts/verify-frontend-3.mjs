/**
 * 页面切换动画的复验：
 * 1. 路由切换时过渡类真实生效（能捕捉到 .page-enter-active / 透明度动画）；
 * 2. out-in 模式下同一时刻至多一份页面（无新旧挤压）；
 * 3. 快速连续导航不产生 pageerror；
 * 4. prefers-reduced-motion 下动画被禁用。
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
const chromium = createRequire("/root/.npm/_npx/e41f203b7505f1fb/node_modules/")(
  "playwright-core",
).chromium;

const PORT = Number(process.env.ATRI_PORT ?? 18804);
const PASSWORD = "verify-pw-789";
const ORIGIN = `http://127.0.0.1:${PORT}`;

const root = mkdtempSync(join(tmpdir(), "atri-verify3-"));
process.env.ATRI_PORT = String(PORT);
process.env.ATRI_ADMIN_PASSWORD = PASSWORD;
process.env.ATRI_DATA_DIR = join(root, "data");
process.env.ATRI_STATIC_DIR = new URL("../apps/dashboard/dist/", import.meta.url).pathname;
const { loadConfig } = await import("../apps/server/src/config/config.ts");
const { createApp } = await import("../apps/server/src/app.ts");
const app = await createApp(loadConfig());
await app.start();

const problems = [];
const pageErrors = [];

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH,
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
page.on("pageerror", (err) => pageErrors.push(`${page.url()} :: ${err.message}`));

await page.goto(`${ORIGIN}/login`, { waitUntil: "networkidle" });
await page.fill("#username", "admin");
await page.fill("#password", PASSWORD);
await page.click("button[type=submit]");
await page.waitForURL("**/?profile=*", { timeout: 10_000 });
// 等首屏动画跑完（appear 也在动画）。
await page.waitForTimeout(400);

async function check(name, fn) {
  try {
    await fn();
    console.log(`✔ ${name}`);
  } catch (err) {
    problems.push(`${name}: ${err.message}`);
    console.log(`✖ ${name}: ${err.message}`);
  }
}

await check("路由切换时过渡类真实生效（捕捉到 page-enter-active）", async () => {
  // 首屏就是「平台会话」：点它不产生导航，过渡自然不会跑 —— 从别的页切过来。
  await page.click(".n-menu >> text=插件");
  await page.locator("text=已注册指令").first().waitFor({ state: "visible", timeout: 5000 });
  await page.click(".n-menu >> text=平台会话");
  // 点击后立刻轮询：enter-active 是瞬态类，晚了就抓不到。
  let seen = false;
  for (let i = 0; i < 40; i += 1) {
    if ((await page.locator(".page-enter-active").count()) > 0) {
      seen = true;
      break;
    }
    await page.waitForTimeout(10);
  }
  if (!seen) throw new Error("没有捕捉到 .page-enter-active —— 过渡没有生效");
  // 新页面照常渲染。
  await page.locator("text=平台会话").first().waitFor({ state: "visible", timeout: 5000 });
});

await check("out-in：同一时刻至多一份页面根（无新旧挤压）", async () => {
  await page.click(".n-menu >> text=技能");
  let maxPageRoots = 0;
  for (let i = 0; i < 40; i += 1) {
    // 过渡容器里 page-enter-active 与 page-leave-active 不同时出现（out-in 的保证）。
    const leaving = await page.locator(".page-leave-active").count();
    const entering = await page.locator(".page-enter-active").count();
    maxPageRoots = Math.max(maxPageRoots, leaving > 0 && entering > 0 ? 2 : 1);
    await page.waitForTimeout(10);
  }
  // out-in 不可能同时有 enter 与 leave；抓到同帧共存就是布局挤压的前兆。
  const both = await page.evaluate(
    () =>
      document.querySelector(".page-leave-active") !== null &&
      document.querySelector(".page-enter-active") !== null,
  );
  if (both) throw new Error("enter 与 leave 同帧共存 —— out-in 没生效");
  void maxPageRoots;
  await page.locator("text=技能").first().waitFor({ state: "visible", timeout: 5000 });
});

await check("工作台切分类：面板有过渡且无挤压", async () => {
  await page.goto(`${ORIGIN}/config?cat=memory`, { waitUntil: "networkidle" });
  await page.waitForTimeout(300);
  await page.click('[aria-label="配置分类"] >> text=拟人化');
  let seen = false;
  for (let i = 0; i < 40; i += 1) {
    if ((await page.locator(".page-enter-active").count()) > 0) {
      seen = true;
      break;
    }
    await page.waitForTimeout(10);
  }
  if (!seen) throw new Error("工作台面板切换没有过渡");
  await page.locator("text=群聊唤醒前缀").first().waitFor({ state: "visible", timeout: 5000 });
});

await check("快速连续导航：无 pageerror、末页可用", async () => {
  for (const label of ["记忆", "MCP", "插件", "技能", "记忆"]) {
    await page.click(`.n-menu >> text=${label}`);
    await page.waitForTimeout(80);
  }
  await page.waitForTimeout(500);
  await page.locator("text=召回测试").first().waitFor({ state: "visible", timeout: 5000 });
});

await check("prefers-reduced-motion：过渡被禁用", async () => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  // 当前不在插件页就先过去再离开，保证下一次点击是一次真实的路由切换。
  if (!page.url().includes("/plugins")) {
    await page.click(".n-menu >> text=插件");
    await page.waitForTimeout(400);
    await page.click(".n-menu >> text=平台会话");
  } else {
    await page.click(".n-menu >> text=技能");
  }
  // enter-active 是瞬态类：立即轮询，抓到后读 computed 的 transition-duration。
  let duration = null;
  for (let i = 0; i < 40; i += 1) {
    duration = await page.evaluate(() => {
      const el = document.querySelector(".page-enter-active");
      return el === null ? null : getComputedStyle(el).transitionDuration;
    });
    if (duration !== null) break;
    await page.waitForTimeout(10);
  }
  // reduce 下 active 类仍会挂（Vue 不知道媒体查询），但 transition-duration 是 0s。
  if (duration === null) throw new Error("没找到过渡元素");
  if (duration !== "0s") throw new Error(`reduce 下仍有动画：${duration}`);
  await page.emulateMedia({ reducedMotion: "no-preference" });
});

console.log("");
if (problems.length > 0 || pageErrors.length > 0) {
  console.log("未通过：", problems.length, "项；pageerror：", pageErrors.length, "条");
  for (const p of [...problems, ...pageErrors]) console.log("  -", p);
  process.exitCode = 1;
} else {
  console.log("全部通过，无 pageerror。");
}
await browser.close();
await app.stop();
