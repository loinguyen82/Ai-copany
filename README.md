# Ai-copany

Minimal AI-company runtime for APIVN.tech. One Manager routes each task to exactly one specialist team, stores task/memory state in Cloudflare D1, prevents concurrent writes to the same resource, and keeps risky external actions behind approval by default.

## Teams

- `research` — strategy, market, competitors, evidence
- `product` — product + development analysis, patches/test plans
- `marketing` — content and marketing
- `sales` — sales + customer success
- `operations` — operations + finance analysis
- `risk` — risk + legal + security review

Specialists do not delegate to each other. Only the Manager assigns ownership.

## Coordination

`Goal -> Manager -> one owner -> optional resource lock -> result -> approval -> external action -> memory`

Rules:
- one task has one `owner_agent`
- `depends_on` must be `completed` before a task can run
- write-like work can declare a stable `resource`
- only one task can hold a resource lock at a time
- a blocked task can be retried after the other task releases the resource
- `approval_required` defaults to `true`
- Facebook actions executed through the generic task flow lock the target Page during the external write

Example:

```json
{
  "goal": "Prepare a Facebook post about the new APIVN pricing explanation",
  "resource": "marketing:facebook:pricing-post",
  "depends_on": null,
  "approval_required": true
}
```

## Content flow

`Topic/notes -> AI angle + draft -> duplicate check -> approval -> Facebook Page -> publish history`

Personal-profile auto posting is intentionally not supported. For a personal profile, use the dashboard/copy flow and publish manually.

## Endpoints

- `GET /health` (public)
- `POST /tasks`
- `POST /tasks/:id/run`
- `POST /tasks/:id/approve`
- `GET /tasks/:id`
- `POST /content/draft`
- `GET /content?limit=20`
- `GET /content/:id`
- `POST /content/:id/approve`

All endpoints except `/health` require `Authorization: Bearer <ADMIN_TOKEN>`.

## Environment

- `ADMIN_TOKEN`
- `AI_API_KEY`
- `AI_BASE_URL` — defaults to `https://api.apivn.tech/v1`
- `AI_MODEL`
- `FB_PAGE_ID`
- `FB_PAGE_ACCESS_TOKEN`
- `META_GRAPH_VERSION` — defaults to `v26.0`
- `AUTO_PUBLISH_FACEBOOK` — `false` by default
- `CONTENT_DUPLICATE_THRESHOLD` — default `0.72`

Secrets must be configured with Wrangler secrets, not committed to GitHub.

## Database

New database:

```bash
npm install
npx wrangler d1 create ai-company
# Put the returned database id into wrangler.toml and uncomment the D1 block.
npx wrangler d1 execute ai-company --local --file=./schema.sql
npm run dev
```

Existing database created before coordination fields were added:

```bash
npx wrangler d1 execute ai-company --remote --file=./migrations/0002_coordination.sql
```

Apply that migration once.

## Facebook

Publishing uses the Facebook Page Graph API. Generated content stops at `awaiting_approval` by default.

Generic tasks only auto-publish when both conditions are true:
- `AUTO_PUBLISH_FACEBOOK=true`
- the task was created with `approval_required=false`

This prevents a global auto-publish switch from silently bypassing per-task approval.
