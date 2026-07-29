#!/usr/bin/env node
import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// 仓库根目录（本脚本位于 scripts/ 下）
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const targets = ["apps/dashboard/dist", "packages/shared/dist"];

for (const t of targets) {
  await rm(join(root, t), { recursive: true, force: true });
  console.log(`已清理 ${t}`);
}
