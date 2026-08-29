export async function handleContentRequest(request, env, helpers) {
  const { callAI, publishFacebook, json, readJson } = helpers;
  const url = new URL(request.url);
  const method = request.method.toUpperCase();

  if (method === 'GET' && url.pathname === '/content') {
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 20, 1), 100);
    const rows = await env.DB.prepare(
      'SELECT * FROM content_posts ORDER BY created_at DESC LIMIT ?'
    ).bind(limit).all();
    return json({ posts: (rows.results || []).map(formatPost) });
  }

  if (method === 'POST' && url.pathname === '/content/draft') {
    const body = await readJson(request);
    const topic = String(body.topic || '').trim();
    if (!topic) return json({ error: 'topic is required' }, 400);

    const audience = String(body.audience || '').trim();
    const objective = String(body.objective || '').trim();
    const notes = String(body.notes || '').trim();

    const recent = await env.DB.prepare(
      'SELECT id, message FROM content_posts ORDER BY created_at DESC LIMIT 20'
    ).all();
    const recentPosts = recent.results || [];
    const recentText = recentPosts.map((p, i) => `${i + 1}. ${p.message}`).join('\n\n');

    const raw = await callAI(env, [
      {
        role: 'system',
        content:
          'You are the marketing content specialist for a small company. Create one useful Facebook Page post. ' +
          'Do not invent current facts, prices, statistics, customer results, or news. Treat user notes as the only source for time-sensitive claims. ' +
          'Return JSON only: {"research":{"angle":"...","key_points":["..."],"uncertain_claims":["..."]},"message":"..."}. ' +
          'The post should be natural, concrete, non-spammy, and have a clear CTA only when appropriate.'
      },
      {
        role: 'user',
        content:
          `Topic: ${topic}\nAudience: ${audience || '(not specified)'}\nObjective: ${objective || '(not specified)'}\n` +
          `Source notes: ${notes || '(none)'}\n\nRecent posts to avoid repeating:\n${recentText || '(none)'}`
      }
    ]);

    const draft = parseAIJson(raw);
    let message = String(draft.message || '').trim();
    if (!message) return json({ error: 'AI returned an empty post' }, 502);

    const duplicate = findMostSimilar(message, recentPosts);
    const threshold = clamp(Number(env.CONTENT_DUPLICATE_THRESHOLD) || 0.72, 0.4, 0.95);

    if (duplicate && duplicate.score >= threshold) {
      const rewritten = await callAI(env, [
        {
          role: 'system',
          content:
            'Rewrite the new Facebook post so it is materially different in angle, structure, examples, opening and CTA while preserving its goal. ' +
            'Do not add unsupported current claims. Return JSON only: {"message":"..."}.'
        },
        {
          role: 'user',
          content: `New draft:\n${message}\n\nToo similar to this previous post:\n${duplicate.message}`
        }
      ]);
      const parsed = parseAIJson(rewritten);
      if (String(parsed.message || '').trim()) message = String(parsed.message).trim();
    }

    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const autoPublish = env.AUTO_PUBLISH_FACEBOOK === 'true';
    let status = autoPublish ? 'publishing' : 'awaiting_approval';
    let fbPostId = null;

    await env.DB.prepare(
      `INSERT INTO content_posts
       (id, topic, audience, objective, source_notes, research_json, message, status, fb_post_id, created_at, updated_at, published_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      id,
      topic,
      audience || null,
      objective || null,
      notes || null,
      JSON.stringify(draft.research || {}),
      message,
      status,
      null,
      now,
      now,
      null
    ).run();

    if (autoPublish) {
      try {
        const result = await publishFacebook(env, message);
        fbPostId = String(result?.id || '');
        status = 'published';
        const publishedAt = new Date().toISOString();
        await env.DB.prepare(
          'UPDATE content_posts SET status = ?, fb_post_id = ?, published_at = ?, updated_at = ? WHERE id = ?'
        ).bind(status, fbPostId, publishedAt, publishedAt, id).run();
      } catch (error) {
        await env.DB.prepare(
          'UPDATE content_posts SET status = ?, updated_at = ? WHERE id = ?'
        ).bind('publish_failed', new Date().toISOString(), id).run();
        throw error;
      }
    }

    return json({
      id,
      topic,
      research: draft.research || {},
      message,
      duplicate_check: duplicate ? { score: round(duplicate.score), compared_to: duplicate.id } : { score: 0, compared_to: null },
      status,
      fb_post_id: fbPostId
    }, 201);
  }

  const postMatch = url.pathname.match(/^\/content\/([^/]+)$/);
  if (method === 'GET' && postMatch) {
    const post = await getPost(env, postMatch[1]);
    return post ? json(formatPost(post)) : json({ error: 'content post not found' }, 404);
  }

  const approveMatch = url.pathname.match(/^\/content\/([^/]+)\/approve$/);
  if (method === 'POST' && approveMatch) {
    const post = await getPost(env, approveMatch[1]);
    if (!post) return json({ error: 'content post not found' }, 404);
    if (!['awaiting_approval', 'publish_failed'].includes(post.status)) {
      return json({ error: `post cannot be approved from status ${post.status}` }, 409);
    }

    const startedAt = new Date().toISOString();
    await env.DB.prepare(
      'UPDATE content_posts SET status = ?, updated_at = ? WHERE id = ?'
    ).bind('publishing', startedAt, post.id).run();

    try {
      const result = await publishFacebook(env, post.message);
      const now = new Date().toISOString();
      const fbPostId = String(result?.id || '');
      await env.DB.prepare(
        'UPDATE content_posts SET status = ?, fb_post_id = ?, published_at = ?, updated_at = ? WHERE id = ?'
      ).bind('published', fbPostId, now, now, post.id).run();
      return json({ id: post.id, status: 'published', fb_post_id: fbPostId });
    } catch (error) {
      await env.DB.prepare(
        'UPDATE content_posts SET status = ?, updated_at = ? WHERE id = ?'
      ).bind('publish_failed', new Date().toISOString(), post.id).run();
      throw error;
    }
  }

  return null;
}

async function getPost(env, id) {
  return env.DB.prepare('SELECT * FROM content_posts WHERE id = ?').bind(id).first();
}

function formatPost(post) {
  return {
    id: post.id,
    topic: post.topic,
    audience: post.audience,
    objective: post.objective,
    source_notes: post.source_notes,
    research: safeJson(post.research_json) || {},
    message: post.message,
    status: post.status,
    fb_post_id: post.fb_post_id,
    created_at: post.created_at,
    updated_at: post.updated_at,
    published_at: post.published_at
  };
}

function findMostSimilar(message, posts) {
  let best = null;
  for (const post of posts) {
    const score = jaccard(tokenSet(message), tokenSet(post.message || ''));
    if (!best || score > best.score) best = { id: post.id, message: post.message, score };
  }
  return best;
}

function tokenSet(text) {
  const tokens = String(text)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((x) => x.length > 2);
  return new Set(tokens);
}

function jaccard(a, b) {
  if (!a.size && !b.size) return 1;
  let intersection = 0;
  for (const value of a) if (b.has(value)) intersection += 1;
  const union = a.size + b.size - intersection;
  return union ? intersection / union : 0;
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

function safeJson(value) {
  if (!value) return null;
  try { return JSON.parse(value); } catch { return null; }
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function round(value) {
  return Math.round(value * 1000) / 1000;
}
