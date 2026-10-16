# Deploy KidsScreen to Vercel

The repository includes `vercel.json` and `api/index.mjs`. All routes use the same Node handler as local development. Vercel uses Upstash Redis REST storage instead of local files; configuration values remain AES-256-GCM encrypted. There is no runtime npm dependency to install beyond Node. This is deployment preparation, not a completed hosted deployment.

## 1. Push the KidsScreen repository

Push the files from `C:\projects\kidsscreen` to the separate GitHub repository you created. Keep `.data`, `.env*`, local logs and keys out of Git; the supplied ignore files exclude them. Do not push the Nuvio repository into this project.

## 2. Import it into Vercel

Choose **Add New → Project**, import your KidsScreen GitHub repository, set the framework preset to **Other**, and use the repository root (`.`) as the root directory. Select Node.js **22.x**. The checked-in configuration sets:

- Install command: `npm ci`
- Build command: `npm run build`
- Output directory: `public`
- Function: `api/index.mjs`, maximum duration 60 seconds

## 3. Connect durable storage

In the project's **Storage / Marketplace**, create or connect **Upstash Redis**. Connect it to the production environment (and preview only if you plan to test preview deployments). Choose a region close to the function region. Keep configuration keys persistent: do not configure expiration or an eviction policy that removes them.

The server expects the read-write REST credentials under these exact server environment-variable names:

| Variable | Value |
| --- | --- |
| `UPSTASH_REDIS_REST_URL` | The HTTPS REST endpoint from Upstash |
| `UPSTASH_REDIS_REST_TOKEN` | The read-write REST token, not the read-only token |
| `KIDSSCREEN_ENCRYPTION_KEY` | A persistent, private base64-encoded 32-byte key |

Some integrations offer a variable prefix. If the generated variable names differ, add the expected names manually in Vercel's Environment Variables settings. Do not use `VITE_` or `NEXT_PUBLIC_` prefixes.

Generate the encryption key locally:

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Paste the result into Vercel and save it in your password manager. Keep the same key across redeployments. Changing it without migrating stored values makes existing configurations unreadable. Preview should use a separate Redis database and encryption key if you want isolation from production.

Do not add a shared TMDB key to Vercel: each parent enters their personal key in Nuvio or KidsScreen's setup page. It is encrypted before saving in Redis.

## 4. Deploy and verify

Deploy, or redeploy after changing environment variables. Use the stable **production** domain, for example `https://kidsscreen.vercel.app`.

1. Open `/health` and confirm `{"status":"ok","version":"0.1.0"}`. This confirms initialization; creating a configuration also verifies Redis credentials and TMDB connectivity.
2. Open `/`, enter a personal TMDB API key and rating, and create a test configuration. Save its private management token.
3. Open the returned manifest URL. Confirm its six catalogs, then test a catalog. The manifest ID is a private access capability; don't share the URL publicly.
4. Redeploy and confirm the same manifest still loads. This checks that Redis and the encryption key persist.
5. To revoke the test configuration, send `DELETE /v1/configurations/<id>` with `Authorization: Bearer <managementToken>`. Its manifest should then return 404.

Nuvio cannot complete Vercel login challenges. The production domain's Deployment Protection settings must permit ordinary addon HTTP requests. Auth-protected preview domains will not work as Nuvio's server address. Apply Vercel Firewall rate limits to public provisioning/check endpoints as appropriate; the built-in limiter is per instance and is not a global quota. Avoid adding request-body or credential logging. Serverless caches are temporary; configuration storage is durable. Local fake-transport tests do not replace a real hosted TMDB browsing/playback check.

## 5. Connect Nuvio

From an adult profile, open the target profile editor:

1. Enable **Kids account**.
2. Choose G, PG or PG-13.
3. Enter the personal TMDB key and main profile's parent PIN.
4. Expand **KidsScreen connection** and replace `http://127.0.0.1:7879` with your production HTTPS domain, without a path.
5. Save, switch to the kids profile, and test Home, featured titles, search, details and playback.

Re-save existing local kids profiles with the hosted address and TMDB key. Local configuration IDs are not automatically copied into Redis. Keep the local server running until any profiles that still reference it are moved.

## References

- [Vercel Node.js runtime](https://vercel.com/docs/functions/runtimes/node-js)
- [Vercel Marketplace storage](https://vercel.com/docs/marketplace-storage)
- [Vercel runtime filesystem restrictions](https://vercel.com/docs/functions/runtimes)
- [Upstash REST API](https://upstash.com/docs/redis/features/restapi)
- [Vercel Deployment Protection](https://vercel.com/docs/deployment-protection)
