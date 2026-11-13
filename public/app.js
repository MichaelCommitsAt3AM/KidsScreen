'use strict';
const $ = selector => document.querySelector(selector);
// Links shown to users always use the permanent production host, never a preview/deployment or local URL.
const publicOrigin = 'https://kids-screen.vercel.app';

async function api(path, options) {
  const response = await fetch(path, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Request failed. Please try again.');
  return data;
}

async function copy(input, button) {
  const original = button.textContent;
  try { await navigator.clipboard.writeText(input.value); }
  catch { input.focus(); input.select(); document.execCommand('copy'); }
  button.textContent = 'Copied';
  setTimeout(() => { button.textContent = original; }, 1500);
}

$('#setup').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.target, button = form.querySelector('button[type=submit]'), error = $('#error');
  const data = new FormData(form);
  const catalogs = data.getAll('catalogs');
  error.textContent = '';
  if (!catalogs.length) { error.textContent = 'Choose at least one catalog.'; return; }
  // One rating drives both movies and series: G→TV-G, PG→TV-PG, PG-13→TV-14.
  const tvRatings = { G: 'TV-G', PG: 'TV-PG', 'PG-13': 'TV-14' };
  const payload = { apiKey: data.get('apiKey').trim(), maxRating: data.get('maxRating'), maxTvRating: tvRatings[data.get('maxRating')], language: data.get('language'), catalogs, allowUnrated: data.has('allowUnrated') };
  button.disabled = true;
  try {
    const result = await api('/v1/configurations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const manifestUrl = publicOrigin + result.manifestPath;
    $('#manifest-url').value = manifestUrl;
    $('#open-stremio').href = manifestUrl.replace(/^https?:/, 'stremio:');
    $('#open-stremio-web').href = 'https://web.stremio.com/#/addons?addon=' + encodeURIComponent(manifestUrl);
    form.reset();
    $('#setup-card').hidden = true;
    $('#result-card').hidden = false;
    $('#result-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (failure) { error.textContent = failure.message; }
  finally { button.disabled = false; }
});

$('#copy-manifest').addEventListener('click', event => copy($('#manifest-url'), event.target));
$('#manifest-url').addEventListener('focus', event => event.target.select());

$('#another').addEventListener('click', () => {
  $('#manifest-url').value = '';
  $('#result-card').hidden = true; $('#setup-card').hidden = false;
});
