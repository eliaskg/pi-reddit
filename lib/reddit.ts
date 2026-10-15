import type { RedditLimits } from "./config.ts";

export interface PostRecord {
  id: string;
  title: string;
  subreddit: string;
  author: string;
  score: number;
  numComments: number;
  createdUtc: string;
  permalink: string;
  linkUrl?: string;
  selftext: string;
}

export interface CommentRecord {
  id: string;
  parentId: string;
  depth: number;
  author: string;
  score: number;
  body: string;
}

export interface ThreadResult {
  post: PostRecord & { upvoteRatio: number };
  comments: CommentRecord[];
  commentsTruncated: boolean;
}

/** Collapse runs of blank lines, then cut to maxChars with an ellipsis. */
export function truncateText(text: string | undefined, maxChars: number): string {
  if (!text) return "";
  const cleaned = text.replace(/\n{3,}/g, "\n\n").trim();
  if (maxChars <= 0) return "";
  if (cleaned.length <= maxChars) return cleaned;
  return cleaned.slice(0, maxChars).trimEnd() + "…";
}

function formatDate(createdUtc: number): string {
  return new Date(createdUtc * 1000).toISOString().slice(0, 10);
}

export function toPost(data: any, selftextChars: number): PostRecord {
  const record: PostRecord = {
    id: data.id,
    title: data.title ?? "",
    subreddit: data.subreddit ?? "",
    author: data.author ?? "[unknown]",
    score: data.score ?? 0,
    numComments: data.num_comments ?? 0,
    createdUtc: formatDate(data.created_utc ?? 0),
    permalink: `https://www.reddit.com${data.permalink ?? ""}`,
    selftext: truncateText(data.selftext, selftextChars),
  };
  if (data.url && !data.is_self) record.linkUrl = data.url;
  return record;
}

/**
 * Flatten a comment listing into records with depth. Walks reply trees,
 * counts "more" stubs as truncation, and stops at the record limit.
 */
function walkComments(
  children: any[],
  depth: number,
  out: CommentRecord[],
  limits: { maxRecords: number; bodyChars: number },
): boolean {
  let truncated = false;
  for (const child of children) {
    if (out.length >= limits.maxRecords) return true;
    if (child.kind !== "t1") {
      // "more" stubs mean the listing cut comments off.
      truncated = true;
      continue;
    }
    const d = child.data;
    out.push({
      id: d.id,
      parentId: (d.parent_id ?? "").replace(/^(t1_|t3_)/, ""),
      depth,
      author: d.author ?? "[unknown]",
      score: d.score ?? 0,
      body: truncateText(d.body, limits.bodyChars),
    });
    const replies = d.replies?.data?.children;
    if (Array.isArray(replies)) {
      if (walkComments(replies, depth + 1, out, limits)) truncated = true;
    }
  }
  return truncated;
}

/**
 * Accept a full reddit.com URL, a redd.it share URL, or a bare post id
 * and return the base36 post id.
 */
export function extractPostId(input: string): string {
  const trimmed = input.trim().replace(/\/$/, "");
  try {
    const url = new URL(trimmed);
    const segments = url.pathname.split("/").filter(Boolean);
    const commentsIndex = segments.indexOf("comments");
    if (commentsIndex !== -1 && segments[commentsIndex + 1]) {
      return segments[commentsIndex + 1];
    }
    // redd.it/<id> share links
    if (url.hostname.includes("redd.it") && segments[0]) return segments[0];
  } catch {
    // not a URL, fall through
  }
  if (/^[a-z0-9]{6,10}$/.test(trimmed)) return trimmed;
  throw new Error(`Cannot parse a post id from "${input}". Pass a reddit.com post URL or a bare post id.`);
}

/** Format one search/top result as a markdown block. */
export function formatPost(record: PostRecord, index: number): string {
  const lines: string[] = [];
  const meta: string[] = [`r/${record.subreddit}`, `u/${record.author}`, record.createdUtc];
  lines.push(`${index}. [${record.score}pts | ${record.numComments} comments] ${record.title}`);
  lines.push(`   ${meta.join(" • ")}`);
  if (record.linkUrl) lines.push(`   Link: ${record.linkUrl}`);
  lines.push(`   ${record.permalink}`);
  if (record.selftext) lines.push(`   ${record.selftext.replace(/\n/g, " ")}`);
  return lines.join("\n");
}

/** Format the full thread as markdown, comments indented by depth. */
export function formatThread(thread: ThreadResult): string {
  const p = thread.post;
  const lines: string[] = [];
  lines.push(`# ${p.title}`);
  lines.push(`r/${p.subreddit} • u/${p.author} • ${p.createdUtc} • ${Math.round(p.upvoteRatio * 100)}% upvoted`);
  lines.push(`Score: ${p.score} | Comments: ${p.numComments}`);
  if (p.linkUrl) lines.push(`Link: ${p.linkUrl}`);
  lines.push(p.permalink);
  if (p.selftext) lines.push("", p.selftext);
  if (thread.comments.length) {
    lines.push("", `--- Comments (${thread.comments.length}${thread.commentsTruncated ? ", truncated" : ""}) ---`, "");
    let topIndex = 0;
    let lastDepth = -1;
    for (const c of thread.comments) {
      if (c.depth === 0) topIndex++;
      const indent = "  ".repeat(Math.min(c.depth, 8));
      const bullet = c.depth === 0 ? `${topIndex}.` : "-";
      if (c.depth > 0 && lastDepth >= c.depth) lines.push(`${indent}`);
      lines.push(`${indent}${bullet} [${c.score}pts] u/${c.author}: ${c.body.replace(/\n+/g, " ")}`);
      lastDepth = c.depth;
    }
  } else {
    lines.push("", "No comments.");
  }
  return lines.join("\n");
}

/**
 * Fetch one post with its flattened comment tree.
 * commentSort: top, new, controversial, or qa (Reddit's q&a sort).
 */
export async function fetchThread(
  client: { get(path: string, params?: Record<string, string | undefined>, signal?: AbortSignal): Promise<any> },
  postId: string,
  commentSort: string,
  commentLimit: number,
  limits: RedditLimits,
  signal?: AbortSignal,
): Promise<ThreadResult> {
  const data = await client.get(
    `/comments/${postId}`,
    { limit: String(Math.max(commentLimit * 2, commentLimit)), sort: commentSort },
    signal,
  );
  const postData = data?.[0]?.data?.children?.[0]?.data;
  if (!postData) throw new Error(`Post ${postId} not found.`);
  const post = { ...toPost(postData, limits.postSelftextChars), upvoteRatio: postData.upvote_ratio ?? 0 };

  const comments: CommentRecord[] = [];
  const children = data?.[1]?.data?.children ?? [];
  const truncated = walkComments(children, 0, comments, {
    maxRecords: commentLimit,
    bodyChars: limits.commentBodyChars,
  });

  return { post, comments, commentsTruncated: truncated };
}
