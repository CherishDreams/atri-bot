import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { AuthUser, LoginResponse } from "@atri/shared";
import type { Logger } from "#core/logger.ts";
import { errorMessage } from "#core/errors.ts";
import { configFilePath, updateConfigFile } from "#config/file.ts";

/** 绝对有效期：无论是否活跃，登录满 15 天后一律失效。 */
export const ABSOLUTE_TTL_MS = 15 * 24 * 60 * 60 * 1000;

/** 空闲有效期：连续 7 天没有请求才失效（每次命中都滑动续期）。 */
export const IDLE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** 自动生成密码的长度（字节）。18 字节 base64url 后为 24 个字符。 */
const GENERATED_PASSWORD_BYTES = 18;

/**
 * AuthManager 实际读写的配置键。
 *
 * 刻意不直接用 `AppConfig`：各模块声明自己那份最小结构，`loadConfig()` 的产物
 * 天然满足它，测试里手写的最小配置也不必补齐一堆无关键。
 * `auth` 是**可变**的——`init()` 会把实际生效的口令回填进去（调用方与测试都读它）。
 */
export interface AuthManagerConfig {
  root: string;
  auth: {
    adminUser?: string;
    adminPassword?: string | null;
    cookieName: string;
    cookieSecure: boolean;
  };
}

/** 会话的内部记录。时间是数值（注入时钟的返回值），令牌本身是 Map 的键。 */
interface AuthSessionRecord {
  username: string;
  createdAt: number;
  lastSeenAt: number;
  absoluteExpiresAt: number;
}

/** 登录成功后的内部结果：对外响应是 `LoginResponse`，另外多带一个只进 Cookie 的令牌。 */
export interface LoginResult extends LoginResponse {
  token: string;
}

/** 统一的密码摘要：定长 32 字节，使 timingSafeEqual 永不因长度差异提前返回。 */
function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

/**
 * 单管理员账号的会话式鉴权。令牌本身不进线协议，只放在 HttpOnly Cookie 里，
 * 因此这里只管「令牌 -> 会话」的映射，不关心传输层。
 *
 * 会话刻意存在内存：重启即全部失效，不引入持久化会话表。
 */
export class AuthManager {
  #config: AuthManagerConfig;
  #logger: Logger;
  #username: string;
  #usernameHash: Buffer;
  // 必须显式标注：口令是在 init() 里才有的，推断成 null 就赋不进 Buffer。
  #passwordHash: Buffer | null = null;
  #sessions = new Map<string, AuthSessionRecord>();
  #now: () => number;

  /**
   * `now` 可注入，使过期逻辑能用真实时间推进来测试，而不是回拨内部状态——
   * 回拨状态只能证明「字段被读了」，注入时钟才能证明「时间到了就失效」。
   */
  constructor(
    config: AuthManagerConfig,
    logger: Logger,
    { now = Date.now }: { now?: () => number } = {},
  ) {
    this.#config = config;
    this.#logger = logger;
    this.#now = now;
    this.#username = config.auth?.adminUser ?? "admin";
    this.#usernameHash = digest(this.#username);
  }

  /** 目前恒为 true；保留该属性是为了让调用方能写出「未启用则跳过」的前向兼容代码。 */
  get enabled(): boolean {
    return true;
  }

  get username(): string {
    return this.#username;
  }

  get cookieName(): string {
    return this.#config.auth.cookieName;
  }

  get cookieSecure(): boolean {
    return this.#config.auth.cookieSecure;
  }

  get stats(): { activeSessions: number } {
    return { activeSessions: this.#sessions.size };
  }

  /**
   * 确保存在可用的口令。未配置时生成随机口令写入 atri.config.json，
   * 并打印一次到日志——这是运维拿到初始密码的唯一途径。
   */
  async init(): Promise<void> {
    let password: string | null = this.#config.auth?.adminPassword ?? null;

    if (typeof password !== "string" || password.length === 0) {
      password = randomBytes(GENERATED_PASSWORD_BYTES).toString("base64url");
      this.#persistPassword(password);
      this.#logger.warn(
        `未配置管理员密码，已生成随机密码并写入 ${configFilePath(this.#config.root)}：${password}`,
      );
    }

    // 回填到运行期配置：调用方与测试都能读到实际生效的口令。
    this.#config.auth = { ...this.#config.auth, adminPassword: password };
    this.#passwordHash = digest(password);
  }

  /**
   * 用户名与口令都对才算通过。两处都比较摘要（定长），因此不泄露长度差异。
   *
   * 两个参数是 `unknown` 而不是 `string`：这里**必须**自己挡住非字符串（有测试专门打
   * `undefined`/`{}`/`[]`），把校验挪到调用方就等于给它一个会抛错的 digest。
   */
  verifyPassword(username: unknown, password: unknown): boolean {
    if (!this.#passwordHash) return false;
    if (typeof username !== "string" || typeof password !== "string") return false;

    const userOk = timingSafeEqual(digest(username), this.#usernameHash);
    const passOk = timingSafeEqual(digest(password), this.#passwordHash);
    return userOk && passOk;
  }

  /** 校验通过则签发新令牌；失败返回 null（调用方一律回同一句错误，不区分原因）。 */
  login(username: string, password: string): LoginResult | null {
    if (!this.verifyPassword(username, password)) return null;

    this.#prune();

    const now = this.#now();
    const token = randomUUID();
    const absoluteExpiresAt = now + ABSOLUTE_TTL_MS;
    this.#sessions.set(token, {
      username: this.#username,
      createdAt: now,
      lastSeenAt: now,
      absoluteExpiresAt,
    });

    return {
      token,
      user: { username: this.#username },
      expiresAt: new Date(absoluteExpiresAt).toISOString(),
    };
  }

  /**
   * 令牌 -> 会话。命中即滑动续期；绝对过期或空闲超时则删除。
   * 清理也在这里惰性进行，因此没有定时器，stop() 之后不留任何资源。
   *
   * 参数是 `string | undefined`：调用方从 Cookie 里取，取不到就是没登录，
   * 这一条守卫同时也是「不拿 undefined 去查 Map」的类型保证。
   */
  getByToken(token: string | undefined): LoginResponse | null {
    if (typeof token !== "string" || token.length === 0) return null;

    const record = this.#sessions.get(token);
    if (!record) return null;

    const now = this.#now();
    if (now >= record.absoluteExpiresAt || now - record.lastSeenAt >= IDLE_TTL_MS) {
      this.#sessions.delete(token);
      return null;
    }

    record.lastSeenAt = now;
    return {
      user: { username: record.username } satisfies AuthUser,
      expiresAt: new Date(record.absoluteExpiresAt).toISOString(),
    };
  }

  logout(token: string): boolean {
    return this.#sessions.delete(token);
  }

  /** 用于「密钥轮换」这类场景：一次性作废所有浏览器上的登录态。 */
  revokeAll(): void {
    this.#sessions.clear();
  }

  /** 清掉已过期条目，避免长期运行后 Map 无限增长。 */
  #prune(): void {
    const now = this.#now();
    for (const [token, record] of this.#sessions) {
      if (now >= record.absoluteExpiresAt || now - record.lastSeenAt >= IDLE_TTL_MS) {
        this.#sessions.delete(token);
      }
    }
  }

  #persistPassword(password: string): void {
    try {
      updateConfigFile(this.#config.root, (fileConfig) => {
        fileConfig.auth = { ...fileConfig.auth, adminPassword: password };
      });
    } catch (err) {
      // 配置文件损坏或不可写时不能覆盖它——那会丢配置。
      // 改为仅存于内存并告警：口令重启后会重新生成。
      this.#logger.warn(`${errorMessage(err)}，生成的密码不会落盘（重启后会重新生成）`);
    }
  }
}
