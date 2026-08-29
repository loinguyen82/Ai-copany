# Ai-copany

Minimal AI-company runtime: one Manager routes work to four specialist roles (research, product, marketing, operations), stores task history/memory in Cloudflare D1, and requires approval for risky external actions by default.

## MVP flow

`Goal -> Manager -> Specialist -> Result -> Approval (when needed) -> External action -> Memory`

The current external action included is Facebook Page publishing through Meta Graph API. Personal-profile auto posting is intentionally not supported.

## Endpoints

- `GET /health`
- `POST /tasks` body: `{ "goal": "..." }`
- `POST /tasks/:id/run`
- `POST /tasks/:id/approve`
- `GET /tasks/:id`

## Environment

- `AI_API_KEY` - OpenAI-compatible API key
- `AI_BASE_URL` - defaults to `https://api.apivn.tech/v1`
- `AI_MODEL` - model name
- `FB_PAGE_ID` - Facebook Page ID
- `FB_PAGE_ACCESS_TOKEN` - Page access token
- `META_GRAPH_VERSION` - defaults to `v26.0`
- `AUTO_PUBLISH_FACEBOOK` - `false` by default; set `true` only if you intentionally want approved-by-policy automatic publishing

Secrets must be configured with Wrangler secrets, not committed to GitHub.

## Run

```bash
npm install
npx wrangler d1 create ai-company
# Put the returned database id into wrangler.toml
npx wrangler d1 execute ai-company --local --file=./schema.sql
npm run dev
```

For production, run the same schema against the remote D1 database and configure secrets before deploying.

## Facebook

Publishing uses `POST /{page-id}/feed` with a Page access token. Your Meta app/Page needs the relevant Page permissions (notably `pages_manage_posts`) and production access requirements from Meta. Keep `AUTO_PUBLISH_FACEBOOK=false` until the Page integration is verified.
