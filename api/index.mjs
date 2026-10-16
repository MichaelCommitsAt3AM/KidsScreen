import { createHandler } from '../dist/server.js';
import { deploymentStore } from '../dist/store.js';

let handler;
export default async function serve(request, response) {
  try {
    handler ??= deploymentStore().then(store => createHandler(store)).catch(error => { handler = undefined; throw error; });
    return await (await handler)(request, response);
  } catch {
    response.writeHead(503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    response.end(JSON.stringify({ error: 'KidsScreen storage is unavailable. Check deployment settings.' }));
  }
}
