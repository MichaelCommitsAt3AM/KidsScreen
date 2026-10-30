import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ConfigStore } from '../src/store.js';
import { Tmdb } from '../src/tmdb.js';
import { createApp } from '../src/server.js';
import { NuvioAuthorization } from '../src/nuvio-auth.js';
import { validateEnrichmentRequest } from '../src/enrichment.js';

const apiKey = 'server-only-secret-key-never-returned';
const env = {
  KIDSSCREEN_NUVIO_SUPABASE_URL: 'https://project.supabase.co',
  KIDSSCREEN_NUVIO_PUBLISHABLE_KEY: 'sb_publishable_public_key',
} as NodeJS.ProcessEnv;

function movie(id: number, certification: string) {
  return {
    id, title: `Movie ${id}`, imdb_id: `tt10000${id}`, adult: false,
    genres: [{ id: 16, name: 'Animation' }],
    poster_path: '/poster.jpg', backdrop_path: '/backdrop.jpg',
    release_dates: { results: [{ iso_3166_1: 'US', release_dates: [{ certification }] }] },
  };
}

function tmdbFixture(options: { fail?: boolean } = {}) {
  const calls: URL[] = [];
  const fetch = (async (url: URL) => {
    calls.push(url);
    if (options.fail) throw new Error(`upstream failed for ${apiKey}`);
    assert.equal(url.searchParams.get('api_key'), apiKey);
    const endpoint = url.pathname.replace('/3/', '');
    let data: unknown;
    if (endpoint === 'movie/1') data = movie(1, 'G');
    else if (endpoint === 'movie/2') data = movie(2, 'R');
    else if (endpoint === 'tv/4') data = { id: 4, name: 'Show', genres: [{ id: 16, name: 'Animation' }], content_ratings: { results: [{ iso_3166_1: 'US', rating: 'TV-Y' }] } };
    else if (endpoint === 'movie/1/recommendations' || endpoint === 'movie/1/similar') data = { results: [{ id: 1 }, { id: 2 }] };
    else if (endpoint === 'movie/1/videos') data = { results: [{ id: 'v1', key: 'abc', name: 'Trailer', site: 'YouTube', type: 'Trailer' }] };
    else if (endpoint === 'movie/1/images') data = { backdrops: [{ file_path: '/backdrop.jpg', iso_639_1: null }] };
    else if (endpoint === 'movie/1/credits') data = { cast: [{ id: 9, name: 'Actor' }], crew: [] };
    else if (endpoint === 'find/tt100001') data = { movie_results: [{ id: 1 }, { id: 2 }], tv_results: [{ id: 5 }], person_results: [{ id: 9 }] };
    else if (endpoint === 'person/9/combined_credits') data = {
      cast: [{ id: 1, media_type: 'movie' }, { id: 2, media_type: 'movie' }, { id: 4, media_type: 'tv' }, { id: 6 }],
      crew: [{ id: 2, media_type: 'movie' }, { id: 7 }],
    };
    else if (endpoint === 'discover/movie') data = { page: 1, results: [{ id: 1 }, { id: 2 }] };
    else if (endpoint === 'discover/tv') data = { page: 1, results: [{ id: 4 }, { id: 8 }] };
    else if (endpoint === 'collection/70') data = { id: 70, name: 'Saga', parts: [{ id: 1 }, { id: 2 }] };
    else if (endpoint === 'tv/4/content_ratings') data = { results: [{ iso_3166_1: 'US', rating: 'TV-Y' }] };
    else throw new Error(`Unexpected fixture endpoint ${endpoint}`);
    return new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

type AuthOptions = {
  rows?: unknown;
  user?: unknown;
  authStatus?: number;
  profileStatus?: number;
};

function makeAuthorization(configId: string, options: AuthOptions = {}) {
  const calls: URL[] = [];
  const rows = options.rows ?? [{ user_id: 'user-1', profile_index: 2, kids_enabled: true, kids_config_id: configId }];
  const fetch = (async (url: URL) => {
    calls.push(url);
    if (url.pathname === '/auth/v1/user') {
      if (options.authStatus) return new Response('{}', { status: options.authStatus });
      return new Response(JSON.stringify(options.user ?? { id: 'user-1' }), { status: 200 });
    }
    if (url.pathname === '/rest/v1/rpc/sync_pull_profiles') {
      if (options.profileStatus) return new Response('{}', { status: options.profileStatus });
      return new Response(JSON.stringify(rows), { status: 200 });
    }
    throw new Error(`Unexpected auth endpoint ${url.pathname}`);
  }) as typeof globalThis.fetch;
  return { authorization: new NuvioAuthorization(env, fetch), calls };
}

async function withServer(
  fixture: ReturnType<typeof tmdbFixture>,
  makeAuthorizationFor: (configId: string) => NuvioAuthorization,
  run: (base: string, configId: string) => Promise<void>,
) {
  const directory = await mkdtemp(path.join(tmpdir(), 'kidsscreen-enrichment-'));
  const store = await ConfigStore.open(directory);
  const config = await store.create({ apiKey, maxRating: 'PG', language: 'en-US' });
  const app = createApp(store, new Tmdb(fixture.fetch), makeAuthorizationFor(config.id));
  await new Promise<void>(resolve => app.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(app.address() as { port: number }).port}`;
  try { await run(base, config.id); }
  finally { await new Promise<void>(resolve => app.close(() => resolve())); await rm(directory, { recursive: true, force: true }); }
}

const enrich = (base: string, id: string, token: string | null, body: unknown) => fetch(`${base}/v1/configurations/${id}/tmdb`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  body: JSON.stringify(body),
});
const validToken = 'a'.repeat(40);

test('a Nuvio owner can edit ratings on a second device without receiving the saved TMDB key', async () => {
  await withServer(tmdbFixture(), id => makeAuthorization(id).authorization, async (base, id) => {
    const response = await fetch(`${base}/v1/configurations/${id}/clone-owned`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${validToken}` },
      body: JSON.stringify({ maxRating: 'G' }),
    });
    assert.equal(response.status, 201);
    const text = await response.text(), replacement = JSON.parse(text);
    assert.equal(text.includes(apiKey), false);
    assert.notEqual(replacement.id, id);
    assert.match(replacement.managementToken, /^[A-Za-z0-9_-]{43}$/);
    const manifest = await (await fetch(`${base}${replacement.manifestPath}`)).json() as any;
    assert.equal(manifest.name, 'KidsScreen · G');
    const meta = await (await fetch(`${base}/${replacement.id}/meta/movie/tmdb:1.json`)).json() as any;
    assert.equal(meta.meta.name, 'Movie 1', 'the saved key still works in the replacement configuration');
    assert.equal((await (await fetch(`${base}/${id}/manifest.json`)).json() as any).name, 'KidsScreen · PG', 'original stays valid until the profile edit commits');
  });
});

test('owner-authorized rating edits reject missing, expired, unrelated and disabled sessions', async () => {
  const scenarios = [
    { token: null, options: {}, status: 401 },
    { token: validToken, options: { authStatus: 401 }, status: 401 },
    { token: validToken, options: { rows: [] }, status: 403 },
    { token: validToken, options: { rows: [{ kids_enabled: false, kids_config_id: 'REQUESTED' }] }, status: 403 },
    { token: validToken, options: { profileStatus: 503 }, status: 503 },
  ];
  for (const scenario of scenarios) {
    await withServer(tmdbFixture(), id => makeAuthorization(id, {
      ...scenario.options,
      ...(scenario.options.rows ? { rows: scenario.options.rows.map(row => ({ ...row, kids_config_id: id })) } : {}),
    }).authorization, async (base, id) => {
      const response = await fetch(`${base}/v1/configurations/${id}/clone-owned`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...(scenario.token ? { Authorization: `Bearer ${scenario.token}` } : {}) },
        body: JSON.stringify({ maxRating: 'G' }),
      });
      assert.equal(response.status, scenario.status);
      assert.equal((await response.text()).includes(apiKey), false);
    });
  }
});

test('enrichment requires a Nuvio session and configured authentication', async () => {
  const tmdb = tmdbFixture();
  await withServer(tmdb, configId => makeAuthorization(configId).authorization, async (base, id) => {
    assert.equal((await enrich(base, id, null, { endpoint: 'movie/1' })).status, 401);
    assert.equal((await enrich(base, id, 'short', { endpoint: 'movie/1' })).status, 401);
    const wrongScheme = await fetch(`${base}/v1/configurations/${id}/tmdb`, { method: 'POST', body: '{"endpoint":"movie/1"}' });
    assert.equal(wrongScheme.status, 401);
  });
  assert.equal(tmdb.calls.length, 0, 'unauthenticated calls never reach TMDB');

  const expired = makeAuthorization('unused', { authStatus: 401 });
  await withServer(tmdb, () => expired.authorization, async (base, id) => {
    assert.equal((await enrich(base, id, validToken, { endpoint: 'movie/1' })).status, 401);
  });

  const unavailable = makeAuthorization('unused', { profileStatus: 503 });
  await withServer(tmdb, () => unavailable.authorization, async (base, id) => {
    assert.equal((await enrich(base, id, validToken, { endpoint: 'movie/1' })).status, 503);
  });

  const anonymous = makeAuthorization('unused', { user: { id: 'user-1', is_anonymous: true } });
  await withServer(tmdb, () => anonymous.authorization, async (base, id) => {
    assert.equal((await enrich(base, id, validToken, { endpoint: 'movie/1' })).status, 401);
  });

  await withServer(tmdb, () => new NuvioAuthorization({} as NodeJS.ProcessEnv, (async () => { throw new Error('must not be called'); }) as typeof fetch), async (base, id) => {
    assert.equal((await enrich(base, id, validToken, { endpoint: 'movie/1' })).status, 503, 'missing deployment config is a server error');
  });
  assert.equal(tmdb.calls.length, 0);
});

test('enrichment rejects a mismatched account, disabled profile or other configuration', async () => {
  const tmdb = tmdbFixture();
  const scenarios: Array<unknown> = [
    [],
    [{ kids_enabled: false, kids_config_id: 'REQUESTED' }],
    [{ kids_enabled: true, kids_config_id: 'another-config' }],
    [{ kids_enabled: 'true', kids_config_id: 'REQUESTED' }],
    { profiles: [] },
  ];
  for (const rows of scenarios) {
    await withServer(tmdb, configId => {
      const materialized = structuredClone(rows) as any;
      if (Array.isArray(materialized)) for (const row of materialized) {
        if (row?.kids_config_id === 'REQUESTED') row.kids_config_id = configId;
      }
      return makeAuthorization(configId, { rows: materialized }).authorization;
    }, async (base, id) => {
      assert.equal((await enrich(base, id, validToken, { endpoint: 'movie/1' })).status, 403, JSON.stringify(rows));
    });
  }
  assert.equal(tmdb.calls.length, 0);
});

test('an authorized new device uses the server-held key without receiving it', async () => {
  const tmdb = tmdbFixture();
  let authCalls: URL[] = [];
  await withServer(tmdb, configId => {
    const fixture = makeAuthorization(configId);
    authCalls = fixture.calls;
    return fixture.authorization;
  }, async (base, id) => {
    const response = await enrich(base, id, validToken, { endpoint: 'movie/1', query: { language: 'en-US' } });
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.equal(text.includes(apiKey), false);
    assert.equal(text.includes('api_key'), false);
    assert.equal(JSON.parse(text).title, 'Movie 1');
  });
  assert.ok(authCalls.some(call => call.pathname === '/rest/v1/rpc/sync_pull_profiles'));
});

test('enrichment filters every media list but keeps videos, credits and ratings intact', async () => {
  const tmdb = tmdbFixture();
  await withServer(tmdb, configId => makeAuthorization(configId).authorization, async (base, id) => {
    const body = async (endpoint: string) => (await enrich(base, id, validToken, { endpoint })).json() as Promise<any>;

    assert.deepEqual((await body('movie/1/recommendations')).results.map((item: any) => item.id), [1]);
    assert.deepEqual((await body('movie/1/similar')).results.map((item: any) => item.id), [1]);
    assert.deepEqual((await body('collection/70')).parts.map((item: any) => item.id), [1]);
    const found = await body('find/tt100001');
    assert.deepEqual(found.movie_results.map((item: any) => item.id), [1]);
    assert.deepEqual(found.tv_results, []);
    assert.equal(found.person_results, undefined);
    const credits = await body('person/9/combined_credits');
    // Missing media_type is dropped instead of guessing a type that could
    // evaluate a disallowed title against an allowed one with the same id.
    assert.deepEqual(credits.cast.map((item: any) => item.id), [1, 4]);
    assert.deepEqual(credits.crew, []);
    assert.equal((await body('movie/1/videos')).results.length, 1, 'videos are not a media list');
    assert.equal((await body('movie/1/images')).backdrops.length, 1, 'images are not a media list');
    assert.equal((await body('movie/1/credits')).cast.length, 1, 'credits are people, not titles');
    assert.equal((await body('tv/4/content_ratings')).results.length, 1, 'ratings are not a media list');
  });
});

test('enrichment denies disallowed titles and supports discover/entity pages', async () => {
  const tmdb = tmdbFixture();
  await withServer(tmdb, configId => makeAuthorization(configId).authorization, async (base, id) => {
    assert.equal((await enrich(base, id, validToken, { endpoint: 'movie/2' })).status, 404);
    assert.equal((await enrich(base, id, validToken, { endpoint: 'tv/4' })).status, 200);
    const discover = await (await enrich(base, id, validToken, { endpoint: 'discover/movie', query: { sort_by: 'popularity.desc', page: '1' } })).json() as any;
    assert.deepEqual(discover.results.map((item: any) => item.id), [1]);
    const companies = await (await enrich(base, id, validToken, { endpoint: 'discover/tv', query: { with_companies: '420', sort_by: 'vote_average.desc' } })).json() as any;
    assert.deepEqual(companies.results.map((item: any) => item.id), [4]);
  });
});

test('endpoint and query abuse is rejected before TMDB is called', async () => {
  const tmdb = tmdbFixture();
  await withServer(tmdb, configId => makeAuthorization(configId).authorization, async (base, id) => {
    const abuse: unknown[] = [
      { endpoint: 'https://evil.example/movie/1' },
      { endpoint: '../movie/1' },
      { endpoint: 'movie/1/append_to_response' },
      { endpoint: 'movie/1', query: { api_key: 'stolen' } },
      { endpoint: 'movie/1', query: { append_to_response: 'credits' } },
      { endpoint: 'discover/movie', query: { sort_by: 'popularity.asc' } },
      { endpoint: 'discover/movie', query: { with_companies: 'abc OR 1' } },
      { endpoint: 'discover/movie', query: { page: '0' } },
      { endpoint: 'discover/movie', query: { page: '999' } },
      { endpoint: 'find/tt100001', query: { external_source: 'tvdb_id' } },
      { endpoint: 'movie/1', query: { language: 'en-US&api_key=x' } },
      { endpoint: 'search/movie', query: { query: 'anything' } },
      { endpoint: 'configuration' },
      { endpoint: 'movie/1/rate' },
      { endpoint: 'movie/1', query: { include_image_language: 'en,xx' } },
    ];
    for (const body of abuse) assert.equal((await enrich(base, id, validToken, body)).status, 400, JSON.stringify(body));
  });
  assert.equal(tmdb.calls.length, 0);
});

test('authorization is cached briefly per token and configuration with in-flight deduplication', async () => {
  const configId = 'x'.repeat(43);
  const fixture = makeAuthorization(configId);
  const results = await Promise.all(Array.from({ length: 8 }, () => fixture.authorization.requireConfiguration(`Bearer ${validToken}`, configId)));
  assert.deepEqual(new Set(results), new Set(['user-1']));
  assert.equal(fixture.calls.filter(call => call.pathname === '/auth/v1/user').length, 1);
  assert.equal(fixture.calls.filter(call => call.pathname === '/rest/v1/rpc/sync_pull_profiles').length, 1);
  // Same token, different configuration: a separate verification, never a reuse.
  await assert.rejects(() => fixture.authorization.requireConfiguration(`Bearer ${validToken}`, 'y'.repeat(43)));
  assert.equal(fixture.calls.filter(call => call.pathname === '/auth/v1/user').length, 2);
  // The original (authorized) pair is still cached.
  await fixture.authorization.requireConfiguration(`Bearer ${validToken}`, configId);
  assert.equal(fixture.calls.filter(call => call.pathname === '/auth/v1/user').length, 2);
});

test('validateEnrichmentRequest only ever adds a safe include_adult=false', () => {
  assert.deepEqual(validateEnrichmentRequest({ endpoint: 'discover/movie' }), { endpoint: 'discover/movie', query: { include_adult: 'false' } });
  assert.deepEqual(validateEnrichmentRequest({ endpoint: 'movie/1' }).query, {});
  assert.throws(() => validateEnrichmentRequest({ endpoint: 'movie/0' }));
  assert.throws(() => validateEnrichmentRequest({ endpoint: 'movie/1', query: ['language=en'] }));
  assert.equal(validateEnrichmentRequest({ endpoint: 'tv/44/season/2/videos' }).endpoint, 'tv/44/season/2/videos');
  assert.throws(() => validateEnrichmentRequest({ endpoint: 'tv/44/season/2/credits' }));
});
