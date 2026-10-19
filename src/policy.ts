export const MAX_RATINGS = ['G', 'PG', 'PG-13'] as const;
export type MaxRating = typeof MAX_RATINGS[number];
export type MediaType = 'movie' | 'series';
export type Configuration = { apiKey: string; maxRating: MaxRating; language: string; managementHash: string };
const movieLevels: Record<string, number> = { G: 0, PG: 1, 'PG-13': 2, R: 3, 'NC-17': 4 };
// Conservative TV policy: TV-14 is above the strict 13-and-under ceiling.
const tvLevels: Record<string, number> = { 'TV-Y': 0, 'TV-G': 0, 'TV-Y7': 1, 'TV-Y7-FV': 1, 'TV-PG': 1, 'TV-14': 3, 'TV-MA': 4 };
export function validRating(value: unknown): value is MaxRating { return MAX_RATINGS.includes(value as MaxRating); }
export function allowsRatings(type: MediaType, ratings: string[], maximum: MaxRating): boolean {
  const levels = type === 'movie' ? movieLevels : tvLevels;
  const present = ratings.map(rating => rating.trim().toUpperCase()).filter(Boolean);
  return present.length > 0 && present.every(rating => levels[rating] !== undefined && levels[rating]! <= movieLevels[maximum]!);
}
export function usRatings(type: MediaType, details: any): string[] {
  return type === 'movie'
    ? (details.release_dates?.results ?? []).filter((row: any) => row.iso_3166_1 === 'US').flatMap((row: any) => (row.release_dates ?? []).map((date: any) => String(date.certification ?? '')))
    : (details.content_ratings?.results ?? []).filter((row: any) => row.iso_3166_1 === 'US').map((row: any) => String(row.rating ?? ''));
}

// TMDB movie genre IDs are stable across translated genre names.
export const MOVIE_HORROR_GENRE_ID = 27;
export function allowsTitle(type: MediaType, details: any, maximum: MaxRating): boolean {
  if (!details || details.adult) return false;
  if (type === 'movie') {
    if (!Array.isArray(details.genres) || !details.genres.length) return false;
    if (details.genres.some((genre: any) => genre?.id === MOVIE_HORROR_GENRE_ID)) return false;
  }
  return allowsRatings(type, usRatings(type, details), maximum);
}
