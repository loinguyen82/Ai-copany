# Ai-copany

Minimal AI-company runtime: one Manager routes work to four specialist roles (research, product, marketing, operations), stores task history/memory in Cloudflare D1, and requires approval for risky external actions by default.

## MVP flow

`Goal -> Manager -> Specialist -> Result -> Approval (when needed) -> External action -> Memory`

Content flow:

`Topic/notes -> AI angle + draft -> duplicate check -> approval -> Facebook Page -> publish history`

The current external action included is Facebook Page publishing through Meta Graph API. Personal-profile auto posting is intentionally not supported.

## Endpoints

- `GET /health` (public)
- `POST /tasks` body: `{ "goal": "..." }`
- `POST /tasks/:id/run`
- `POST /tasks/:id/approve`
- `GET /tasks/:id`
- `POST /content/draft` body: `{ "topic": "...", "audience": "...", "objective": "...", "notes": "..." }`
- `GET /content?limit=20`
- `GET /content/:id`
- `POST /content/:id/approve`

All endpoints except `/health` require `Authorization: Bearer <ADMIN_TOKEN>`.

## Content behavior

`POST /content/draft` creates one Facebook Page draft and stores it in D1. The prompt explicitly blocks invented current facts, prices, statistics, customer results, and news. For time-sensitive claims, pass verified source material in `notes` until a real web-search connector is added.

The worker compares each new draft with the latest 20 saved posts using a lightweight Jaccard similarity check. If the score reaches `CONTENT_DUPLICATE_THRESHOLD` (default `0.72`), it asks the model to rewrite the post with a materially different angle and structure.

Default status is `awaiting_approval`. If `AUTO_PUBLISH_FACEBOOK=true`, the draft is stored first as `publishing`, posted to Facebook, then marked `published`. Failed publish attempts are kept as `publish_failed` rather than silently disappearing.

## Environment

- `ADMIN_TOKEN` - protects the task/control API
- `AI_API_KEY` - OpenAI-compatible API key
- `AI_BASE_URL` - defaults to `https://api.apivn.tech/v1`
- `AI_MODEL` - model name
- `FB_PAGE_ID` - Facebook Page ID
- `FB_PAGE_ACCESS_TOKEN` - Page access token
- `META_GRAPH_VERSION` - defaults to `v26.0`
- `AUTO_PUBLISH_FACEBOOK` - `false` by default
- `CONTENT_DUPLICATE_THRESHOLD` - duplicate rewrite threshold, default `0.72`

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

Default behavior is safe: generated content stops at `awaiting_approval`. Calling `/content/:id/approve` publishes it. Set `AUTO_PUBLISH_FACEBOOK=true` only after the Page integration has been tested successfully.

Use this for a Facebook **Page**, not a personal profile.
