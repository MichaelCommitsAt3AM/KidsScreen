import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { pathToFileURL } from 'node:url';
import { ConfigStore, deploymentStore } from './store.js';
import { Tmdb, type MediaRef } from './tmdb.js';
import { CATALOG_KINDS, validRating, validTvRating, type CatalogKind, type Configuration, type MediaType } from './policy.js';
import { readFile } from 'node:fs/promises';
import { NuvioAuthorization, ProxyAuthorizationError } from './nuvio-auth.js';
import { enrichment, validateEnrichmentRequest } from './enrichment.js';

const manifest = (config: Configuration) => ({
  id: 'org.kidsscreen.catalogs', version: '0.1.1', name: `KidsScreen · ${config.maxRating}`, description: 'Rating-filtered movies and series. Requires a personal TMDB API key.',
  types: ['movie', 'series'], resources: ['catalog', { name: 'meta', types: ['movie', 'series'], idPrefixes: ['tt', 'tmdb:'] }],
  catalogs: (['movie', 'series'] as const).flatMap(type => CATALOG_KINDS.filter(kind => !config.catalogs || config.catalogs.includes(kind)).map(kind => ({ type, id: `kids-${kind}`, name: `Kids ${kind[0]!.toUpperCase()}${kind.slice(1)}`, extra: [{ name: 'skip' }, ...(kind === 'popular' ? [{ name: 'search' }] : [])] }))),
  behaviorHints: { configurable: true, configurationRequired: false },
});
type Settings = Pick<Configuration, 'maxRating' | 'language' | 'maxTvRating' | 'catalogs' | 'allowUnrated'>;
/** Validates user-editable settings; omitted optional fields fall back to `previous` (clones) or defaults. */
function settingsFrom(input: any, previous?: Configuration): Settings | string {
  if (!validRating(input.maxRating)) return previous ? 'Choose a supported maximum rating.' : 'Enter a valid TMDB API key and maximum rating.';
  const language = input.language ?? previous?.language ?? 'en-US';
  if (typeof language !== 'string' || !/^[a-z]{2}(?:-[A-Z]{2})?$/.test(language)) return 'Invalid language.';
  const settings: Settings = { maxRating: input.maxRating, language };
  const tv = input.maxTvRating ?? previous?.maxTvRating;
  if (tv !== undefined && tv !== '') { if (!validTvRating(tv)) return 'Choose a supported TV rating.'; settings.maxTvRating = tv; }
  const catalogs = input.catalogs ?? previous?.catalogs;
  if (catalogs !== undefined) {
    if (!Array.isArray(catalogs) || !catalogs.length || catalogs.some(kind => !CATALOG_KINDS.includes(kind))) return 'Choose at least one supported catalog.';
    settings.catalogs = CATALOG_KINDS.filter(kind => catalogs.includes(kind));
  }
  const unrated = input.allowUnrated ?? previous?.allowUnrated;
  if (unrated !== undefined) { if (typeof unrated !== 'boolean') return 'Invalid unrated setting.'; if (unrated) settings.allowUnrated = true; }
  return settings;
}
const publicFiles: Record<string, [string, string]> = {
  '/': ['index.html', 'text/html; charset=utf-8'], '/configure': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'], '/style.css': ['style.css', 'text/css; charset=utf-8'],
};
const pageCache = new Map<string, Buffer>();
async function publicFile(name: string) {
  // Cache in production (Vercel/Docker); read fresh in development so edits show on reload.
  let data = process.env.NODE_ENV === 'production' || process.env.VERCEL ? pageCache.get(name) : undefined;
  if (!data) { data = await readFile(new URL(`../public/${name}`, import.meta.url)); pageCache.set(name, data); }
  return data;
}
async function body(request: IncomingMessage): Promise<any> {
  // Vercel may provide an already-parsed body; the standalone server provides a stream.
  const parsed = (request as IncomingMessage & { body?: unknown }).body;
  if (parsed !== undefined) {
    const text = typeof parsed === 'string' ? parsed : Buffer.isBuffer(parsed) ? parsed.toString('utf8') : JSON.stringify(parsed);
    if (Buffer.byteLength(text) > 65536) throw new Error('Request is too large');
    return JSON.parse(text);
  }
  let text = ''; for await (const chunk of request) { text += chunk; if (Buffer.byteLength(text) > 65536) throw new Error('Request is too large'); }
  return JSON.parse(text || '{}');
}
const SHARED_CACHE = 'public, max-age=300, s-maxage=1800, stale-while-revalidate=3600';
export function createHandler(store: ConfigStore, tmdb = new Tmdb(), authorization = new NuvioAuthorization()) {
  const limits = new Map<string, { count: number; reset: number }>();
  return async (request: IncomingMessage, response: ServerResponse) => {
    const send = (status: number, data: unknown, cacheControl = 'no-store') => {
      response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': cacheControl, 'Access-Control-Allow-Origin': '*', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' }); response.end(JSON.stringify(data));
    };
    try {
      const url = new URL(request.url || '/', 'http://localhost');
      if (request.method === 'GET' && url.pathname === '/health') return send(200, { status: 'ok', version: '0.1.1' });
      const address = request.socket.remoteAddress || 'unknown';
      const window = limits.get(address);
      if (!window || window.reset < Date.now()) { if (limits.size > 10000) limits.clear(); limits.set(address, { count: 1, reset: Date.now() + 60000 }); }
      else if (++window.count > 180) return send(429, { error: 'Too many requests. Please wait a minute.' });
      const asset = request.method === 'GET' ? publicFiles[url.pathname] : undefined;
      if (asset) {
        response.writeHead(200, { 'Content-Type': asset[1], 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' data: https://www.themoviedb.org; frame-ancestors 'none'; base-uri 'none'; form-action 'none'" });
        return response.end(await publicFile(asset[0]));
      }
      if (request.method === 'POST' && url.pathname === '/v1/configurations') {
        const input = await body(request);
        if (typeof input.apiKey !== 'string' || input.apiKey.length < 20 || input.apiKey.length > 256 || /\s/.test(input.apiKey)) return send(400, { error: 'Enter a valid TMDB API key and maximum rating.' });
        const settings = settingsFrom(input);
        if (typeof settings === 'string') return send(400, { error: settings });
        const config: Configuration = { apiKey: input.apiKey, ...settings, managementHash: '' };
        await tmdb.validate(config);
        const result = await store.create(config);
        return send(201, { ...result, manifestPath: `/${result.id}/manifest.json`, maxRating: config.maxRating });
      }
      const enrichmentMatch = /^\/v1\/configurations\/([A-Za-z0-9_-]{43})\/tmdb$/.exec(url.pathname);
      if (request.method === 'POST' && enrichmentMatch) {
        const configId = enrichmentMatch[1]!;
        try { await authorization.requireConfiguration(request.headers.authorization, configId); }
        catch (error) { if (error instanceof ProxyAuthorizationError) return send(error.status, { error: error.message }); throw error; }
        let config: Configuration;
        try { config = await store.get(configId); } catch { return send(404, { error: 'Configuration unavailable' }); }
        let input: ReturnType<typeof validateEnrichmentRequest>;
        try { input = validateEnrichmentRequest(await body(request)); } catch { return send(400, { error: 'Invalid enrichment request' }); }
        const data = await enrichment(tmdb, config, input.endpoint, input.query);
        if (data === null) return send(404, { error: 'Title is unavailable for this kids profile' });
        return send(200, data);
      }
      // A signed-in Nuvio owner can edit from a second device without possessing the
      // original device's management token. The API key never leaves the service.
      const ownedCloneMatch = /^\/v1\/configurations\/([A-Za-z0-9_-]{43})\/clone-owned$/.exec(url.pathname);
      if (request.method === 'POST' && ownedCloneMatch) {
        const id = ownedCloneMatch[1]!;
        try { await authorization.requireConfiguration(request.headers.authorization, id); }
        catch (error) { if (error instanceof ProxyAuthorizationError) return send(error.status, { error: error.message }); throw error; }
        let previous: Configuration;
        try { previous = await store.get(id); }
        catch { return send(404, { error: 'Configuration unavailable.' }); }
        const input = await body(request);
        const settings = settingsFrom(input, previous);
        if (typeof settings === 'string') return send(400, { error: settings });
        const result = await store.create({ apiKey: previous.apiKey, ...settings });
        return send(201, { ...result, manifestPath: `/${result.id}/manifest.json`, maxRating: settings.maxRating });
      }
      // Keep capability-based management for standalone/custom-server setups.
      const cloneMatch = /^\/v1\/configurations\/([A-Za-z0-9_-]{43})\/clone$/.exec(url.pathname);
      if (request.method === 'POST' && cloneMatch) {
        let previous: Configuration;
        try { previous = await store.getManaged(cloneMatch[1]!, request.headers.authorization?.replace(/^Bearer /, '') || ''); }
        catch { return send(403, { error: 'Configuration or management token is invalid.' }); }
        const input = await body(request);
        const settings = settingsFrom(input, previous);
        if (typeof settings === 'string') return send(400, { error: settings });
        const result = await store.create({ apiKey: previous.apiKey, ...settings });
        return send(201, { ...result, manifestPath: `/${result.id}/manifest.json`, maxRating: settings.maxRating });
      }
      const deleteMatch = /^\/v1\/configurations\/([A-Za-z0-9_-]{43})$/.exec(url.pathname);
      if (request.method === 'DELETE' && deleteMatch) {
        try { await store.remove(deleteMatch[1]!, request.headers.authorization?.replace(/^Bearer /, '') || ''); }
        catch { return send(403, { error: 'Configuration or management token is invalid.' }); }
        return send(200, { deleted: true });
      }
      const parts = url.pathname.split('/').filter(Boolean);
      if (!parts[0] || !/^[A-Za-z0-9_-]{43}$/.test(parts[0])) return send(404, { error: 'Not found' });
      // Stremio's "Configure" button opens <addon>/configure; send it to the setup page.
      if (request.method === 'GET' && parts.length === 2 && parts[1] === 'configure') { response.writeHead(302, { Location: '/configure', 'Cache-Control': 'no-store' }); return response.end(); }
      let config: Configuration;
      try { config = await store.get(parts[0]); } catch { return send(404, { error: 'Configuration unavailable' }); }
      if (request.method === 'GET' && parts.length === 2 && parts[1] === 'manifest.json') return send(200, manifest(config));
      if (request.method === 'POST' && parts.length === 2 && parts[1] === 'check') {
        const input = await body(request);
        if (!Array.isArray(input.items) || input.items.length > 200 || input.items.some((item: any) => !item || !['movie', 'series'].includes(item.type) || typeof item.id !== 'string' || item.id.length > 128)) return send(400, { error: 'Provide up to 200 movie or series IDs.' });
        const items = await Promise.all(input.items.map(async (item: MediaRef) => ({ ...item, allowed: await tmdb.allowed(config, item, input.items.length === 1 ? 'interactive' : 'background') })));
        return send(200, { items });
      }
      if (request.method !== 'GET') return send(405, { error: 'Method not allowed' });
      if (!['movie', 'series'].includes(parts[2] || '')) return send(404, { error: 'Unsupported media type' });
      const type = parts[2] as MediaType;
      if (parts[1] === 'catalog' && parts[3]) {
        const kind = parts[3].replace(/\.json$/, '').replace(/^kids-/, '');
        if (!CATALOG_KINDS.includes(kind as CatalogKind) || (config.catalogs && !config.catalogs.includes(kind as CatalogKind))) return send(404, { error: 'Catalog is not enabled' });
        const extras = new URLSearchParams(parts[4] ? decodeURIComponent(parts[4].replace(/\.json$/, '')) : url.search);
        const skip = Number(extras.get('skip') || 0), query = extras.get('search')?.trim();
        if (!Number.isSafeInteger(skip) || skip < 0 || (query?.length ?? 0) > 200 || (query && kind !== 'popular')) return send(400, { error: 'Invalid catalog query' });
        const metas = await tmdb.catalog(config, type, kind, skip, query);
        // Config ids are immutable and part of the URL, so shared CDN caching is safe. Never cache empty results.
        return send(200, { metas }, metas.length ? SHARED_CACHE : 'no-store');
      }
      if (parts[1] === 'meta' && parts[3] && parts.length === 4) {
        const meta = await tmdb.meta(config, { type, id: decodeURIComponent(parts[3].replace(/\.json$/, '')) });
        return send(200, { meta }, meta ? SHARED_CACHE : 'no-store');
      }
      return send(404, { error: 'Not found' });
    } catch (error) {
      // Never expose TMDB URLs, API keys, request bodies or stack traces.
      if (error instanceof SyntaxError || error instanceof URIError) return send(400, { error: 'Invalid request' });
      return send(503, { error: 'KidsScreen could not complete this request. Check your TMDB key and try again.' });
    }
  };
}
export function createApp(store: ConfigStore, tmdb = new Tmdb(), authorization = new NuvioAuthorization()) { return createServer(createHandler(store, tmdb, authorization)); }
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const store = await deploymentStore();
  const app = createApp(store);
  const port = Number(process.env.PORT || 7879), host = process.env.HOST || '127.0.0.1';
  app.listen(port, host, () => process.stdout.write(`KidsScreen listening on ${host}:${port}\n`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => app.close(() => process.exit(0)));
}
