import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import serve from '../api/index.mjs';
import { ConfigStore, deploymentStore } from '../dist/store.js';
import { createHandler } from '../dist/server.js';

test('Vercel routes retain encrypted configs across instances, accept parsed bodies, and revoke durably', async () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = { ...process.env };
  const records = new Map();
  const apiKey = 'test-key-never-store-in-plaintext';
  let failRedis = false;
  globalThis.fetch = async (input, init) => {
    const url = new URL(input);
    if (url.hostname === 'redis.example') {
      assert.equal(init.headers.Authorization, 'Bearer private-redis-token');
      if (failRedis) return new Response('{}', { status: 503 });
      const [command, name, value, flag] = JSON.parse(init.body);
      let result;
      if (command === 'SET') { assert.equal(flag, 'NX'); result = records.has(name) ? null : 'OK'; if (result) records.set(name, value); }
      else if (command === 'GET') result = records.get(name) ?? null;
      else if (command === 'DEL') result = records.delete(name) ? 1 : 0;
      else throw new Error('Unexpected Redis command');
      return Response.json({ result });
    }
    if (url.hostname === 'api.themoviedb.org') {
      assert.equal(url.searchParams.get('api_key'), apiKey);
      if (url.pathname.endsWith('/authentication')) return Response.json({ success: true });
      return Response.json({ id: 1, adult: false, release_dates: { results: [{ iso_3166_1: 'US', release_dates: [{ certification: 'R' }] }] } });
    }
    return originalFetch(input, init);
  };
  const app = createServer(serve);
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.address().port}`;
  const post = (route, data) => originalFetch(base + route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) });
  try {
    process.env.VERCEL = '1';
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    assert.throws(() => deploymentStore());
    assert.equal((await originalFetch(base + '/health')).status, 503);
    process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'private-redis-token';
    process.env.KIDSSCREEN_ENCRYPTION_KEY = randomBytes(32).toString('base64');
    assert.equal((await originalFetch(base + '/health')).status, 200);
    assert.equal((await originalFetch(base + '/')).status, 200);
    const created = await post('/v1/configurations', { apiKey, maxRating: 'PG' });
    assert.equal(created.status, 201);
    const config = await created.json();
    assert.equal(JSON.stringify([...records.values()]).includes(apiKey), false);
    assert.equal(JSON.stringify([...records.values()]).includes(config.managementToken), false);
    const independentInstance = await deploymentStore();
    assert.equal((await independentInstance.get(config.id)).apiKey, apiKey);
    assert.equal((await originalFetch(base + config.manifestPath)).status, 200);
    const verdict = await (await post(`/${config.id}/check`, { items: [{ type: 'movie', id: 'tmdb:1' }] })).json();
    assert.equal(verdict.items[0].allowed, false);
    // Vercel's optional Node helper may have already consumed and parsed the stream.
    let result;
    const response = { writeHead(status) { this.status = status; }, end(value) { result = { status: this.status, value: JSON.parse(value) }; } };
    await createHandler(independentInstance)({ method: 'POST', url: '/v1/configurations', socket: { remoteAddress: 'test' }, body: { apiKey, maxRating: 'G' } }, response);
    assert.equal(result.status, 201);
    failRedis = true;
    await assert.rejects(() => independentInstance.get(config.id));
    failRedis = false;
    const revoked = await originalFetch(`${base}/v1/configurations/${config.id}`, { method: 'DELETE', headers: { authorization: `Bearer ${config.managementToken}` } });
    assert.equal(revoked.status, 200);
    assert.equal((await originalFetch(base + config.manifestPath)).status, 404);
    await assert.rejects(() => independentInstance.get(config.id));
    assert.throws(() => ConfigStore.redis('http://redis.example', 'token', process.env.KIDSSCREEN_ENCRYPTION_KEY));
  } finally {
    globalThis.fetch = originalFetch;
    for (const name of Object.keys(process.env)) if (!(name in originalEnv)) delete process.env[name];
    Object.assign(process.env, originalEnv);
    await new Promise(resolve => app.close(resolve));
  }
});
