# Ai-copany

Minimal AI-company runtime: one Manager routes work to four specialist roles (research, product, marketing, operations), stores task history/memory in Cloudflare D1, and requires approval for risky external actions by default.

## MVP flow

`Goal -> Manager -> Specialist -> Result -> Approval (when needed) -> External action -> Memory`

The current external action included is Facebook Page publishing through Meta Graph API. Personal-profile auto posting is intentionally not supported.

## Endpoints

- `GET /health` (public)
- `POST /tasks` body: `{ "goal": "..." }`
- `POST /tasks/:id/run`
- `POST /tasks/:id/approve`
- `GET /tasks/:id`

All task endpoints require `Authorization: Bearer <ADMIN_TOKEN>`.

## Environment

- `ADMIN_TOKEN` - protects the task/control API
- `AI_API_KEY` - OpenAI-compatible API key
- `AI_BASE_URL` - defaults to `https://api.apivn.tech/v1`
- `AI_MODEL` - model name
- `FB_PAGE_ID` - Facebook Page ID
- `FB_PAGE_ACCESS_TOKEN` - Page access token
- `META_GRAPH_VERSION` - defaults to `v26.0`
- `AUTO_PUBLISH_FACEBOOK` - `false` by default; set `true` only when you intentionally want automatic Page publishing

Secrets must be configured with Wrangler secrets, not committed to GitHub.

## Run

```bash
npm install
npx wrangler d1 create ai-company
# Put the returned database id into wrangler.toml and uncomment the D1 block.
npx wrangler d1 execute ai-company --local --file=./schema.sql
npm run dev
```

For production, apply `schema.sql` to the remote D1 database and configure secrets before deploying.

## Facebook auto-post

Publishing uses `POST /{page-id}/feed` with a Page access token. Your Meta app/Page needs the relevant Page permissions, notably `pages_manage_posts`, plus Meta's production access requirements.

Default behavior is safe: the marketing agent can prepare a post, but the task stops at `awaiting_approval`. Calling `/tasks/:id/approve` publishes it. If you later set `AUTO_PUBLISH_FACEBOOK=true`, a generated Facebook Page action publishes immediately after the agent finishes.

Use this for a Facebook **Page**, not a personal profile.
