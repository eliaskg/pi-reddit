import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface RedditLimits {
  searchSelftextChars: number;
  postSelftextChars: number;
  commentBodyChars: number;
  defaultComments: number;
  maxComments: number;
  defaultLimit: number;
}

export interface RedditConfig {
  clientId: string;
  clientSecret: string;
  userAgent: string;
  limits: RedditLimits;
}

export const CONFIG_FILE = path.join(os.homedir(), ".pi", "agent", "reddit.json");

export const DEFAULT_LIMITS: RedditLimits = {
  searchSelftextChars: 300,
  postSelftextChars: 2000,
  commentBodyChars: 1000,
  defaultComments: 20,
  maxComments: 50,
  defaultLimit: 10,
};

const DEFAULT_USER_AGENT = "pi-agent:pi-reddit:1.0 (by /u/pi-coding-agent)";

function readNumber(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.trunc(value), min), max);
}

/**
 * Load the Reddit configuration. Credentials come from the config file,
 * with REDDIT_CLIENT_ID / REDDIT_CLIENT_SECRET env vars as override.
 * All optional keys fall back to defaults. Throws with setup guidance
 * when no credentials exist.
 */
export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  configPath: string = CONFIG_FILE,
): RedditConfig {
  let file: Record<string, unknown> = {};
  if (fs.existsSync(configPath)) {
    try {
      file = JSON.parse(fs.readFileSync(configPath, "utf8"));
    } catch (e) {
      throw new Error(`Cannot parse ${configPath}: ${(e as Error).message}`);
    }
  }

  const clientId = env.REDDIT_CLIENT_ID || file.client_id;
  const clientSecret = env.REDDIT_CLIENT_SECRET || file.client_secret;

  if (typeof clientId !== "string" || !clientId || typeof clientSecret !== "string" || !clientSecret) {
    throw new Error(
      `Reddit credentials missing. Create ${configPath} with client_id and client_secret ` +
        `from a "script" app at https://www.reddit.com/prefs/apps, ` +
        `or set REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET.`,
    );
  }

  const fileLimits = (typeof file.limits === "object" && file.limits !== null ? file.limits : {}) as Record<
    string,
    unknown
  >;

  return {
    clientId,
    clientSecret,
    userAgent: typeof file.userAgent === "string" && file.userAgent ? file.userAgent : DEFAULT_USER_AGENT,
    limits: {
      searchSelftextChars: readNumber(fileLimits.searchSelftextChars, DEFAULT_LIMITS.searchSelftextChars, 0, 10000),
      postSelftextChars: readNumber(fileLimits.postSelftextChars, DEFAULT_LIMITS.postSelftextChars, 0, 50000),
      commentBodyChars: readNumber(fileLimits.commentBodyChars, DEFAULT_LIMITS.commentBodyChars, 0, 20000),
      defaultComments: readNumber(fileLimits.defaultComments, DEFAULT_LIMITS.defaultComments, 1, 100),
      maxComments: readNumber(fileLimits.maxComments, DEFAULT_LIMITS.maxComments, 1, 100),
      defaultLimit: readNumber(fileLimits.defaultLimit, DEFAULT_LIMITS.defaultLimit, 1, 100),
    },
  };
}
