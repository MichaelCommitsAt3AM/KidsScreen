import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import type { Configuration } from './policy.js';
export const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');
type Storage = { read(id: string): Promise<string>; write(id: string, value: string): Promise<void>; remove(id: string): Promise<void> };
const validId = (id: string) => { if (!/^[A-Za-z0-9_-]{43}$/.test(id)) throw new Error('Invalid configuration'); return id; };
function encryptionKey(encodedKey?: string) {
  if (!encodedKey) throw new Error('KIDSSCREEN_ENCRYPTION_KEY is required');
  const key = Buffer.from(encodedKey, 'base64');
  if (key.length !== 32) throw new Error('Encryption key must contain exactly 32 bytes');
  return key;
}
export class ConfigStore {
  private reads = new Map<string, Promise<Configuration>>();
  private constructor(private storage: Storage, private key: Buffer) {}
  /** Shared durable storage for serverless deployments. Never falls back to local files. */
  static redis(url: string, token: string, encodedKey: string, transport: typeof fetch = fetch) {
    const endpoint = new URL(url);
    if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== '/') throw new Error('Use the HTTPS Redis REST endpoint');
    if (!token) throw new Error('Redis REST token is required');
    const command = async (...args: string[]): Promise<unknown> => {
      const response = await transport(endpoint, { method: 'POST', redirect: 'error', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(args), signal: AbortSignal.timeout(10000) });
      if (!response.ok) throw new Error('Configuration storage is unavailable');
      const reply = await response.json() as { result?: unknown; error?: string };
      if (reply.error) throw new Error('Configuration storage request failed');
      return reply.result;
    };
    const name = (id: string) => `kidsscreen:config:${validId(id)}`;
    return new ConfigStore({
      async read(id) { const value = await command('GET', name(id)); if (typeof value !== 'string') throw new Error('Configuration unavailable'); return value; },
      async write(id, value) { if (await command('SET', name(id), value, 'NX') !== 'OK') throw new Error('Configuration could not be saved'); },
      async remove(id) { if (await command('DEL', name(id)) !== 1) throw new Error('Configuration unavailable'); },
    }, encryptionKey(encodedKey));
  }
  static async open(directory: string, encodedKey?: string, production = false) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    let key: Buffer;
    if (encodedKey) { key = Buffer.from(encodedKey, 'base64'); }
    else {
      if (production) throw new Error('KIDSSCREEN_ENCRYPTION_KEY is required in production');
      const keyPath = path.join(directory, 'master.key');
      try { key = await readFile(keyPath); }
      catch (error: any) {
        if (error.code !== 'ENOENT') throw error;
        const generated = randomBytes(32);
        try { await writeFile(keyPath, generated, { flag: 'wx', mode: 0o600 }); key = generated; }
        catch (writeError: any) { if (writeError.code !== 'EEXIST') throw writeError; key = await readFile(keyPath); }
      }
    }
    if (key.length !== 32) throw new Error('Encryption key must contain exactly 32 bytes');
    const file = (id: string) => path.join(directory, `${validId(id)}.json`);
    return new ConfigStore({
      read: id => readFile(file(id), 'utf8'),
      async write(id, value) { const temporary = `${file(id)}.tmp`; await writeFile(temporary, value, { flag: 'wx', mode: 0o600 }); await rename(temporary, file(id)); },
      remove: id => unlink(file(id)),
    }, key);
  }
  async create(config: Omit<Configuration, 'managementHash'>) {
    const id = randomBytes(32).toString('base64url');
    const managementToken = randomBytes(32).toString('base64url');
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const data = Buffer.concat([cipher.update(JSON.stringify({ ...config, managementHash: tokenHash(managementToken) })), cipher.final()]);
    await this.storage.write(id, JSON.stringify({ iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') }));
    return { id, managementToken };
  }
  async get(id: string): Promise<Configuration> {
    validId(id);
    const pending = this.reads.get(id);
    if (pending) return structuredClone(await pending);
    const operation = this.readConfiguration(id);
    this.reads.set(id, operation);
    try { return structuredClone(await operation); }
    finally { if (this.reads.get(id) === operation) this.reads.delete(id); }
  }
  private async readConfiguration(id: string): Promise<Configuration> {
    const sealed = JSON.parse(await this.storage.read(validId(id)));
    const cipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(sealed.iv, 'base64'));
    cipher.setAuthTag(Buffer.from(sealed.tag, 'base64'));
    return JSON.parse(Buffer.concat([cipher.update(Buffer.from(sealed.data, 'base64')), cipher.final()]).toString('utf8'));
  }
  async getManaged(id: string, token: string): Promise<Configuration> {
    const config = await this.get(id);
    if (!timingSafeEqual(Buffer.from(config.managementHash, 'hex'), Buffer.from(tokenHash(token), 'hex'))) throw new Error('Invalid management token');
    return config;
  }
  async remove(id: string, token: string) {
    await this.getManaged(id, token);
    await this.storage.remove(validId(id));
  }
}

export function deploymentStore(env: NodeJS.ProcessEnv = process.env) {
  const url = env.UPSTASH_REDIS_REST_URL || env.KV_REST_API_URL;
  const token = env.UPSTASH_REDIS_REST_TOKEN || env.KV_REST_API_TOKEN;
  if (url || token || env.VERCEL) {
    if (!url || !token) throw new Error('Connect Redis and set UPSTASH_REDIS_REST_URL/TOKEN or KV_REST_API_URL/TOKEN');
    return Promise.resolve(ConfigStore.redis(url, token, env.KIDSSCREEN_ENCRYPTION_KEY || ''));
  }
  return ConfigStore.open(env.KIDSSCREEN_DATA_DIR || '.data', env.KIDSSCREEN_ENCRYPTION_KEY, env.NODE_ENV === 'production');
}
