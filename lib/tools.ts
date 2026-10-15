import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { RedditApiError, RedditClient } from "./api.ts";
import { loadConfig, type RedditConfig } from "./config.ts";
import { extractPostId, fetchThread, formatPost, formatThread, toPost } from "./reddit.ts";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const SortParam = Type.Union(
  ["relevance", "hot", "top", "new", "comments"].map((s) => Type.Literal(s)),
  { description: "Result sort. Default: top." },
);

const TimeParam = Type.Union(
  ["hour", "day", "week", "month", "year", "all"].map((t) => Type.Literal(t)),
  { description: "Time period. Default: year." },
);

const PostSchema = Type.Object({
  id: Type.String({ description: "Reddit post id (base36)" }),
  title: Type.String(),
  subreddit: Type.String({ description: "Subreddit without r/ prefix" }),
  author: Type.String(),
  score: Type.Number(),
  numComments: Type.Number(),
  createdUtc: Type.String({ description: "Post date, ISO 8601 date" }),
  permalink: Type.String({ description: "Full reddit.com URL" }),
  linkUrl: Type.Optional(Type.String({ description: "External URL for link posts" })),
  selftext: Type.String({ description: "Post body, truncated" }),
});

const CommentSchema = Type.Object({
  id: Type.String(),
  parentId: Type.String({ description: "Id of the parent comment or post" }),
  depth: Type.Number({ description: "0 for top-level comments" }),
  author: Type.String(),
  score: Type.Number(),
  body: Type.String({ description: "Comment text, truncated" }),
});

const SearchOutput = Type.Object({
  query: Type.String(),
  subreddits: Type.Array(Type.String(), { description: "Queried subreddits; empty for global search" }),
  total: Type.Number(),
  after: Type.Optional(Type.String({ description: "Cursor for the next page; pass it back as `after`" })),
  posts: Type.Array(PostSchema),
});

const TopOutput = Type.Object({
  subreddit: Type.String(),
  time: Type.String(),
  total: Type.Number(),
  after: Type.Optional(Type.String()),
  posts: Type.Array(PostSchema),
});

const ThreadOutput = Type.Object({
  post: Type.Object({
    ...PostSchema.properties,
    upvoteRatio: Type.Number({ description: "Share of upvotes, 0 to 1" }),
  }),
  comments: Type.Array(CommentSchema),
  commentsTruncated: Type.Boolean({ description: "True when the listing held more comments than the limit" }),
});

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

// One config and client per extension process. Config loads lazily on the
// first tool call, so a missing reddit.json does not break unrelated sessions.
let cachedConfig: RedditConfig | undefined;
let cachedClient: RedditClient | undefined;

function getClient(): { config: RedditConfig; client: RedditClient } {
  cachedConfig ??= loadConfig();
  cachedClient ??= new RedditClient(cachedConfig);
  return { config: cachedConfig, client: cachedClient };
}

function listingPosts(listing: any, selftextChars: number): { posts: any[]; after?: string } {
  const children = listing?.data?.children ?? [];
  return {
    posts: children.filter((c: any) => c.kind === "t3").map((c: any) => c.data),
    after: listing?.data?.after ?? undefined,
  };
}

function clampLimit(value: number | undefined, config: RedditConfig): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return config.limits.defaultLimit;
  return Math.min(Math.max(Math.trunc(value), 1), 100);
}

function renderCompactPost(theme: Theme, record: any, index: number): string {
  const title = theme.fg("text", record.title);
  const meta = theme.fg("muted", `  [${record.score}pts ${record.numComments}c] r/${record.subreddit}`);
  return `${theme.fg("dim", `${index}.`)} ${title}${meta}`;
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

const searchTool = {
  name: "reddit-search",
  label: "Reddit search",
  description:
    "Search Reddit posts by keyword, across all of Reddit or scoped to subreddits. " +
    "Results from multiple subreddits merge into one list, tagged with their subreddit. " +
    "Pass the `after` cursor from a previous result to page deeper.",
  parameters: Type.Object({
    query: Type.String({ description: "Search keywords" }),
    subreddits: Type.Optional(
      Type.Array(Type.String(), { description: "Scope the search to these subreddits, without r/ prefix. Empty or omitted: search all of Reddit." }),
    ),
    sort: Type.Optional(SortParam),
    time: Type.Optional(TimeParam),
    limit: Type.Optional(Type.Number({ description: "Results per call, 1 to 100. Default 10." })),
    after: Type.Optional(Type.String({ description: "Cursor from a previous result to fetch the next page" })),
  }),
  outputSchema: SearchOutput,
  annotations: { readOnlyHint: true, openWorldHint: true },

  async execute(_toolCallId: string, params: any, signal?: AbortSignal, _onUpdate?: unknown, _ctx?: any) {
    const { config, client } = getClient();

    const limit = clampLimit(params.limit, config);
    const subs = (params.subreddits ?? []).map((s: string) => s.replace(/^r\//, "")).filter(Boolean);
    const commonParams: Record<string, string | undefined> = {
      q: params.query,
      sort: params.sort ?? "top",
      t: params.time ?? "year",
      limit: String(limit),
      after: params.after,
    };

    const posts: any[] = [];
    let after: string | undefined;
    let cursor: string | undefined;

    const paths = subs.length ? subs.map((sub) => `/r/${sub}/search`) : ["/search"];
    if (subs.length) commonParams.restrict_sr = "1";

    for (const p of paths) {
      const listing = await client.get(p, commonParams, signal);
      const page = listingPosts(listing, 0);
      for (const data of page.posts) {
        if (posts.length >= limit) break;
        posts.push(data);
      }
      after ??= page.after;
      cursor = page.after;
      if (posts.length >= limit) break;
    }

    const records = posts.map((data) => toPost(data, config.limits.searchSelftextChars));
    const structured = {
      query: params.query,
      subreddits: subs,
      total: records.length,
      after: cursor,
      posts: records,
    };
    const markdown = records.length
      ? records.map((r, i) => formatPost(r, i + 1)).join("\n\n")
      : "No results found.";

    return {
      content: [{ type: "text" as const, text: markdown }],
      structuredContent: structured,
      details: structured,
    };
  },

  renderCall(args: any, theme: Theme) {
    let text = theme.fg("toolTitle", theme.bold("reddit-search "));
    text += theme.fg("accent", `"${args.query ?? ""}"`);
    const subs = args.subreddits ?? [];
    if (subs.length) text += theme.fg("muted", ` in r/${subs.join(", r/")}`);
    if (args.sort) text += theme.fg("dim", ` sort=${args.sort}`);
    if (args.time) text += theme.fg("dim", ` time=${args.time}`);
    return new Text(text, 0, 0);
  },

  renderResult(result: any, _options: any, theme: Theme) {
    const details = result.details as { total: number; posts: any[]; after?: string } | undefined;
    if (!details) return new Text(theme.fg("dim", "no results"), 0, 0);
    if (!details.posts?.length) return new Text(theme.fg("dim", "No results found"), 0, 0);

    const lines = [theme.fg("success", `${details.total} posts`)];
    details.posts.slice(0, 12).forEach((p, i) => lines.push(renderCompactPost(theme, p, i + 1)));
    if (details.posts.length > 12) lines.push(theme.fg("dim", "…"));
    if (details.after) lines.push(theme.fg("muted", "more pages available (after cursor)"));
    return new Text(lines.join("\n"), 0, 0);
  },
};

const topTool = {
  name: "reddit-top",
  label: "Reddit top posts",
  description: "List the top posts of one subreddit for a time period. Pass the `after` cursor from a previous result to page deeper.",
  parameters: Type.Object({
    subreddit: Type.String({ description: "Subreddit without r/ prefix" }),
    time: Type.Optional(TimeParam),
    limit: Type.Optional(Type.Number({ description: "Results per call, 1 to 100. Default 10." })),
    after: Type.Optional(Type.String({ description: "Cursor from a previous result to fetch the next page" })),
  }),
  outputSchema: TopOutput,
  annotations: { readOnlyHint: true, openWorldHint: true },

  async execute(_toolCallId: string, params: any, signal?: AbortSignal, _onUpdate?: unknown, _ctx?: any) {
    const { config, client } = getClient();
    const limit = clampLimit(params.limit, config);
    const sub = params.subreddit.replace(/^r\//, "");

    const listing = await client.get(
      `/r/${sub}/top`,
      { t: params.time ?? "year", limit: String(limit), after: params.after },
      signal,
    );
    const page = listingPosts(listing, 0);
    const records = page.posts.map((data) => toPost(data, config.limits.searchSelftextChars));
    const structured = {
      subreddit: sub,
      time: params.time ?? "year",
      total: records.length,
      after: page.after,
      posts: records,
    };
    const markdown = records.length
      ? records.map((r, i) => formatPost(r, i + 1)).join("\n\n")
      : `No posts found in r/${sub}.`;

    return {
      content: [{ type: "text" as const, text: markdown }],
      structuredContent: structured,
      details: structured,
    };
  },

  renderCall(args: any, theme: Theme) {
    let text = theme.fg("toolTitle", theme.bold("reddit-top "));
    text += theme.fg("accent", `r/${args.subreddit ?? ""}`);
    if (args.time) text += theme.fg("dim", ` time=${args.time}`);
    if (args.limit) text += theme.fg("dim", ` limit=${args.limit}`);
    return new Text(text, 0, 0);
  },

  renderResult(result: any, _options: any, theme: Theme) {
    const details = result.details as { total: number; posts: any[]; after?: string } | undefined;
    if (!details?.posts?.length) return new Text(theme.fg("dim", "No posts found"), 0, 0);
    const lines = [theme.fg("success", `${details.total} posts`)];
    details.posts.slice(0, 12).forEach((p, i) => lines.push(renderCompactPost(theme, p, i + 1)));
    if (details.posts.length > 12) lines.push(theme.fg("dim", "…"));
    if (details.after) lines.push(theme.fg("muted", "more pages available (after cursor)"));
    return new Text(lines.join("\n"), 0, 0);
  },
};

const postTool = {
  name: "reddit-post",
  label: "Reddit thread",
  description:
    "Read one Reddit post with its comment tree. Comments come flattened with depth and parent ids, " +
    "so reply threads stay readable. Accepts a reddit.com post URL or a bare post id. " +
    "Use reddit-search or reddit-top first to find the URL.",
  parameters: Type.Object({
    post: Type.String({ description: "Post URL or bare post id" }),
    commentSort: Type.Optional(
      Type.Union(["top", "new", "controversial", "qa"].map((s) => Type.Literal(s)), {
        description: "Comment sort. Default: top.",
      }),
    ),
    commentLimit: Type.Optional(
      Type.Number({ description: "Maximum comments returned across all depths. Default 20." }),
    ),
  }),
  outputSchema: ThreadOutput,
  annotations: { readOnlyHint: true, openWorldHint: true },

  async execute(_toolCallId: string, params: any, signal?: AbortSignal, _onUpdate?: unknown, _ctx?: any) {
    const { config, client } = getClient();
    const postId = extractPostId(params.post);
    const commentLimit = Math.min(
      Math.max(typeof params.commentLimit === "number" ? Math.trunc(params.commentLimit) : config.limits.defaultComments, 1),
      config.limits.maxComments,
    );
    const commentSort = params.commentSort ?? "top";

    const thread = await fetchThread(client, postId, commentSort, commentLimit, config.limits, signal);
    const structured = {
      post: { ...thread.post },
      comments: thread.comments,
      commentsTruncated: thread.commentsTruncated,
    };
    const markdown = formatThread(thread);

    return {
      content: [{ type: "text" as const, text: markdown }],
      structuredContent: structured,
      details: {
        title: thread.post.title,
        subreddit: thread.post.subreddit,
        commentCount: thread.comments.length,
        commentsTruncated: thread.commentsTruncated,
      },
    };
  },

  renderCall(args: any, theme: Theme) {
    const text = theme.fg("toolTitle", theme.bold("reddit-post ")) + theme.fg("accent", args.post ?? "");
    return new Text(text, 0, 0);
  },

  renderResult(result: any, _options: any, theme: Theme) {
    const details = result.details as
      | { title: string; subreddit: string; commentCount: number; commentsTruncated: boolean }
      | undefined;
    if (!details) {
      const first = result.content?.[0];
      return new Text(first?.type === "text" ? first.text.slice(0, 200) : "", 0, 0);
    }
    let text = theme.fg("toolTitle", theme.bold(details.title));
    text += theme.fg("muted", `  r/${details.subreddit}`);
    text += "\n" + theme.fg("success", `${details.commentCount} comments`);
    if (details.commentsTruncated) text += theme.fg("warning", " (truncated)");
    return new Text(text, 0, 0);
  },
};

export default function registerRedditTools(pi: ExtensionAPI) {
  pi.registerTool(searchTool as any);
  pi.registerTool(topTool as any);
  pi.registerTool(postTool as any);
}

// Exported for tests.
export { RedditApiError, RedditClient, loadConfig };
