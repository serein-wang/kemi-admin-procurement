import { existsSync, readFileSync } from "node:fs";
import { DomainError } from "./domain/errors.js";
import { parseAmount } from "./domain/money.js";
import {
  THRESHOLD_KEYS,
  emptyThresholds,
  type ThresholdConfig,
  type ThresholdKey,
} from "./domain/thresholds.js";

/** 不覆盖进程里已有的变量。不记录值。 */
export function loadDotEnv(path = ".env"): void {
  if (!existsSync(path)) return;
  const text = readFileSync(path, "utf8");
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index < 1) continue;
    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] == null) process.env[key] = value;
  }
}

function isPlaceholder(key: ThresholdKey, raw: string | undefined): boolean {
  if (raw == null) return true;
  const text = raw.trim();
  if (!text) return true;
  if (text.toUpperCase() === "PLACEHOLDER") return true;
  if (text === key) return true;
  return false;
}

/** 空值与占位符都变成 null。出现具体数字只能源自环境，不来自源码默认值。 */
export function loadThresholds(env: NodeJS.ProcessEnv): ThresholdConfig {
  const config = emptyThresholds();
  for (const key of THRESHOLD_KEYS) {
    const raw = env[key];
    if (isPlaceholder(key, raw)) {
      config[key] = null;
      continue;
    }
    const text = raw!.trim();
    try {
      parseAmount(text);
    } catch (error) {
      if (error instanceof DomainError) {
        throw new DomainError("THRESHOLD_CONFIG_INVALID", `${key} 不是合法金额`, 422);
      }
      throw error;
    }
    config[key] = text;
  }
  return config;
}

export interface AppEnv {
  port: number;
  host: string;
  sessionSecret: string;
  allowDevLogin: boolean;
  seedDemoUsers: boolean;
  thresholds: ThresholdConfig;
  oidc: {
    clientId: string;
    clientSecret: string;
    redirectUri: string;
    ucApi: string;
  };
}

export function loadAppEnv(env: NodeJS.ProcessEnv = process.env): AppEnv {
  const sessionSecret = env.SESSION_SECRET ?? "";
  if (sessionSecret.length < 16) {
    throw new Error("SESSION_SECRET 至少 16 字符，且只能放在环境变量里");
  }
  const port = Number(env.PORT ?? 3000);
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error("PORT 无效");
  }
  return {
    port,
    host: env.HOST ?? "127.0.0.1",
    sessionSecret,
    allowDevLogin: env.ALLOW_DEV_LOGIN === "true",
    seedDemoUsers: env.SEED_DEMO_USERS !== "false",
    thresholds: loadThresholds(env),
    oidc: {
      clientId: env.KEMI_CLIENT_ID ?? "",
      clientSecret: env.KEMI_CLIENT_SECRET ?? "",
      redirectUri: env.KEMI_REDIRECT_URI ?? "",
      ucApi: (env.KEMI_UC_API ?? "https://kemi.newlinksz.com/usercenter").replace(/\/$/, ""),
    },
  };
}
