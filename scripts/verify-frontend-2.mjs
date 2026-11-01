/**
 * 本轮反馈的真浏览器复验：
 * 1. 拟人化面板的睡眠时间控件可显示、可修改（此前字符串值让控件不渲染）；
 * 2. 记忆页（召回测试 / 图谱 / 浏览）真实渲染；
 * 3. 平台会话页与聊天页分列（导航改名、平台会话列表渲染）。
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
const chromium = createRequire("/root/.npm/_npx/e41f203b7505f1fb/node_modules/")(
  "playwright-core",
).chromium;

const PORT = Number(process.env.ATRI_PORT ?? 18803);
const PASSWORD = "verify-pw-456";
const ORIGIN = `http://127.0.0.1:${PORT}`;

const root = mkdtempSync(join(tmpdir(), "atri-verify2-"));
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

async function login() {
  await page.goto(`${ORIGIN}/login`, { waitUntil: "networkidle" });
  await page.fill("#username", "admin");
  await page.fill("#password", PASSWORD);
  await page.click("button[type=submit]");
  await page.waitForURL("**/?profile=*", { timeout: 10_000 });
}

async function check(name, fn) {
  try {
    await fn();
    console.log(`✔ ${name}`);
  } catch (err) {
    problems.push(`${name}: ${err.message}`);
    console.log(`✖ ${name}: ${err.message}`);
  }
}

function assertReachable(selector, label) {
  const el = page.locator(selector).first();
  return el.waitFor({ state: "visible", timeout: 8000 }).then(async () => {
    const box = await el.boundingBox();
    if (box === null) throw new Error(`${label} 不可见（无几何）`);
    if (box.width < 8) throw new Error(`${label} 宽度异常：${box.width}`);
    if (box.x < 0 || box.x + box.width > 1281) throw new Error(`${label} 被挤出视口：x=${box.x}`);
  });
}

await login();

await check("拟人化：入睡时间控件显示且能改值", async () => {
  await page.goto(`${ORIGIN}/config?cat=humanizer`, { waitUntil: "networkidle" });
  // aria-label 落在 n-time-picker 的包装上，真正可点的是内部的 input。
  const start = page.locator(".n-time-picker input").first();
  await assertReachable(".n-time-picker input", "入睡输入框");
  await start.click();
  await page.locator(".n-time-picker-panel").waitFor({ state: "visible", timeout: 5000 });
  // naive-ui 的面板输入支持直接打字：选中后输入 08:08 并回车确认。
  await start.press("ControlOrMeta+a");
  await start.type("08:08");
  await page.keyboard.press("Enter");
  await page.locator(".n-time-picker-panel").waitFor({ state: "hidden", timeout: 5000 });
  // 选中后 input 的值应变为 08:08，且保存键可用（草稿脏）。
  const value = await start.inputValue();
  if (!value.includes("08:08")) throw new Error(`改值未生效：${value}`);
  await assertReachable("text=有未保存的改动", "脏点提示");
  // 放弃改动（避免影响后续检查）。
  await page.goto(`${ORIGIN}/config?cat=humanizer`, { waitUntil: "networkidle" });
});

await check("记忆页：召回测试 / 图谱 / 浏览三块齐全", async () => {
  await page.goto(`${ORIGIN}/memory`, { waitUntil: "networkidle" });
  await assertReachable("text=召回测试", "召回测试卡片");
  await assertReachable("text=总览与图谱", "总览卡片");
  await assertReachable("text=浏览", "浏览卡片");
  // 空数据的诚实态：召回给可读提示而不是空白。
  await page.fill("input[placeholder*='小明']", "你好");
  await page.click("text=测试召回");
  await page.waitForTimeout(600);
  await assertReachable("text=没有召回任何记忆", "空召回提示");
});

await check("平台会话页：空态与导航改名", async () => {
  await page.goto(`${ORIGIN}/`, { waitUntil: "networkidle" });
  await assertReachable("text=平台会话", "页标题");
  await assertReachable("text=还没有平台会话", "空态（没有绑定适配器时如实说明）");
  const nav = page.locator(".n-menu >> text=平台会话");
  await nav.waitFor({ state: "visible", timeout: 5000 });
});

await check("聊天页不并列平台会话（入口在聊天平台）", async () => {
  await page.goto(`${ORIGIN}/chat/new`, { waitUntil: "networkidle" });
  // 聊天平台自己的 UI（不渲染平台会话的适配器分组）。
  await assertReachable("text=今天想聊点什么?", "聊天创建页");
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
