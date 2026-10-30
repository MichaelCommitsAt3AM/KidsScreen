import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as tick } from 'node:timers/promises';
import { Tmdb } from '../src/tmdb.js';
import { enrichment } from '../src/enrichment.js';
import { ConfigStore } from '../src/store.js';
import { NuvioAuthorization, ProxyAuthorizationError } from '../src/nuvio-auth.js';

const config = { apiKey: 'synthetic-personal-test-key', maxRating: 'PG' as const, language: 'en', managementHash: '' };
function deferred<T = void>() { let resolve!: (value: T | PromiseLike<T>) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function movie() { return { id: 1, title: 'Example', adult: false, genres: [{ id: 16 }], release_dates: { results: [{ iso_3166_1: 'US', release_dates: [{ certification: 'PG' }] }] }, external_ids: { imdb_id: 'tt1000001' }, images: { logos: [{ file_path: '/en.png', iso_639_1: 'en' }] } }; }

test('catalog/bulk traffic reserves capacity for enrichment and keeps the total concurrency bounded', async () => {
  const release = deferred();
  const started: string[] = [];
  let active = 0, background = 0, maxActive = 0, maxBackground = 0, released = false;
  const tmdb = new Tmdb((async (input: URL) => {
    const endpoint = input.pathname;
    started.push(endpoint);
    const bulk = endpoint.includes('/bulk/');
    active++; if (bulk) background++;
    maxActive = Math.max(maxActive, active); maxBackground = Math.max(maxBackground, background);
    if (bulk && !released) await release.promise;
    active--; if (bulk) background--;
    return Response.json({ endpoint });
  }) as typeof fetch);
  const bulk = Array.from({ length: 12 }, (_, i) => tmdb.get(config, `bulk/${i}`, {}, 'background'));
  await tick();
  assert.equal(started.length, 4);
  await tmdb.get(config, 'movie/1');
  assert.equal(started[4], '/3/movie/1', 'interactive details start before the queued catalog work');
  assert.ok(maxActive <= 5);
  assert.ok(maxBackground <= 4);
  released = true; release.resolve(); await Promise.all(bulk);
});

test('an interactive caller promotes an identical queued catalog request rather than downloading it twice', async () => {
  const release = deferred(); const started: string[] = [];
  const tmdb = new Tmdb((async (input: URL) => {
    started.push(input.pathname);
    if (input.pathname.includes('/block/')) await release.promise;
    return Response.json({ id: 1 });
  }) as typeof fetch);
  const blockers = Array.from({ length: 4 }, (_, i) => tmdb.get(config, `block/${i}`, {}, 'background'));
  await tick();
  const queued = tmdb.get(config, 'movie/1', {}, 'background');
  const foreground = tmdb.get(config, 'movie/1');
  await foreground;
  assert.equal(started.filter(path => path === '/3/movie/1').length, 1);
  release.resolve(); await Promise.all([...blockers, queued]);
});

test('failed requests release their slots and remain retryable', async () => {
  let first = true;
  const tmdb = new Tmdb((async () => { if (first) { first = false; throw new Error('offline'); } return Response.json({ ok: true }); }) as typeof fetch);
  await assert.rejects(tmdb.get(config, 'movie/1'));
  assert.equal((await tmdb.get(config, 'movie/1')).ok, true);
  await Promise.all(Array.from({ length: 20 }, (_, i) => tmdb.get(config, `movie/${i + 2}`, {}, 'background')));
});

test('a core/artwork/certification/IDs enrichment burst reuses one verified TMDB bundle', async t => {
  const calls: URL[] = [];
  const tmdb = new Tmdb((async (input: URL) => { calls.push(input); return Response.json(movie()); }) as typeof fetch);
  const core = await enrichment(tmdb, config, 'movie/1', { language: 'en' });
  assert.equal(core.title, 'Example'); assert.equal(core.images, undefined);
  const images = await enrichment(tmdb, config, 'movie/1/images', { include_image_language: 'en,null' });
  assert.equal(images.logos[0].file_path, '/en.png');
  assert.ok((await enrichment(tmdb, config, 'movie/1/release_dates', {})).results.length);
  assert.equal((await enrichment(tmdb, config, 'movie/1/external_ids', {})).imdb_id, 'tt1000001');
  assert.equal(calls.length, 1);
  t.diagnostic('Cold core + images + release_dates + external_ids: 1 upstream request; previous flow required 5.');
  assert.equal(await enrichment(tmdb, { ...config, maxRating: 'G' }, 'movie/1', {}), null, 'a cached bundle never bypasses another configuration’s stricter policy');
});

test('different image queries and languages do not reuse an incompatible bundled image response', async () => {
  const calls: URL[] = [];
  const tmdb = new Tmdb((async (input: URL) => {
    calls.push(input);
    return Response.json(input.pathname.endsWith('/images') ? { logos: [{ file_path: '/fr.png' }] } : movie());
  }) as typeof fetch);
  const images = await enrichment(tmdb, config, 'movie/1/images', { language: 'fr', include_image_language: 'fr,en,null' });
  assert.equal(images.logos[0].file_path, '/fr.png');
  assert.equal(calls.length, 2);
  assert.equal(calls[1]!.searchParams.get('language'), 'fr');
});

test('equivalent query ordering shares a cache entry without sharing credentials', async () => {
  let calls = 0;
  const tmdb = new Tmdb((async () => { calls++; return Response.json({ ok: true }); }) as typeof fetch);
  await Promise.all([tmdb.get(config, 'movie/1', { page: '1', language: 'fr' }), tmdb.get(config, 'movie/1', { language: 'fr', page: '1' })]);
  assert.equal(calls, 1);
  await tmdb.get({ ...config, apiKey: 'another-test-key' }, 'movie/1', { page: '1', language: 'fr' });
  assert.equal(calls, 2);
});

test('concurrent configuration reads share storage work but never cache a revoked configuration', async () => {
  const records = new Map<string, string>(); let reads = 0;
  const gate = deferred(); let block = true;
  const store = ConfigStore.redis('https://redis.example', 'test-token', Buffer.alloc(32, 7).toString('base64'), (async (_url, init) => {
    const [operation, key, value] = JSON.parse(init!.body as string) as string[];
    if (operation === 'SET') { records.set(key!, value!); return Response.json({ result: 'OK' }); }
    if (operation === 'DEL') return Response.json({ result: records.delete(key!) ? 1 : 0 });
    reads++; if (block) await gate.promise;
    return Response.json({ result: records.get(key!) ?? null });
  }) as typeof fetch);
  const saved = await store.create(config);
  const burst = Array.from({ length: 8 }, () => store.get(saved.id));
  await tick(); assert.equal(reads, 1);
  block = false; gate.resolve();
  const results = await Promise.all(burst);
  results[0]!.apiKey = 'changed by caller';
  assert.equal(results[1]!.apiKey, config.apiKey);
  await store.remove(saved.id, saved.managementToken);
  await assert.rejects(store.get(saved.id));
});

test('user and owner-profile authorization run concurrently without extending the authorization cache', async () => {
  const user = deferred<Response>(); let profileStarted = false;
  const id = 'c'.repeat(43);
  const auth = new NuvioAuthorization({ KIDSSCREEN_NUVIO_SUPABASE_URL: 'https://auth.example', KIDSSCREEN_NUVIO_PUBLISHABLE_KEY: 'test-key' }, (async (input: URL) => {
    if (input.pathname === '/auth/v1/user') return user.promise;
    profileStarted = true;
    return Response.json([{ kids_enabled: true, kids_config_id: id }]);
  }) as typeof fetch);
  const pending = auth.requireConfiguration(`Bearer ${'a'.repeat(40)}`, id);
  await tick(); assert.equal(profileStarted, true, 'the profile lookup does not wait for the auth round trip');
  user.resolve(Response.json({ id: 'owner' }));
  assert.equal(await pending, 'owner');
});

test('invalid authentication aborts the parallel profile lookup without waiting for it', async () => {
  let aborted = false;
  const auth = new NuvioAuthorization({ KIDSSCREEN_NUVIO_SUPABASE_URL: 'https://auth.example', KIDSSCREEN_NUVIO_PUBLISHABLE_KEY: 'test-key' }, (async (input: URL, init: RequestInit) => {
    if (input.pathname === '/auth/v1/user') return new Response('{}', { status: 401 });
    return new Promise<Response>((_resolve, reject) => {
      init.signal!.addEventListener('abort', () => { aborted = true; reject(new Error('cancelled')); }, { once: true });
    });
  }) as typeof fetch);
  await assert.rejects(auth.requireConfiguration(`Bearer ${'a'.repeat(40)}`, 'c'.repeat(43)), error => error instanceof ProxyAuthorizationError && error.status === 401);
  assert.equal(aborted, true);
});
