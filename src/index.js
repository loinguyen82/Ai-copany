import { handleContentRequest } from './content.js';

const AGENTS = {
  research: 'Find and verify information. Separate facts from assumptions. Return concise evidence-backed findings.',
  product: 'Turn goals into the smallest useful product or code change. Prefer patching and KISS/YAGNI.',
  marketing: 'Create practical marketing output tied to a measurable goal. Avoid spam and deceptive claims.',
  operations: 'Handle repeatable operations safely. Flag actions that change external systems or spend money.'
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

        const id = crypto.randomUUID();
        const now = new Date().toISOString();
        await env.DB.prepare(
          'INSERT INTO tasks (id, goal, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
        ).bind(id, goal, 'queued', now, now).run();

        return json({ id, goal, status: 'queued' }, 201);
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
  if (!['queued', 'failed'].includes(task.status)) {
    return json({ error: `task cannot run from status ${task.status}` }, 409);
  }

  await setStatus(env, id, 'running');

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
          'You are the manager of a tiny AI company. Route the goal to exactly one specialist: research, product, marketing, or operations. Do not invent extra agents. Output JSON only: {"agent":"...","instructions":"..."}.'
      },
      {
        role: 'user',
        content: `Company memory:\n${memoryText || '(empty)'}\n\nGoal:\n${task.goal}`
      }
    ]);

    const plan = parseAIJson(manager);
    const agent = AGENTS[plan.agent] ? plan.agent : 'operations';
    const instructions = String(plan.instructions || task.goal);

    const worker = await callAI(env, [
      {
        role: 'system',
        content:
          `${AGENTS[agent]} You are the ${agent} specialist. ` +
          'Output JSON only with this shape: {"summary":"...","memory":"...","action":null} or {"summary":"...","memory":"...","action":{"type":"facebook_page_post","message":"..."}}. ' +
          'Only request facebook_page_post when publishing a Page post is genuinely part of the goal.'
      },
      {
        role: 'user',
        content: `Manager instructions:\n${instructions}\n\nOriginal goal:\n${task.goal}`
      }
    ]);

    const result = parseAIJson(worker);
    const action = normalizeAction(result.action);
    let status = action ? 'awaiting_approval' : 'completed';
    let externalResult = null;

    if (action?.type === 'facebook_page_post' && env.AUTO_PUBLISH_FACEBOOK === 'true') {
      externalResult = await publishFacebook(env, action.message);
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
      'UPDATE tasks SET agent = ?, plan_json = ?, result_json = ?, status = ?, updated_at = ? WHERE id = ?'
    ).bind(agent, JSON.stringify(plan), JSON.stringify(storedResult), status, now, id).run();

    if (storedResult.memory) {
      await env.DB.prepare(
        'INSERT INTO memories (kind, content, created_at) VALUES (?, ?, ?)'
      ).bind(agent, storedResult.memory, now).run();
    }

    return json({ id, agent, status, result: storedResult });
  } catch (error) {
    await setStatus(env, id, 'failed');
    throw error;
  }
}

async function approveTask(env, id) {
  const task = await getTask(env, id);
  if (!task) return json({ error: 'task not found' }, 404);
  if (task.status !== 'awaiting_approval') {
    return json({ error: `task is not awaiting approval (${task.status})` }, 409);
  }

  const result = safeJson(task.result_json) || {};
  const action = normalizeAction(result.action);
  if (!action) return json({ error: 'task has no approvable action' }, 409);

  let externalResult;
  if (action.type === 'facebook_page_post') {
    externalResult = await publishFacebook(env, action.message);
  } else {
    return json({ error: 'unsupported action type' }, 400);
  }

  result.external_result = externalResult;
  const now = new Date().toISOString();
  await env.DB.prepare(
    'UPDATE tasks SET result_json = ?, status = ?, updated_at = ? WHERE id = ?'
  ).bind(JSON.stringify(result), 'completed', now, id).run();

  return json({ id, status: 'completed', result });
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
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
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
