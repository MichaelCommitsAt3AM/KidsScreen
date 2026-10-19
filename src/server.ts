import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { pathToFileURL } from 'node:url';
import { ConfigStore, deploymentStore } from './store.js';
import { Tmdb, type MediaRef } from './tmdb.js';
import { validRating, type Configuration, type MediaType } from './policy.js';
import { configurationPage } from './setup.js';

const manifest = (rating: string) => ({
  id: 'org.kidsscreen.catalogs', version: '0.1.1', name: `KidsScreen · ${rating}`, description: 'Rating-filtered movies and series. Requires a personal TMDB API key.',
  types: ['movie', 'series'], resources: ['catalog', { name: 'meta', types: ['movie', 'series'], idPrefixes: ['tt', 'tmdb:'] }],
  catalogs: (['movie', 'series'] as const).flatMap(type => ['popular', 'animation', 'family'].map(kind => ({ type, id: `kids-${kind}`, name: `KidsScreen ${kind[0]!.toUpperCase()}${kind.slice(1)}`, extra: [{ name: 'skip' }, ...(kind === 'popular' ? [{ name: 'search' }] : [])] }))),
  behaviorHints: { configurable: true, configurationRequired: false },
});
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
export function createHandler(store: ConfigStore, tmdb = new Tmdb()) {
  const limits = new Map<string, { count: number; reset: number }>();
  return async (request: IncomingMessage, response: ServerResponse) => {
    const send = (status: number, data: unknown) => {
      response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' }); response.end(JSON.stringify(data));
    };
    try {
      const url = new URL(request.url || '/', 'http://localhost');
      if (request.method === 'GET' && url.pathname === '/health') return send(200, { status: 'ok', version: '0.1.1' });
      const address = request.socket.remoteAddress || 'unknown';
      const window = limits.get(address);
      if (!window || window.reset < Date.now()) { if (limits.size > 10000) limits.clear(); limits.set(address, { count: 1, reset: Date.now() + 60000 }); }
      else if (++window.count > 180) return send(429, { error: 'Too many requests. Please wait a minute.' });
      if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/configure')) {
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src 'self' https://www.themoviedb.org; frame-ancestors 'none'" });
        return response.end(configurationPage);
      }
      if (request.method === 'POST' && url.pathname === '/v1/configurations') {
        const input = await body(request);
        if (!validRating(input.maxRating) || typeof input.apiKey !== 'string' || input.apiKey.length < 20 || input.apiKey.length > 256 || /\s/.test(input.apiKey)) return send(400, { error: 'Enter a valid TMDB API key and maximum rating.' });
        const language = input.language ?? 'en-US';
        if (typeof language !== 'string' || !/^[a-z]{2}(?:-[A-Z]{2})?$/.test(language)) return send(400, { error: 'Invalid language.' });
        const config: Configuration = { apiKey: input.apiKey, maxRating: input.maxRating, language, managementHash: '' };
        await tmdb.validate(config);
        const result = await store.create(config);
        return send(201, { ...result, manifestPath: `/${result.id}/manifest.json`, maxRating: config.maxRating });
      }
      const deleteMatch = /^\/v1\/configurations\/([A-Za-z0-9_-]{43})$/.exec(url.pathname);
      if (request.method === 'DELETE' && deleteMatch) {
        try { await store.remove(deleteMatch[1]!, request.headers.authorization?.replace(/^Bearer /, '') || ''); }
        catch { return send(403, { error: 'Configuration or management token is invalid.' }); }
        return send(200, { deleted: true });
      }
      const parts = url.pathname.split('/').filter(Boolean);
      if (!parts[0] || !/^[A-Za-z0-9_-]{43}$/.test(parts[0])) return send(404, { error: 'Not found' });
      let config: Configuration;
      try { config = await store.get(parts[0]); } catch { return send(404, { error: 'Configuration unavailable' }); }
      if (request.method === 'GET' && parts.length === 2 && parts[1] === 'manifest.json') return send(200, manifest(config.maxRating));
      if (request.method === 'POST' && parts.length === 2 && parts[1] === 'check') {
        const input = await body(request);
        if (!Array.isArray(input.items) || input.items.length > 200 || input.items.some((item: any) => !item || !['movie', 'series'].includes(item.type) || typeof item.id !== 'string' || item.id.length > 128)) return send(400, { error: 'Provide up to 200 movie or series IDs.' });
        const items = await Promise.all(input.items.map(async (item: MediaRef) => ({ ...item, allowed: await tmdb.allowed(config, item) })));
        return send(200, { items });
      }
      if (request.method !== 'GET') return send(405, { error: 'Method not allowed' });
      if (!['movie', 'series'].includes(parts[2] || '')) return send(404, { error: 'Unsupported media type' });
      const type = parts[2] as MediaType;
      if (parts[1] === 'catalog' && parts[3]) {
        const kind = parts[3].replace(/\.json$/, '').replace(/^kids-/, '');
        const extras = new URLSearchParams(parts[4] ? decodeURIComponent(parts[4].replace(/\.json$/, '')) : url.search);
        const skip = Number(extras.get('skip') || 0), query = extras.get('search')?.trim();
        if (!Number.isSafeInteger(skip) || skip < 0 || (query?.length ?? 0) > 200 || (query && kind !== 'popular')) return send(400, { error: 'Invalid catalog query' });
        return send(200, { metas: await tmdb.catalog(config, type, kind, skip, query) });
      }
      if (parts[1] === 'meta' && parts[3] && parts.length === 4) return send(200, { meta: await tmdb.meta(config, { type, id: decodeURIComponent(parts[3].replace(/\.json$/, '')) }) });
      return send(404, { error: 'Not found' });
    } catch (error) {
      // Never expose TMDB URLs, API keys, request bodies or stack traces.
      if (error instanceof SyntaxError || error instanceof URIError) return send(400, { error: 'Invalid request' });
      return send(503, { error: 'KidsScreen could not complete this request. Check your TMDB key and try again.' });
    }
  };
}
export function createApp(store: ConfigStore, tmdb = new Tmdb()) { return createServer(createHandler(store, tmdb)); }
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const store = await deploymentStore();
  const app = createApp(store);
  const port = Number(process.env.PORT || 7879), host = process.env.HOST || '127.0.0.1';
  app.listen(port, host, () => process.stdout.write(`KidsScreen listening on ${host}:${port}\n`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => app.close(() => process.exit(0)));
}
