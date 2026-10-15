# pi-reddit

Read-only Reddit tools for Pi. The extension exposes three tools:

- `reddit-search`: keyword search across Reddit or inside subreddits.
- `reddit-top`: top posts of a subreddit.
- `reddit-post`: one post with its comment tree.

The tools use the official Reddit API with script-app credentials. They never write.

## Install

```
pi install npm:pi-reddit
```

Restart Pi after installation.


## Setup

Create `~/.pi/agent/reddit.json`:

```json
{
  "client_id": "your-script-app-id",
  "client_secret": "your-script-app-secret"
}
```

Create the credentials at https://www.reddit.com/prefs/apps as a "script" app.

All other settings are optional. Defaults apply when a key is missing:

```json
{
  "userAgent": "pi-agent:pi-reddit:1.0 (by /u/yourname)",
  "limits": {
    "searchSelftextChars": 300,
    "postSelftextChars": 2000,
    "commentBodyChars": 1000,
    "defaultComments": 20,
    "maxComments": 50,
    "defaultLimit": 10
  }
}
```

Environment variables override the file credentials:

- `REDDIT_CLIENT_ID`
- `REDDIT_CLIENT_SECRET`

## Rate limits

The client keeps at least one second between requests. On HTTP 429 it waits for the `Retry-After` value once, then errors. Access tokens are cached and refreshed once on HTTP 401.
