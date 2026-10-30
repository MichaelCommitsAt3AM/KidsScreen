import type { Configuration, MediaType } from './policy.js';
import { allowsTitle } from './policy.js';
import type { Tmdb } from './tmdb.js';

const TITLE = /^(movie|tv)\/[1-9]\d{0,9}/;
const ENDPOINTS = /^(?:(?:movie|tv)\/[1-9]\d{0,9}(?:\/(?:images|credits|aggregate_credits|content_ratings|release_dates|external_ids|recommendations|similar|videos)|\/season\/\d{1,3}(?:\/videos)?)?|find\/tt\d{5,12}|collection\/[1-9]\d{0,9}|person\/[1-9]\d{0,9}(?:\/combined_credits)?|(?:company|network)\/[1-9]\d{0,9}|discover\/(?:movie|tv))$/;

function allowedQuery(endpoint: string): Set<string> {
  const common = new Set(['language']);
  if (endpoint.endsWith('/images')) { common.add('include_image_language'); return common; }
  if (endpoint.startsWith('find/')) return new Set(['external_source']);
  if (endpoint.startsWith('discover/')) return new Set(['language', 'page', 'sort_by', 'with_companies', 'with_networks', 'vote_count.gte', 'include_adult']);
  if (/\/(recommendations|similar)$/.test(endpoint) || /\/season\/\d{1,3}$/.test(endpoint)) common.add('page');
  return common;
}

/** Read-only, relative TMDB endpoints. No arbitrary host/path, credentials or write APIs. */
export function validateEnrichmentRequest(input: unknown): { endpoint: string; query: Record<string, string> } {
  const data = input as { endpoint?: unknown; query?: unknown } | null;
  const endpoint = data?.endpoint;
  if (typeof endpoint !== 'string' || !ENDPOINTS.test(endpoint)) throw new Error('Invalid enrichment endpoint');
  const query: Record<string, string> = {};
  if (data?.query != null) {
    if (typeof data.query !== 'object' || Array.isArray(data.query)) throw new Error('Invalid enrichment query');
    const allowed = allowedQuery(endpoint);
    for (const [key, value] of Object.entries(data.query)) {
      if (!allowed.has(key) || typeof value !== 'string' || value.length > 120) throw new Error('Invalid enrichment query');
      if (!validValue(endpoint, key, value)) throw new Error('Invalid enrichment query');
      query[key] = value;
    }
  }
  if (query.page && (!/^\d{1,3}$/.test(query.page) || Number(query.page) < 1 || Number(query.page) > 500)) throw new Error('Invalid enrichment page');
  if (query.external_source && query.external_source !== 'imdb_id') throw new Error('Invalid external source');
  if (endpoint.startsWith('discover/')) query.include_adult = 'false';
  return { endpoint, query };
}

function validValue(endpoint: string, key: string, value: string): boolean {
  switch (key) {
    case 'language': return /^[a-z]{2}(?:-[A-Z]{2})?$/.test(value);
    case 'include_image_language': return /^[a-z]{2}(?:,[a-z]{2})*(?:,null)?$/.test(value);
    case 'external_source': return value === 'imdb_id';
    case 'page': return /^\d{1,3}$/.test(value);
    case 'sort_by': {
      const movie = endpoint === 'discover/movie';
      const allowed = movie
        ? ['popularity.desc', 'vote_average.desc', 'primary_release_date.desc']
        : ['popularity.desc', 'vote_average.desc', 'first_air_date.desc'];
      return allowed.includes(value);
    }
    case 'with_companies': case 'with_networks': return /^\d{1,10}(?:\|\d{1,10})*$/.test(value);
    case 'vote_count.gte': return /^\d{1,7}$/.test(value);
    case 'include_adult': return value === 'false';
    default: return false;
  }
}

/** Filter a TMDB media list without mutating the shared response cache. */
async function filterList(tmdb: Tmdb, config: Configuration, items: unknown, fallback: MediaType | null) {
  if (!Array.isArray(items)) return [];
  const filtered = await Promise.all(items.map(async (item: any) => {
    const id = Number(item?.id);
    if (!Number.isSafeInteger(id) || id <= 0) return null;
    const explicit = item?.media_type === 'tv' ? 'series' : item?.media_type === 'movie' ? 'movie' : null;
    const type = explicit ?? fallback;
    // A combined-credits row without media_type must not be guessed: guessing
    // could match an allowed movie to a disallowed series (or vice versa).
    if (!type) return null;
    return await tmdb.allowed(config, { type, id: `tmdb:${id}` }) ? item : null;
  }));
  return filtered.filter(Boolean);
}

export async function enrichment(tmdb: Tmdb, config: Configuration, endpoint: string, query: Record<string, string>) {
  const title = TITLE.exec(endpoint);
  let bundled: any;
  if (title) {
    const localized = query.language ? { ...config, language: query.language } : config;
    const type = title[1] === 'movie' ? 'movie' : 'series';
    const details = await tmdb.details(localized, { type, id: `tmdb:${endpoint.split('/')[1]}` });
    if (!allowsTitle(type, details, config.maxRating)) return null;
    const suffix = endpoint.slice(title[0].length);
    // The parental check already fetched this title and its appended policy/artwork data.
    // Reuse only subresponses whose query semantics match the bundled request.
    if (!suffix) {
      bundled = { ...details };
      delete bundled.images; delete bundled.external_ids; delete bundled.release_dates; delete bundled.content_ratings;
    } else if (suffix === '/release_dates') bundled = details.release_dates;
    else if (suffix === '/content_ratings') bundled = details.content_ratings;
    else if (suffix === '/external_ids') bundled = details.external_ids;
    else if (suffix === '/images' && query.include_image_language === 'en,null') bundled = details.images;
  }
  const data = bundled ?? await tmdb.get(config, endpoint, query);
  // Clone cached responses before filtering; never mutate a cache shared by configurations.
  const result = structuredClone(data);
  const fallback: MediaType | null = endpoint.startsWith('movie/') || endpoint.startsWith('discover/movie') ? 'movie'
    : endpoint.startsWith('tv/') || endpoint.startsWith('discover/tv') ? 'series' : null;
  if (endpoint.startsWith('find/')) {
    [result.movie_results, result.tv_results] = await Promise.all([
      filterList(tmdb, config, result.movie_results ?? [], 'movie'),
      filterList(tmdb, config, result.tv_results ?? [], 'series'),
    ]);
    delete result.person_results; delete result.tv_episode_results; delete result.tv_season_results;
  } else if ((endpoint.startsWith('discover/') || /\/(recommendations|similar)$/.test(endpoint)) && Array.isArray(result.results)) {
    result.results = await filterList(tmdb, config, result.results, fallback);
  }
  if (endpoint.startsWith('collection/') && Array.isArray(result.parts)) result.parts = await filterList(tmdb, config, result.parts, 'movie');
  if (endpoint.endsWith('/combined_credits')) {
    [result.cast, result.crew] = await Promise.all([
      filterList(tmdb, config, result.cast, null),
      filterList(tmdb, config, result.crew, null),
    ]);
  }
  return result;
}
