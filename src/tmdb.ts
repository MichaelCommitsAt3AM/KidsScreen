import { createHash } from 'node:crypto';
import { allowsTitle, MOVIE_HORROR_GENRE_ID, usRatings, type Configuration, type MediaType } from './policy.js';
export type MediaRef = { type: MediaType; id: string };
type Fetch = typeof fetch;
export type RequestPriority = 'interactive' | 'background';
export class Tmdb {
  private cache = new Map<string, { expires: number; data: any }>();
  private inFlight = new Map<string, Promise<any>>();
  private catalogs = new Map<string, { items: any[]; nextPage: number; exhausted: boolean; expires: number; queue: Promise<void> }>();
  private active = 0;
  private backgroundActive = 0;
  private waiters: Array<{ key: string; priority: RequestPriority; start: (complete: () => void) => void }> = [];
  constructor(private request: Fetch = fetch) {}
  private drain() {
    while (this.active < 5) {
      let index = this.waiters.findIndex(item => item.priority === 'interactive');
      if (index < 0) {
        if (this.backgroundActive >= 4) return;
        index = this.waiters.findIndex(item => item.priority === 'background');
      }
      if (index < 0) return;
      const next = this.waiters.splice(index, 1)[0]!;
      this.active++;
      const background = next.priority === 'background';
      if (background) this.backgroundActive++;
      // The completion closure uses the priority at admission, not a later caller's priority.
      const complete = () => { this.active--; if (background) this.backgroundActive--; this.drain(); };
      next.start(complete);
    }
  }
  private slot<T>(key: string, priority: RequestPriority, work: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.waiters.push({ key, priority, start: complete => {
        void Promise.resolve().then(work).then(resolve, reject).finally(complete);
      } });
      this.drain();
    });
  }
  async get(config: Configuration, endpoint: string, parameters: Record<string, string> = {}, priority: RequestPriority = 'interactive'): Promise<any> {
    const url = new URL(`https://api.themoviedb.org/3/${endpoint}`);
    url.search = new URLSearchParams({ language: config.language, ...parameters, api_key: config.apiKey }).toString();
    url.searchParams.sort();
    const key = createHash('sha256').update(url.toString()).digest('hex');
    const cached = this.cache.get(key); if (cached && cached.expires > Date.now()) return cached.data;
    const pending = this.inFlight.get(key);
    if (pending) {
      if (priority === 'interactive') {
        const queued = this.waiters.find(item => item.key === key);
        if (queued) { queued.priority = 'interactive'; this.drain(); }
      }
      return pending;
    }
    const operation = this.slot(key, priority, async () => {
      let response: Response;
      try { response = await this.request(url, { signal: AbortSignal.timeout(12000), redirect: 'error' }); }
      catch { throw new Error('TMDB is unavailable. Please try again.'); }
      if (!response.ok) throw new Error(response.status === 401 ? 'TMDB API key was rejected.' : 'TMDB request failed. Please try again.');
      const data = await response.json();
      if (this.cache.size >= 1000) this.cache.delete(this.cache.keys().next().value!);
      this.cache.set(key, { data, expires: Date.now() + 30 * 60 * 1000 }); return data;
    });
    this.inFlight.set(key, operation);
    try { return await operation; } finally { this.inFlight.delete(key); }
  }
  async validate(config: Configuration) { await this.get(config, 'authentication'); }
  async resolve(config: Configuration, ref: MediaRef, priority: RequestPriority = 'interactive'): Promise<number | null> {
    if (/^tt\d{5,12}$/.test(ref.id)) {
      const found = await this.get(config, `find/${ref.id}`, { external_source: 'imdb_id' }, priority);
      return (ref.type === 'movie' ? found.movie_results : found.tv_results)?.[0]?.id ?? null;
    }
    const tmdb = /^(?:tmdb:)(?:(movie|series|tv):)?(\d{1,10})$/.exec(ref.id);
    if (!tmdb || (tmdb[1] && (tmdb[1] === 'movie') !== (ref.type === 'movie'))) return null;
    return Number(tmdb[2]);
  }
  async details(config: Configuration, ref: MediaRef, priority: RequestPriority = 'interactive'): Promise<any | null> {
    const id = await this.resolve(config, ref, priority); if (id === null) return null;
    return this.get(config, `${ref.type === 'movie' ? 'movie' : 'tv'}/${id}`, { append_to_response: ref.type === 'movie' ? 'release_dates,external_ids,images' : 'content_ratings,external_ids,images', include_image_language: 'en,null' }, priority);
  }
  async allowed(config: Configuration, ref: MediaRef, priority: RequestPriority = 'background'): Promise<boolean> {
    try { const details = await this.details(config, ref, priority); return allowsTitle(ref.type, details, config.maxRating); }
    catch { return false; }
  }
  private preview(type: MediaType, details: any) {
    const image = (value: string | null | undefined, size: string) => value?.startsWith('/') ? `https://image.tmdb.org/t/p/${size}${value}` : undefined;
    return {
      id: details.imdb_id || details.external_ids?.imdb_id || `tmdb:${details.id}`, type,
      name: details.title || details.name, poster: image(details.poster_path, 'w500'), background: image(details.backdrop_path, 'original'),
      logo: image(details.images?.logos?.find((logo: any) => logo.iso_639_1 === 'en')?.file_path, 'w500'),
      description: details.overview || '', genres: (details.genres ?? []).map((genre: any) => genre.name),
      releaseInfo: (details.release_date || details.first_air_date || '').slice(0, 4),
      app_extras: { tmdbRating: details.vote_average ?? null },
      ageRating: usRatings(type, details).filter(Boolean).join(' / '),
    };
  }
  async catalog(config: Configuration, type: MediaType, kind: string, skip = 0, query?: string) {
    if (!['popular', 'animation', 'family'].includes(kind)) throw new Error('Unknown catalog');
    if (skip > 10000) return [];
    const key = createHash('sha256').update(JSON.stringify([config.apiKey, config.language, config.maxRating, type, kind, query])).digest('hex');
    let state = this.catalogs.get(key);
    if (!state || state.expires < Date.now()) {
      if (this.catalogs.size >= 64) this.catalogs.delete(this.catalogs.keys().next().value!);
      state = { items: [], nextPage: 1, exhausted: false, expires: Date.now() + 15 * 60000, queue: Promise.resolve() };
      this.catalogs.set(key, state);
    }
    const pageState = state;
    const fill = pageState.queue.catch(() => {}).then(async () => {
      let scanned = 0;
      // Offset is measured in eligible titles, not unfiltered TMDB pages.
      while (!pageState.exhausted && pageState.items.length < skip + 20 && scanned++ < 3) {
        const tmdbType = type === 'movie' ? 'movie' : 'tv';
        const params: Record<string, string> = { page: String(pageState.nextPage), include_adult: 'false' };
        if (query) params.query = query;
        else {
          params.sort_by = 'popularity.desc';
          if (kind !== 'popular') params.with_genres = kind === 'animation' ? '16' : '10751';
          else if (type === 'series') params.with_genres = '16|10762|10751';
          if (type === 'movie') Object.assign(params, { certification_country: 'US', 'certification.lte': config.maxRating, without_genres: String(MOVIE_HORROR_GENRE_ID) });
        }
        const result = await this.get(config, `${query ? 'search' : 'discover'}/${tmdbType}`, params, 'background');
        const raw = (result.results ?? []).slice(0, 20);
        const eligible = await Promise.all(raw.map(async (item: any) => {
          const details = await this.details(config, { type, id: `tmdb:${type}:${item.id}` }, 'background');
          return allowsTitle(type, details, config.maxRating) ? this.preview(type, details) : null;
        }));
        for (const item of eligible) if (item && !pageState.items.some(existing => existing.id === item.id)) pageState.items.push(item);
        pageState.exhausted = raw.length < 20 || pageState.nextPage >= Math.min(result.total_pages ?? 500, 500);
        pageState.nextPage++;
      }
    });
    pageState.queue = fill;
    await fill;
    return pageState.items.slice(skip, skip + 20);
  }

  async meta(config: Configuration, ref: MediaRef) {
    const details = await this.details(config, ref);
    if (!allowsTitle(ref.type, details, config.maxRating)) return null;
    const preview = this.preview(ref.type, details);
    if (ref.type === 'movie') return { ...preview, runtime: `${details.runtime || 0} min` };
    // Metadata includes normal seasons only. Specials require their own editorial policy.
    const seasons = (details.seasons ?? []).filter((season: any) => season.season_number > 0);
    const videos = (await Promise.all(seasons.slice(0, 60).map(async (season: any) => {
      const data = await this.get(config, `tv/${details.id}/season/${season.season_number}`);
      return (data.episodes ?? []).map((episode: any) => ({
        id: `${preview.id}:${episode.season_number}:${episode.episode_number}`, title: episode.name,
        season: episode.season_number, episode: episode.episode_number,
        released: episode.air_date ? `${episode.air_date}T00:00:00.000Z` : undefined,
        thumbnail: episode.still_path ? `https://image.tmdb.org/t/p/w500${episode.still_path}` : undefined, overview: episode.overview,
      }));
    }))).flat();
    return { ...preview, videos };
  }
}
