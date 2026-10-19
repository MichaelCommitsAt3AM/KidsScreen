import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ConfigStore } from '../src/store.js';
import { Tmdb } from '../src/tmdb.js';
import { createApp } from '../src/server.js';
import { allowsRatings, allowsTitle, usRatings } from '../src/policy.js';

const apiKey = 'test-secret-api-key-do-not-log';
function movie(id: number, certifications: string[]) {
  return { id, title: `Movie ${id}`, imdb_id: `tt10000${id}`, adult: false, genres: [{ id: 16, name: 'Animation' }], poster_path: '/poster.jpg', backdrop_path: '/backdrop.jpg', release_dates: { results: [{ iso_3166_1: 'US', release_dates: certifications.map(certification => ({ certification })) }] } };
}
test('ratings deny missing, unknown, adult, and conflicting higher US classifications', () => {
  assert.equal(allowsRatings('movie', [], 'PG'), false);
  assert.equal(allowsRatings('movie', ['NR'], 'PG-13'), false);
  assert.equal(allowsRatings('movie', ['G', 'R'], 'PG'), false);
  assert.equal(allowsRatings('movie', ['PG'], 'G'), false);
  assert.equal(allowsRatings('movie', ['G', 'PG'], 'PG'), true);
  assert.equal(allowsRatings('series', ['TV-Y'], 'G'), true);
  assert.equal(allowsRatings('series', ['TV-Y7'], 'G'), false);
  assert.equal(allowsRatings('series', ['TV-14'], 'PG-13'), false);
  assert.deepEqual(usRatings('movie', { release_dates: { results: [{ iso_3166_1: 'GB', release_dates: [{ certification: 'G' }] }] } }), []);
});
test('configurations are encrypted, survive restart and require a management token to revoke', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kidsscreen-store-'));
  try {
    const store = await ConfigStore.open(directory);
    const config = await store.create({ apiKey, maxRating: 'PG', language: 'en-US' });
    const raw = await readFile(path.join(directory, `${config.id}.json`), 'utf8');
    assert.equal(raw.includes(apiKey), false); assert.equal(raw.includes(config.managementToken), false);
    const restarted = await ConfigStore.open(directory);
    assert.equal((await restarted.get(config.id)).apiKey, apiKey);
    await assert.rejects(() => restarted.remove(config.id, 'wrong'));
    await restarted.remove(config.id, config.managementToken);
    await assert.rejects(() => restarted.get(config.id));
    await assert.rejects(() => store.get('../master.key'));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('production requires an explicit encryption key', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kidsscreen-prod-'));
  try { await assert.rejects(() => ConfigStore.open(directory, undefined, true)); }
  finally { await rm(directory, { recursive: true, force: true }); }
});
test('HTTP configuration, manifests, search, metadata and Nuvio checks share the policy', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kidsscreen-http-'));
  let offline = false;
  const tmdb = new Tmdb((async (url: URL) => {
    assert.equal(url.origin, 'https://api.themoviedb.org');
    assert.equal(url.searchParams.get('api_key'), apiKey);
    if (offline) throw new Error(`secret ${apiKey}`);
    const endpoint = url.pathname;
    let data: unknown;
    if (endpoint.endsWith('/authentication')) data = { success: true };
    else if (endpoint.endsWith('/find/tt100001')) data = { movie_results: [{ id: 1 }] };
    else if (endpoint.endsWith('/discover/movie') || endpoint.endsWith('/search/movie')) data = { results: [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }] };
    else if (endpoint.endsWith('/movie/1')) data = movie(1, ['G']);
    else if (endpoint.endsWith('/movie/2')) data = movie(2, ['R']);
    else if (endpoint.endsWith('/movie/3')) data = movie(3, []);
    else if (endpoint.endsWith('/movie/4')) data = { ...movie(4, ['PG-13']), genres: [{ id: 16, name: 'Animation' }, { id: 27, name: 'Horreur' }] };
    else if (endpoint.endsWith('/movie/99')) throw new Error(`secret ${apiKey}`);
    else throw new Error('Unexpected fixture endpoint');
    return new Response(JSON.stringify(data), { status: 200 });
  }) as typeof fetch);
  const store = await ConfigStore.open(directory), app = createApp(store, tmdb);
  await new Promise<void>(resolve => app.listen(0, '127.0.0.1', resolve));
  const address = app.address() as { port: number }, base = `http://127.0.0.1:${address.port}`;
  const post = (route: string, value: unknown) => fetch(base + route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });
  try {
    assert.equal((await post('/v1/configurations', { apiKey, maxRating: 'R' })).status, 400);
    const response = await post('/v1/configurations', { apiKey, maxRating: 'PG-13' });
    assert.equal(response.status, 201); const config = await response.json() as any;
    assert.equal(JSON.stringify(config).includes(apiKey), false);
    const manifest = await (await fetch(base + config.manifestPath)).json() as any;
    assert.equal(manifest.name, 'KidsScreen · PG-13'); assert.equal(manifest.catalogs.length, 6);
    for (const route of [`/${config.id}/catalog/movie/kids-popular.json`, `/${config.id}/catalog/movie/kids-popular/search=test.json`]) {
      const catalog = await (await fetch(base + route)).json() as any;
      assert.deepEqual(catalog.metas.map((item: any) => item.id), ['tt100001']);
      assert.ok(catalog.metas[0].background);
    }
    const meta = await (await fetch(`${base}/${config.id}/meta/movie/tmdb:2.json`)).json() as any;
    assert.equal(meta.meta, null);
    const horrorMeta = await (await fetch(`${base}/${config.id}/meta/movie/tmdb:4.json`)).json() as any;
    assert.equal(horrorMeta.meta, null);
    const checked = await (await post(`/${config.id}/check`, { items: [{ type: 'movie', id: 'tt100001' }, { type: 'movie', id: 'tmdb:2' }, { type: 'movie', id: 'tmdb:99' }, { type: 'movie', id: 'tmdb:4' }] })).json() as any;
    assert.deepEqual(checked.items.map((item: any) => item.allowed), [true, false, false, false]);
    assert.equal(JSON.stringify(checked).includes(apiKey), false);
    offline = true;
    const failure = await fetch(`${base}/${config.id}/catalog/series/kids-popular.json`);
    assert.equal(failure.status, 503); assert.equal((await failure.text()).includes(apiKey), false);
    assert.equal((await fetch(`${base}/v1/configurations/${config.id}`, { method: 'DELETE' })).status, 403);
    assert.equal((await fetch(`${base}/v1/configurations/${config.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${config.managementToken}` } })).status, 200);
    assert.equal((await fetch(base + config.manifestPath)).status, 404);
  } finally { await new Promise<void>(resolve => app.close(() => resolve())); await rm(directory, { recursive: true, force: true }); }
});

test('pagination advances by eligible titles without repeating a sparse upstream page', async () => {
  const tmdb = new Tmdb((async (url: URL) => {
    const details = /\/movie\/(\d+)$/.exec(url.pathname);
    const page = Number(url.searchParams.get('page') || 1);
    const data = details ? movie(Number(details[1]), [Number(details[1]) % 2 ? 'R' : 'G'])
      : { total_pages: 3, results: Array.from({ length: page === 3 ? 10 : 20 }, (_, i) => ({ id: (page - 1) * 20 + i + 1 })) };
    return new Response(JSON.stringify(data));
  }) as typeof fetch);
  const config = { apiKey, maxRating: 'G' as const, language: 'en-US', managementHash: '' };
  const first = await tmdb.catalog(config, 'movie', 'popular', 0);
  const second = await tmdb.catalog(config, 'movie', 'popular', first.length);
  assert.equal(first.length, 20); assert.equal(second.length, 5);
  assert.equal(new Set([...first, ...second].map(item => item.id)).size, 25);
});

test('series metadata checks US ratings and exposes episode IDs while omitting specials', async () => {
  const tmdb = new Tmdb((async (url: URL) => { return new Response(JSON.stringify(url.pathname.endsWith('/season/1')
    ? { episodes: [{ name: 'Episode one', season_number: 1, episode_number: 1, air_date: '2026-01-01' }] }
    : { id: 4, name: 'Family show', external_ids: { imdb_id: 'tt200004' }, content_ratings: { results: [{ iso_3166_1: 'US', rating: 'TV-PG' }] }, seasons: [{ season_number: 0 }, { season_number: 1 }] })); }) as typeof fetch);
  const config = { apiKey, maxRating: 'PG' as const, language: 'en-US', managementHash: '' };
  const result = await tmdb.meta(config, { type: 'series', id: 'tmdb:4' });
  assert.equal(result!.videos[0].id, 'tt200004:1:1');
  assert.equal(result!.videos.length, 1);
  assert.equal(await tmdb.meta({ ...config, maxRating: 'G' }, { type: 'series', id: 'tmdb:4' }), null);
});

test('horror veto overrides every age rating and uses genre IDs across languages and mixed genres', () => {
  for (const rating of ['G', 'PG', 'PG-13'] as const) {
    const horror = { ...movie(4, [rating]), genres: [{ id: 16, name: 'Animation' }, { id: 27, name: 'Horreur' }] };
    assert.equal(allowsTitle('movie', horror, 'PG-13'), false);
  }
  assert.equal(allowsTitle('movie', movie(1, ['PG-13']), 'PG-13'), true);
  assert.equal(allowsTitle('movie', { ...movie(1, ['PG']), genres: [] }, 'PG-13'), false);
  assert.equal(allowsTitle('movie', { ...movie(1, ['PG']), genres: undefined }, 'PG-13'), false);
});
