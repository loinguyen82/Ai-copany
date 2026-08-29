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
- `AI_MODEL` — deploy workflow re-checks `/v1/models` and selects an active model
- `FB_PAGE_ID`
- `FB_PAGE_ACCESS_TOKEN`
- `META_GRAPH_VERSION` — defaults to `v26.0`
- `AUTO_PUBLISH_FACEBOOK` — `false` by default
- `CONTENT_DUPLICATE_THRESHOLD` — default `0.72`

Secrets must be configured as Worker/GitHub secrets, never committed.

## Standalone deploy

The repository has its own manual GitHub Action: `.github/workflows/deploy.yml`. It is intentionally separate from the APIVN application build.

Required GitHub Actions secrets:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`
- `APIVN_API_KEY`
- `AI_COMPANY_ADMIN_TOKEN`

Optional Facebook Page secrets:

- `FB_PAGE_ID`
- `FB_PAGE_ACCESS_TOKEN`

The Cloudflare API token must be able to deploy Workers **and create/write D1 databases (`D1:Edit`)**. A token that can deploy Workers but lacks D1 permission will fail during first D1 provisioning.

The manual deploy workflow:

1. checks required secrets
2. discovers an active APIVN model
3. deploys the Worker and auto-provisions the `DB` D1 binding
4. initializes or migrates the schema
5. syncs Worker secrets
6. deploys the final Worker
7. smoke-tests health, Manager routing, dependency gating and content drafting

Facebook publishing is not exercised by the smoke test.

## Local development

```bash
npm install
npm run dev
```

`wrangler.toml` declares the D1 binding without a hard-coded database ID so Wrangler can provision/link it during deployment.

Existing D1 databases created before coordination fields were added can be upgraded once with:

```bash
npx wrangler d1 execute DB --remote --file=./migrations/0002_coordination.sql --yes
```

## Facebook

Publishing uses the Facebook Page Graph API. Generated content stops at `awaiting_approval` by default.

Generic tasks only auto-publish when both conditions are true:
- `AUTO_PUBLISH_FACEBOOK=true`
- the task was created with `approval_required=false`

This prevents a global auto-publish switch from silently bypassing per-task approval.
