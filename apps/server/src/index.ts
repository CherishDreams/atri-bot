import { createApp } from "./app.ts";
import { loadConfig } from "./config/index.ts";

/**
 * 薄入口：解析配置、构建应用、启动、挂接退出信号。
 * 真正的行为都在 core/ 和 api/ 下 —— 这里保持「无聊」。
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const app = await createApp(config);

  await app.start();

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    console.log(`\n[atri] 收到 ${signal}，正在关闭...`);
    try {
      await app.stop();
    } finally {
      process.exit(0);
    }
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err: unknown) => {
  console.error("[atri] 致命启动错误:", err);
  process.exit(1);
});
