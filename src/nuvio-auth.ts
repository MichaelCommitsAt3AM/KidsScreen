import { createHash } from 'node:crypto';

export class ProxyAuthorizationError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

type ProfileRow = { kids_config_id?: unknown; kids_enabled?: unknown };

/**
 * Trust one explicitly configured Nuvio backend, never a caller-supplied JWT
 * issuer/URL. Nuvio profiles are only readable through the caller-scoped
 * sync_pull_profiles() RPC (the profiles table deliberately has no SELECT RLS
 * policy because it also stores pin hashes), so authorization uses that RPC.
 */
export class NuvioAuthorization {
  private cache = new Map<string, { expires: number; userId: string }>();
  private pending = new Map<string, Promise<string>>();
  constructor(private env: NodeJS.ProcessEnv = process.env, private request: typeof fetch = fetch) {}

  async requireConfiguration(header: string | undefined, configId: string): Promise<string> {
    const token = /^Bearer ([A-Za-z0-9_.-]{20,8192})$/.exec(header ?? '')?.[1];
    if (!token) throw new ProxyAuthorizationError(401, 'Sign in to Nuvio to use enrichment.');
    const key = createHash('sha256').update(`${configId}:${token}`).digest('hex');
    const cached = this.cache.get(key);
    if (cached && cached.expires > Date.now()) return cached.userId;
    const pending = this.pending.get(key); if (pending) return pending;
    const operation = this.verify(token, configId);
    this.pending.set(key, operation);
    try {
      const userId = await operation;
      const expires = Math.min(Date.now() + 5000, tokenExpiry(token));
      if (expires > Date.now()) {
        if (this.cache.size >= 1000) this.cache.delete(this.cache.keys().next().value!);
        this.cache.set(key, { userId, expires });
      }
      return userId;
    } finally { this.pending.delete(key); }
  }

  private async verify(token: string, configId: string): Promise<string> {
    const base = this.baseUrl();
    const apiKey = this.env.KIDSSCREEN_NUVIO_PUBLISHABLE_KEY!;
    const headers = { apikey: apiKey, Authorization: `Bearer ${token}` };
    const profileAbort = new AbortController();
    // Both checks are required, but they are independent network reads. Start
    // together and never inspect/return profile data before user validation.
    const userRequest = this.request(new URL('/auth/v1/user', base), {
      headers, redirect: 'error', signal: AbortSignal.timeout(8000),
    }).catch(() => null);
    const profileRequest = this.request(new URL('/rest/v1/rpc/sync_pull_profiles', base), {
      method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: '{}', redirect: 'error',
      signal: AbortSignal.any([AbortSignal.timeout(8000), profileAbort.signal]),
    }).catch(() => null);
    const userResponse = await userRequest;
    if (!userResponse) { profileAbort.abort(); throw new ProxyAuthorizationError(503, 'Nuvio authentication is unavailable.'); }
    if (userResponse.status === 401 || userResponse.status === 403) { profileAbort.abort(); throw new ProxyAuthorizationError(401, 'Nuvio session expired. Sign in again.'); }
    if (!userResponse.ok) { profileAbort.abort(); throw new ProxyAuthorizationError(503, 'Nuvio authentication is unavailable.'); }
    const user = await userResponse.json().catch(() => null) as { id?: unknown; is_anonymous?: unknown } | null;
    if (typeof user?.id !== 'string' || !user.id || user.is_anonymous === true) { profileAbort.abort(); throw new ProxyAuthorizationError(401, 'Sign in to Nuvio to use enrichment.'); }
    const response = await profileRequest;
    if (!response) throw new ProxyAuthorizationError(503, 'Nuvio profile verification is unavailable.');
    if (response.status === 401 || response.status === 403) throw new ProxyAuthorizationError(401, 'Nuvio session expired. Sign in again.');
    if (!response.ok) throw new ProxyAuthorizationError(503, 'Nuvio profile verification is unavailable.');
    const rows: unknown = await response.json().catch(() => null);
    // The RPC is security definer but scoped to auth.uid(). Still verify the
    // match here so a misconfigured backend cannot authorize another account.
    if (!Array.isArray(rows) || !rows.some((row): boolean => {
      const profile = row as ProfileRow | null;
      return !!profile && profile.kids_enabled === true && profile.kids_config_id === configId;
    })) throw new ProxyAuthorizationError(403, 'This kids configuration does not belong to your Nuvio account.');
    return user.id;
  }

  private baseUrl(): URL {
    const rawUrl = this.env.KIDSSCREEN_NUVIO_SUPABASE_URL;
    const apiKey = this.env.KIDSSCREEN_NUVIO_PUBLISHABLE_KEY;
    if (!rawUrl || !apiKey) throw new ProxyAuthorizationError(503, 'Nuvio enrichment authentication is not configured.');
    let base: URL;
    try { base = new URL(rawUrl); } catch { throw new ProxyAuthorizationError(503, 'Nuvio enrichment authentication is not configured.'); }
    if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash || base.pathname !== '/') throw new ProxyAuthorizationError(503, 'Nuvio enrichment authentication is not configured.');
    return base;
  }
}

/** Supabase access tokens are JWTs. Never extend the cache past their own expiry. */
function tokenExpiry(token: string): number {
  try {
    const claims = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')) as { exp?: unknown };
    return typeof claims.exp === 'number' && Number.isFinite(claims.exp) ? claims.exp * 1000 : Date.now() + 5000;
  } catch { return Date.now() + 5000; }
}
