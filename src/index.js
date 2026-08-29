import { handleContentRequest } from './content.js';

const AGENTS = {
  research: 'Research strategy, market, competitors and evidence. Separate facts from assumptions and never invent current information.',
  product: 'Own product and development analysis. Turn goals into the smallest useful requirement, patch or test plan. Prefer KISS/YAGNI.',
  marketing: 'Own marketing and content. Create practical output tied to a measurable goal. Avoid spam, fake urgency and deceptive claims.',
  sales: 'Own sales and customer success work. Qualify needs, draft helpful follow-ups and surface customer risks without pretending to be a human.',
  operations: 'Own repeatable operations and finance analysis. Track usage, cost, margin and operational health. Never spend or transfer money without approval.',
  risk: 'Own risk, legal and security review. Identify concrete issues, permissions, data exposure and compliance concerns. Default risky writes to human approval.'
};

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      const method = request.method.toUpperCase();

      if (method === 'GET' && url.pathname === '/health') {
        return json({ ok: true, service: 'ai-copany', database: Boolean(env.DB) });
      }

      if (!env.ADMIN_TOKEN) return json({ error: 'ADMIN_TOKEN is not configured' }, 503);
      if (request.headers.get('authorization') !== `Bearer ${env.ADMIN_TOKEN}`) {
        return json({ error: 'unauthorized' }, 401);
      }
      if (!env.DB) return json({ error: 'DB binding is not configured' }, 503);

      if (url.pathname === '/content' || url.pathname.startsWith('/content/')) {
        const contentResponse = await handleContentRequest(request, env, {
          callAI,
          publishFacebook,
          json,
          readJson
        });
        if (contentResponse) return contentResponse;
      }

      if (method === 'POST' && url.pathname === '/tasks') {
        const body = await readJson(request);
        const goal = String(body.goal || '').trim();
        if (!goal) return json({ error: 'goal is required' }, 400);

        const resource = normalizeResource(body.resource);
        const dependsOn = normalizeId(body.depends_on);
        const approvalRequired = body.approval_required === false ? 0 : 1;

        if (dependsOn) {
          const dependency = await getTask(env, dependsOn);
          if (!dependency) return json({ error: 'depends_on task not found' }, 400);
        }

        const id = crypto.randomUUID();
        const now = new Date().toISOString();
        await env.DB.prepare(
          `INSERT INTO tasks
           (id, goal, resource, depends_on, approval_required, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(id, goal, resource, dependsOn, approvalRequired, 'queued', now, now).run();

        return json({
          id,
          goal,
          resource,
          depends_on: dependsOn,
          approval_required: Boolean(approvalRequired),
          status: 'queued'
        }, 201);
      }

      const taskMatch = url.pathname.match(/^\/tasks\/([^/]+)$/);
      if (method === 'GET' && taskMatch) {
        const task = await getTask(env, taskMatch[1]);
        return task ? json(formatTask(task)) : json({ error: 'task not found' }, 404);
      }

      const runMatch = url.pathname.match(/^\/tasks\/([^/]+)\/run$/);
      if (method === 'POST' && runMatch) return runTask(env, runMatch[1]);

      const approveMatch = url.pathname.match(/^\/tasks\/([^/]+)\/approve$/);
      if (method === 'POST' && approveMatch) return approveTask(env, approveMatch[1]);

      return json({ error: 'not found' }, 404);
    } catch (error) {
      console.error(error);
      return json({ error: error instanceof Error ? error.message : 'internal error' }, 500);
    }
  }
};

async function runTask(env, id) {
  const task = await getTask(env, id);
  if (!task) return json({ error: 'task not found' }, 404);
  if (!['queued', 'failed', 'blocked'].includes(task.status)) {
    return json({ error: `task cannot run from status ${task.status}` }, 409);
  }

  const dependency = await checkDependency(env, task);
  if (!dependency.ok) {
    return json({
      error: 'dependency_not_completed',
      depends_on: task.depends_on,
      dependency_status: dependency.status
    }, 409);
  }

  await setStatus(env, id, 'running');
  let lockedResource = null;

  try {
    const memories = await env.DB.prepare(
      'SELECT kind, content FROM memories ORDER BY id DESC LIMIT 8'
    ).all();
    const memoryText = (memories.results || [])
      .reverse()
      .map((m) => `[${m.kind}] ${m.content}`)
      .join('\n');

    const manager = await callAI(env, [
      {
        role: 'system',
        content:
          'You are the only manager allowed to assign work in APIVN AI Company. ' +
          'Route the goal to exactly one specialist: research, product, marketing, sales, operations, or risk. ' +
          'Specialists never delegate to each other and never change task ownership themselves. Return JSON only: ' +
          '{"agent":"...","instructions":"...","resource":null} or ' +
          '{"agent":"...","instructions":"...","resource":"stable-resource-key"}. ' +
          'Use resource=null for read-only work. For work that may write or change one shared thing, ' +
          'use a stable resource key identifying that thing so concurrent tasks cannot modify it.'
      },
      {
        role: 'user',
        content:
          `Company memory:\n${memoryText || '(empty)'}\n\n` +
          `Requested resource override: ${task.resource || '(none)'}\n` +
          `Goal:\n${task.goal}`
      }
    ]);

    const plan = parseAIJson(manager);
    const agent = AGENTS[plan.agent] ? plan.agent : 'operations';
    const instructions = String(plan.instructions || task.goal);
    const effectiveResource = task.resource || normalizeResource(plan.resource);

    await env.DB.prepare(
      'UPDATE tasks SET agent = ?, owner_agent = ?, resource = ?, plan_json = ?, updated_at = ? WHERE id = ?'
    ).bind(
      agent,
      agent,
      effectiveResource,
      JSON.stringify({ ...plan, agent, resource: effectiveResource }),
      new Date().toISOString(),
      id
    ).run();

    if (effectiveResource) {
      const lock = await acquireResourceLock(env, effectiveResource, id, agent);
      if (!lock.ok) {
        await setStatus(env, id, 'blocked');
        return json({
          error: 'resource_locked',
          resource: effectiveResource,
          locked_by_task: lock.task_id,
          locked_by_agent: lock.owner_agent
        }, 409);
      }
      lockedResource = effectiveResource;
    }

    const worker = await callAI(env, [
      {
        role: 'system',
        content:
          `${AGENTS[agent]} You are the ${agent} specialist. ` +
          'You execute only the manager instructions. You must not delegate, call another agent, ' +
          'change task ownership, or expand the scope. Output JSON only with this shape: ' +
          '{"summary":"...","memory":"...","action":null} or ' +
          '{"summary":"...","memory":"...","action":{"type":"facebook_page_post","message":"..."}}. ' +
          'Only request facebook_page_post when publishing a Page post is genuinely part of the goal.'
      },
      {
        role: 'user',
        content:
          `Manager instructions:\n${instructions}\n\n` +
          `Owned resource: ${effectiveResource || '(read-only / none)'}\n\n` +
          `Original goal:\n${task.goal}`
      }
    ]);

    const result = parseAIJson(worker);
    const action = normalizeAction(result.action);
    const approvalRequired = Number(task.approval_required ?? 1) !== 0;

    let status = action ? 'awaiting_approval' : 'completed';
    let externalResult = null;

    if (
      action?.type === 'facebook_page_post' &&
      env.AUTO_PUBLISH_FACEBOOK === 'true' &&
      !approvalRequired
    ) {
      externalResult = await executeExternalAction(env, task, agent, action);
      status = 'completed';
    }

    const storedResult = {
      summary: String(result.summary || ''),
      memory: String(result.memory || ''),
      action,
      external_result: externalResult
    };

    const now = new Date().toISOString();
    await env.DB.prepare(
      'UPDATE tasks SET result_json = ?, status = ?, updated_at = ? WHERE id = ?'
    ).bind(JSON.stringify(storedResult), status, now, id).run();

    if (storedResult.memory) {
      await env.DB.prepare(
        'INSERT INTO memories (kind, content, created_at) VALUES (?, ?, ?)'
      ).bind(agent, storedResult.memory, now).run();
    }

    return json({
      id,
      owner_agent: agent,
      resource: effectiveResource,
      status,
      approval_required: approvalRequired,
      result: storedResult
    });
  } catch (error) {
    await setStatus(env, id, 'failed');
    throw error;
  } finally {
    if (lockedResource) await releaseResourceLock(env, lockedResource, id);
  }
}

async function approveTask(env, id) {
  const task = await getTask(env, id);
  if (!task) return json({ error: 'task not found' }, 404);
  if (task.status !== 'awaiting_approval') {
    return json({ error: `task is not awaiting approval (${task.status})` }, 409);
  }

  const dependency = await checkDependency(env, task);
  if (!dependency.ok) {
    return json({
      error: 'dependency_not_completed',
      depends_on: task.depends_on,
      dependency_status: dependency.status
    }, 409);
  }

  const result = safeJson(task.result_json) || {};
  const action = normalizeAction(result.action);
  if (!action) return json({ error: 'task has no approvable action' }, 409);

  const ownerAgent = task.owner_agent || task.agent || 'operations';
  const externalResult = await executeExternalAction(env, task, ownerAgent, action);

  result.external_result = externalResult;
  const now = new Date().toISOString();
  await env.DB.prepare(
    'UPDATE tasks SET result_json = ?, status = ?, updated_at = ? WHERE id = ?'
  ).bind(JSON.stringify(result), 'completed', now, id).run();

  return json({ id, status: 'completed', result });
}

async function executeExternalAction(env, task, ownerAgent, action) {
  if (action.type !== 'facebook_page_post') throw new Error('unsupported action type');

  const externalResource = `facebook:page:${env.FB_PAGE_ID || 'unconfigured'}`;
  const lock = await acquireResourceLock(env, externalResource, task.id, ownerAgent);
  if (!lock.ok) {
    throw new Error(`resource_locked:${externalResource}:${lock.task_id}:${lock.owner_agent}`);
  }

  try {
    return await publishFacebook(env, action.message);
  } finally {
    await releaseResourceLock(env, externalResource, task.id);
  }
}

async function checkDependency(env, task) {
  if (!task.depends_on) return { ok: true, status: null };
  const dependency = await getTask(env, task.depends_on);
  if (!dependency) return { ok: false, status: 'missing' };
  return { ok: dependency.status === 'completed', status: dependency.status };
}

async function acquireResourceLock(env, resource, taskId, ownerAgent) {
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT OR IGNORE INTO resource_locks (resource, task_id, owner_agent, acquired_at)
     VALUES (?, ?, ?, ?)`
  ).bind(resource, taskId, ownerAgent, now).run();

  const lock = await env.DB.prepare(
    'SELECT task_id, owner_agent FROM resource_locks WHERE resource = ?'
  ).bind(resource).first();

  if (lock?.task_id === taskId) return { ok: true, task_id: taskId, owner_agent: ownerAgent };

  return {
    ok: false,
    task_id: lock?.task_id || null,
    owner_agent: lock?.owner_agent || null
  };
}

async function releaseResourceLock(env, resource, taskId) {
  await env.DB.prepare(
    'DELETE FROM resource_locks WHERE resource = ? AND task_id = ?'
  ).bind(resource, taskId).run();
}

async function publishFacebook(env, message) {
  if (!env.FB_PAGE_ID || !env.FB_PAGE_ACCESS_TOKEN) {
    throw new Error('Facebook Page credentials are not configured');
  }

  const version = env.META_GRAPH_VERSION || 'v26.0';
  const url = `https://graph.facebook.com/${version}/${encodeURIComponent(env.FB_PAGE_ID)}/feed`;
  const body = new URLSearchParams({ message, access_token: env.FB_PAGE_ACCESS_TOKEN });

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body
  });

  const data = await response.json();
  if (!response.ok || data.error) {
    throw new Error(`Facebook publish failed: ${JSON.stringify(data.error || data)}`);
  }
  return data;
}

async function callAI(env, messages) {
  if (!env.AI_API_KEY) throw new Error('AI_API_KEY is not configured');
  if (!env.AI_MODEL) throw new Error('AI_MODEL is not configured');

  const base = (env.AI_BASE_URL || 'https://api.apivn.tech/v1').replace(/\/$/, '');
  const response = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.AI_API_KEY}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({ model: env.AI_MODEL, messages, temperature: 0.2 })
  });

  const data = await response.json();
  if (!response.ok) throw new Error(`AI request failed: ${JSON.stringify(data)}`);

  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) throw new Error('AI returned no text content');
  return content;
}

function parseAIJson(text) {
  const cleaned = String(text).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(cleaned.slice(start, end + 1));
    throw new Error('AI returned invalid JSON');
  }
}

function normalizeAction(action) {
  if (!action || typeof action !== 'object' || action.type !== 'facebook_page_post') return null;
  const message = String(action.message || '').trim();
  return message ? { type: 'facebook_page_post', message } : null;
}

function normalizeResource(value) {
  if (value === null || value === undefined) return null;
  const resource = String(value).trim().toLowerCase().replace(/\s+/g, '-');
  if (!resource) return null;
  return resource.slice(0, 200);
}

function normalizeId(value) {
  if (value === null || value === undefined) return null;
  const id = String(value).trim();
  return id || null;
}

async function getTask(env, id) {
  return env.DB.prepare('SELECT * FROM tasks WHERE id = ?').bind(id).first();
}

async function setStatus(env, id, status) {
  await env.DB.prepare('UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?')
    .bind(status, new Date().toISOString(), id)
    .run();
}

function formatTask(task) {
  return {
    id: task.id,
    goal: task.goal,
    agent: task.agent,
    owner_agent: task.owner_agent || task.agent || null,
    resource: task.resource || null,
    depends_on: task.depends_on || null,
    approval_required: Number(task.approval_required ?? 1) !== 0,
    plan: safeJson(task.plan_json),
    result: safeJson(task.result_json),
    status: task.status,
    created_at: task.created_at,
    updated_at: task.updated_at
  };
}

function safeJson(value) {
  if (!value) return null;
  try { return JSON.parse(value); } catch { return null; }
}

async function readJson(request) {
  try { return await request.json(); } catch { return {}; }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' }
  });
}
