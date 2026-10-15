import assert from "node:assert/strict";
import { test } from "node:test";
import { extractPostId, fetchThread, formatPost, formatThread, truncateText } from "../lib/reddit.ts";
import { DEFAULT_LIMITS } from "../lib/config.ts";

test("extractPostId parses reddit.com URLs", () => {
  assert.equal(extractPostId("https://www.reddit.com/r/cybersecurity/comments/1rbnwlf/some_slug/"), "1rbnwlf");
  assert.equal(extractPostId("https://old.reddit.com/r/x/comments/1abcde/"), "1abcde");
  assert.equal(extractPostId("https://redd.it/1rbnwlf"), "1rbnwlf");
  assert.equal(extractPostId("1rbnwlf"), "1rbnwlf");
  assert.throws(() => extractPostId("not a url or id"), /Cannot parse/);
});

test("truncateText collapses blank lines and cuts with ellipsis", () => {
  assert.equal(truncateText("a\n\n\n\nb", 100), "a\n\nb");
  assert.equal(truncateText("x".repeat(50), 10).endsWith("…"), true);
  assert.equal(truncateText(undefined, 10), "");
  assert.equal(truncateText("text", 0), "");
});

function comment(id: string, parentId: string, depth: number, replies?: any): any {
  return {
    kind: "t1",
    data: { id, parent_id: parentId, author: `a_${id}`, score: 1, body: `body ${id}`, replies },
  };
}

test("fetchThread flattens reply trees with depth and parent ids", async () => {
  const tree = [
    comment("aaa", "t3_post1", 0, {
      data: { children: [comment("bbb", "t1_aaa", 1)] },
    }),
    comment("ccc", "t3_post1", 0),
  ];
  const client = {
    async get() {
      return [
        { data: { children: [{ kind: "t3", data: { id: "post1", title: "Title", subreddit: "test", author: "op", score: 5, num_comments: 3, created_utc: 1700000000, permalink: "/r/test/comments/post1/x/", selftext: "hello", is_self: true, upvote_ratio: 0.9 } }] } },
        { data: { children: tree } },
      ];
    },
  };

  const thread = await fetchThread(client as any, "post1", "top", 20, DEFAULT_LIMITS);
  assert.equal(thread.post.title, "Title");
  assert.equal(thread.post.upvoteRatio, 0.9);
  assert.equal(thread.comments.length, 3);
  assert.deepEqual(
    thread.comments.map((c) => [c.id, c.depth, c.parentId]),
    [
      ["aaa", 0, "post1"],
      ["bbb", 1, "aaa"],
      ["ccc", 0, "post1"],
    ],
  );
  assert.equal(thread.commentsTruncated, false);
});

test("fetchThread reports truncation for more stubs and the record limit", async () => {
  const moreStub = { kind: "more", data: { count: 10 } };
  const many = Array.from({ length: 5 }, (_, i) => comment(`c${i}`, "t3_post1", 0));
  const client = {
    async get() {
      return [
        { data: { children: [{ kind: "t3", data: { id: "post1", title: "T", subreddit: "r", author: "a", score: 1, num_comments: 0, created_utc: 0, permalink: "/r/r/comments/post1/", is_self: true } }] } },
        { data: { children: [...many, moreStub] } },
      ];
    },
  };

  // limit 3 stops before all 5 comments; the more stub also counts.
  const limited = await fetchThread(client as any, "post1", "top", 3, DEFAULT_LIMITS);
  assert.equal(limited.comments.length, 3);
  assert.equal(limited.commentsTruncated, true);

  const full = await fetchThread(client as any, "post1", "top", 20, DEFAULT_LIMITS);
  assert.equal(full.comments.length, 5);
  assert.equal(full.commentsTruncated, true); // from the more stub
});

test("formatPost renders meta, link, and selftext on one line", () => {
  const record = {
    id: "p1",
    title: "Hello world",
    subreddit: "test",
    author: "op",
    score: 42,
    numComments: 7,
    createdUtc: "2026-01-01",
    permalink: "https://www.reddit.com/r/test/comments/p1/",
    linkUrl: "https://example.com",
    selftext: "body text",
  };
  const md = formatPost(record as any, 1);
  assert.match(md, /^1\. \[42pts \| 7 comments\] Hello world$/m);
  assert.match(md, /r\/test • u\/op • 2026-01-01$/m);
  assert.match(md, /Link: https:\/\/example\.com$/m);
  assert.match(md, /body text$/m);
});

test("formatThread indents replies by depth", async () => {
  const client = {
    async get() {
      return [
        { data: { children: [{ kind: "t3", data: { id: "post1", title: "Title", subreddit: "test", author: "op", score: 5, num_comments: 2, created_utc: 1700000000, permalink: "/r/test/comments/post1/", selftext: "hello", is_self: true, upvote_ratio: 0.9 } }] } },
        { data: { children: [comment("aaa", "t3_post1", 0, { data: { children: [comment("bbb", "t1_aaa", 1)] } })] } },
      ];
    },
  };
  const md = formatThread(await fetchThread(client as any, "post1", "top", 10, DEFAULT_LIMITS));
  assert.match(md, /^# Title$/m);
  assert.match(md, /--- Comments \(2\) ---/m);
  assert.match(md, /^1\. \[1pts\] u\/a_aaa: body aaa/m);
  assert.match(md, /^  - \[1pts\] u\/a_bbb: body bbb/m);
});
