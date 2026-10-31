/**
 * 前端真浏览器验证：本会话新增的页面与面板。
 * 量 DOM 几何 + 收 pageerror（不收 console.error / requestfailed —— 见 AGENTS.md 的教训）。
 */
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
const chromium = createRequire("/root/.npm/_npx/e41f203b7505f1fb/node_modules/")(
  "playwright-core",
).chromium;

const PORT = Number(process.env.ATRI_PORT ?? 18801);
const PASSWORD = "verify-pw-123";
const ORIGIN = `http://127.0.0.1:${PORT}`;

// --- 起真服务（临时 root，带技能 fixture） -----------------------------------
const root = mkdtempSync(join(tmpdir(), "atri-verify-"));
process.env.ATRI_PORT = String(PORT);
process.env.ATRI_ADMIN_PASSWORD = PASSWORD;
process.env.ATRI_DATA_DIR = join(root, "data");
process.env.ATRI_STATIC_DIR = new URL("../apps/dashboard/dist/", import.meta.url).pathname;
const { loadConfig } = await import("../apps/server/src/config/config.ts");
const { createApp } = await import("../apps/server/src/app.ts");
const app = await createApp(loadConfig());
await app.start();

// 技能 fixture：让技能页与工作台技能分类有内容。
const skillDir = join(root, "data", "skills", "echo-guide");
mkdirSync(skillDir, { recursive: true });
writeFileSync(
  join(skillDir, "SKILL.md"),
  "---\nname: 回声指南\ndescription: 教你把一句话原样回给对方\n---\n# 回声指南\n把用户的话原样重复一遍。\n",
);
// 表情素材（不验证 UI，只让工具清单完整）。
mkdirSync(join(root, "data", "profiles", "default", "stickers", "开心"), { recursive: true });

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

await check("插件页：已注册指令区块（/help 与 /plugins）", async () => {
  await page.goto(`${ORIGIN}/plugins`, { waitUntil: "networkidle" });
  await assertReachable("text=已注册指令", "指令区块标题");
  await assertReachable("text=/help", "/help 条目");
  await assertReachable("text=内置", "来源标记");
});

await check("工作台 ?cat=memory：记忆面板控件可达", async () => {
  await page.goto(`${ORIGIN}/config?cat=memory`, { waitUntil: "networkidle" });
  await assertReachable("text=启用记忆", "启用记忆行");
  await assertReachable("text=记忆方案", "记忆方案行");
  const sw = page.locator(".n-switch").first();
  await sw.waitFor({ state: "visible", timeout: 8000 });
});

await check("工作台 ?cat=skills：技能勾选清单", async () => {
  await page.goto(`${ORIGIN}/config?cat=skills`, { waitUntil: "networkidle" });
  await assertReachable("text=回声指南", "技能条目");
  await assertReachable("text=echo-guide", "技能 id");
});

await check("工作台 ?cat=humanizer：拟人化面板（前缀/防抖/分段/日记）", async () => {
  await page.goto(`${ORIGIN}/config?cat=humanizer`, { waitUntil: "networkidle" });
  await assertReachable("text=群聊唤醒前缀", "唤醒前缀");
  await assertReachable("text=连续输入防抖", "防抖");
  await assertReachable("text=智能分段", "分段");
  await assertReachable("text=日记与记忆巩固", "日记");
  // 时间选择器在 375 宽度下容易溢出，1280 下先确认在视口内。
  await assertReachable("text=入睡 / 起床", "作息");
});

await check("MCP 页：空态与新增表单", async () => {
  await page.goto(`${ORIGIN}/mcp`, { waitUntil: "networkidle" });
  await assertReachable("text=MCP 服务器", "页标题");
  await page.click("text=新增服务器");
  await assertReachable("text=传输类型", "表单");
  // 传输切换：stdio 字段出现。
  await page.click("text=stdio（本机子进程）");
  await assertReachable("text=参数（空格分隔）", "stdio 字段");
  await page.keyboard.press("Escape");
});

await check("技能页：目录与全文查看", async () => {
  await page.goto(`${ORIGIN}/skills`, { waitUntil: "networkidle" });
  await assertReachable("text=回声指南", "技能条目");
  await page.click("text=查看全文");
  await assertReachable("pre >> text=回声指南", "全文弹层");
  await page.keyboard.press("Escape");
});

await check("导航：新增两页都在菜单里", async () => {
  await assertReachable("text=MCP", "导航 MCP");
  await assertReachable(".n-menu >> text=技能", "导航 技能");
});

// 窄屏抽查：工作台拟人化与 MCP 页在 375 宽度下控件不被挤出。
await check("窄屏 375：拟人化面板与 MCP 页", async () => {
  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto(`${ORIGIN}/config?cat=humanizer`, { waitUntil: "networkidle" });
  await assertReachable("text=群聊唤醒前缀", "唤醒前缀");
  await page.goto(`${ORIGIN}/mcp`, { waitUntil: "networkidle" });
  await assertReachable("text=MCP 服务器", "页标题");
  await page.setViewportSize({ width: 1280, height: 900 });
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
