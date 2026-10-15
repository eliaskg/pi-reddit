import type { RedditConfig } from "./config.ts";

const MIN_REQUEST_GAP_MS = 1000;
const REQUEST_TIMEOUT_MS = 30000;

interface Token {
  value: string;
  expiresAt: number;
}

export class RedditApiError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "RedditApiError";
    this.status = status;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Minimal Reddit OAuth client for script-app credentials.
 *
 * - Caches the access token and refreshes it once on HTTP 401.
 * - Keeps at least one second between requests.
 * - On HTTP 429 it waits for the Retry-After value once, then errors.
 */
export class RedditClient {
  private readonly config: RedditConfig;
  private token: Token | null = null;
  private tokenPromise: Promise<Token> | null = null;
  private lastRequestAt = 0;
  private queue: Promise<void> = Promise.resolve();

  constructor(config: RedditConfig) {
    this.config = config;
  }

  private async fetchToken(): Promise<Token> {
    const credentials = Buffer.from(`${this.config.clientId}:${this.config.clientSecret}`).toString("base64");
    const res = await fetch("https://www.reddit.com/api/v1/access_token", {
      method: "POST",
      headers: {
        Authorization: `Basic ${credentials}`,
        "User-Agent": this.config.userAgent,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new RedditApiError(`Reddit OAuth error ${res.status}: ${res.statusText} ${body}`.trim(), res.status);
    }
    const data = (await res.json()) as { access_token: string; expires_in: number };
    return {
      value: data.access_token,
      // Refresh a minute before the real expiry.
      expiresAt: Date.now() + (data.expires_in - 60) * 1000,
    };
  }

  private async getToken(forceRefresh = false): Promise<string> {
    if (!forceRefresh && this.token && Date.now() < this.token.expiresAt) {
      return this.token.value;
    }
    // Share one in-flight token request between parallel calls.
    this.tokenPromise ??= this.fetchToken();
    try {
      this.token = await this.tokenPromise;
    } finally {
      this.tokenPromise = null;
    }
    return this.token.value;
  }

  /** Serialize requests so the one-second gap holds under parallel tool calls. */
  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(async () => {
      const gap = Date.now() - this.lastRequestAt;
      if (gap < MIN_REQUEST_GAP_MS) await sleep(MIN_REQUEST_GAP_MS - gap);
      this.lastRequestAt = Date.now();
      return fn();
    });
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async requestOnce(path: string, params: Record<string, string | undefined>, signal?: AbortSignal): Promise<Response> {
    const url = new URL(`https://oauth.reddit.com${path}`);
    url.searchParams.set("raw_json", "1");
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) url.searchParams.set(key, value);
    }
    const token = await this.getToken();
    const outerSignal = signal ?? undefined;
    const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const composed = outerSignal ? AbortSignal.any([outerSignal, timeoutSignal]) : timeoutSignal;
    return fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        "User-Agent": this.config.userAgent,
      },
      signal: composed,
    });
  }

  /**
   * GET a Reddit API path and return the parsed JSON. Retries once on 401
   * (token refresh) and once on 429 (Retry-After). Honors the abort signal.
   */
  async get(path: string, params: Record<string, string | undefined> = {}, signal?: AbortSignal): Promise<any> {
    return this.serialize(async () => {
      let res = await this.requestOnce(path, params, signal);

      if (res.status === 401) {
        await this.getToken(true);
        const gap = Date.now() - this.lastRequestAt;
        if (gap < MIN_REQUEST_GAP_MS) await sleep(MIN_REQUEST_GAP_MS - gap);
        this.lastRequestAt = Date.now();
        res = await this.requestOnce(path, params, signal);
      }

      if (res.status === 429) {
        const retryAfter = Number(res.headers.get("retry-after") ?? "0");
        const waitMs = Math.min(Math.max(retryAfter, 1), 60) * 1000;
        await sleep(waitMs);
        const gap = Date.now() - this.lastRequestAt;
        if (gap < MIN_REQUEST_GAP_MS) await sleep(MIN_REQUEST_GAP_MS - gap);
        this.lastRequestAt = Date.now();
        res = await this.requestOnce(path, params, signal);
      }

      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new RedditApiError(
          `Reddit API ${res.status} for ${path}: ${res.statusText}${body ? ` ${body.slice(0, 200)}` : ""}`,
          res.status,
        );
      }
      return res.json();
    });
  }
}
