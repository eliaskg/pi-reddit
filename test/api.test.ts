import assert from "node:assert/strict";
import { test } from "node:test";
import { RedditClient } from "../lib/api.ts";
import { DEFAULT_LIMITS } from "../lib/config.ts";

const CONFIG = {
  clientId: "test-id",
  clientSecret: "test-secret",
  userAgent: "test-agent",
  limits: DEFAULT_LIMITS,
};

type FetchCall = { url: string; init?: RequestInit };

/** Stub global fetch; handler receives each call and returns a Response. */
function stubFetch(handler: (call: FetchCall, index: number) => Response | Promise<Response>) {
  const calls: FetchCall[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: any, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return handler(calls[calls.length - 1], calls.length - 1);
  }) as typeof fetch;
  return {
    calls,
    restore() {
      globalThis.fetch = original;
    },
  };
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function tokenResponse(): Response {
  return jsonResponse({ access_token: "tok", expires_in: 3600 });
}

test("RedditClient refreshes the token once on 401 and retries", async () => {
  const stub = stubFetch((call, index) => {
    if (call.url.includes("access_token")) return tokenResponse();
    if (index === 1) return new Response("unauthorized", { status: 401 }); // first API call
    return jsonResponse({ data: { children: [] } }); // retry succeeds
  });
  try {
    const client = new RedditClient(CONFIG);
    const data = await client.get("/search", { q: "test" });
    assert.deepEqual(data, { data: { children: [] } });
    const apiCalls = stub.calls.filter((c) => !c.url.includes("access_token"));
    assert.equal(apiCalls.length, 2);
    // Bearer token was sent
    const auth = (apiCalls[0].init?.headers as Record<string, string>).Authorization;
    assert.equal(auth, "Bearer tok");
    // raw_json is always appended
    assert.match(apiCalls[0].url, /raw_json=1/);
    assert.match(apiCalls[0].url, /q=test/);
  } finally {
    stub.restore();
  }
});

test("RedditClient waits on 429 Retry-After and retries once", async () => {
  const stub = stubFetch((call, index) => {
    if (call.url.includes("access_token")) return tokenResponse();
    if (index === 1) return new Response("slow down", { status: 429, headers: { "Retry-After": "1" } });
    return jsonResponse({ ok: true });
  });
  try {
    const client = new RedditClient(CONFIG);
    const data = await client.get("/search", { q: "x" });
    assert.deepEqual(data, { ok: true });
    const apiCalls = stub.calls.filter((c) => !c.url.includes("access_token"));
    assert.equal(apiCalls.length, 2);
  } finally {
    stub.restore();
  }
});

test("RedditClient throws a RedditApiError on persistent failure", async () => {
  const stub = stubFetch((call) => {
    if (call.url.includes("access_token")) return tokenResponse();
    return new Response("nope", { status: 403 });
  });
  try {
    const client = new RedditClient(CONFIG);
    await assert.rejects(() => client.get("/search"), /Reddit API 403/);
  } finally {
    stub.restore();
  }
});

test("RedditClient omits undefined params", async () => {
  const stub = stubFetch((call) => {
    if (call.url.includes("access_token")) return tokenResponse();
    return jsonResponse({ data: { children: [] } });
  });
  try {
    const client = new RedditClient(CONFIG);
    await client.get("/r/test/top", { t: "week", after: undefined, limit: "5" });
    const url = stub.calls[1].url;
    assert.match(url, /t=week/);
    assert.match(url, /limit=5/);
    assert.doesNotMatch(url, /after/);
  } finally {
    stub.restore();
  }
});
