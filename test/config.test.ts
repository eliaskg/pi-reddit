import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_LIMITS, loadConfig } from "../lib/config.ts";

test("loadConfig merges defaults for missing keys", () => {
  // The real config file only has client_id and client_secret.
  const config = loadConfig({} as NodeJS.ProcessEnv);
  assert.equal(typeof config.clientId, "string");
  assert.ok(config.clientId.length > 0);
  assert.equal(config.userAgent.includes("pi-reddit"), true);
  assert.deepEqual(config.limits, DEFAULT_LIMITS);
});

test("loadConfig honors env credential override", () => {
  const config = loadConfig({
    REDDIT_CLIENT_ID: "env-id",
    REDDIT_CLIENT_SECRET: "env-secret",
  } as NodeJS.ProcessEnv);
  assert.equal(config.clientId, "env-id");
  assert.equal(config.clientSecret, "env-secret");
});

test("loadConfig throws with guidance when credentials are missing", () => {
  assert.throws(
    () => loadConfig({} as NodeJS.ProcessEnv, "/nonexistent-pi-reddit-test/reddit.json"),
    (e: Error) => /credentials missing/.test(e.message) && /reddit\.json/.test(e.message),
  );
});
