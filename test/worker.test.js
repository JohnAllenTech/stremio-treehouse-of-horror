import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.js';

// ---------- Fakes ----------
function fakeKV(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    async get(key, type) {
      const value = store.get(key);
      if (value === undefined) return null;
      return type === 'json' ? JSON.parse(value) : value;
    },
    async put(key, value) {
      store.set(key, value);
    },
  };
}

function makeEnv(overrides = {}) {
  return {
    TRAKT_USER: 'someone',
    TRAKT_LIST: 'spooky',
    LIST_NAME: 'Spooky List',
    TRAKT_CLIENT_ID: 'test-client-id',
    CACHE: fakeKV(),
    ...overrides,
  };
}

function traktItem(rank, season, number, title) {
  return {
    rank,
    type: 'episode',
    episode: { season, number, title, overview: `${title} overview`, first_aired: '1991-10-24T00:00:00.000Z' },
    show: { title: 'The Simpsons', year: 1989, ids: { imdb: 'tt0096697' } },
  };
}

// Items deliberately out of rank order to check sorting.
const TRAKT_ITEMS = [
  traktItem(2, 3, 7, 'Treehouse of Horror II'),
  traktItem(1, 2, 3, 'Treehouse of Horror'),
  { rank: 3, type: 'movie', movie: { title: 'Not an episode' } },
];

const realFetch = globalThis.fetch;
let traktCalls;

function mockTrakt({ status = 200, items = TRAKT_ITEMS } = {}) {
  globalThis.fetch = async (url, init) => {
    traktCalls.push({ url: String(url), headers: init?.headers });
    return new Response(JSON.stringify(items), {
      status,
      headers: { 'x-pagination-page-count': '1' },
    });
  };
}

beforeEach(() => {
  traktCalls = [];
  mockTrakt();
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

async function get(path, env = makeEnv()) {
  const res = await worker.fetch(new Request(`https://addon.test${path}`), env);
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { res, body };
}

// ---------- Config ----------
for (const name of ['TRAKT_USER', 'TRAKT_LIST', 'LIST_NAME']) {
  test(`returns 500 naming ${name} when it is missing`, async () => {
    const { res, body } = await get('/manifest.json', makeEnv({ [name]: undefined }));
    assert.equal(res.status, 500);
    assert.match(body.error, new RegExp(name));
  });
}

// ---------- Landing + manifest ----------
test('landing page shows the manifest URL', async () => {
  const { res, body } = await get('/');
  assert.equal(res.status, 200);
  assert.match(body, /https:\/\/addon\.test\/manifest\.json/);
  assert.match(body, /stremio:\/\/addon\.test\/manifest\.json/);
});

test('manifest describes one series catalog from config', async () => {
  const { res, body } = await get('/manifest.json');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), '*');
  assert.equal(body.id, 'community.trakt.episodelist.someone.spooky');
  assert.equal(body.name, 'Spooky List (Trakt)');
  assert.deepEqual(body.resources, ['catalog', 'meta']);
  assert.deepEqual(body.idPrefixes, ['halloween:']);
  assert.deepEqual(body.catalogs, [{ type: 'series', id: 'trakt-episode-list', name: 'Spooky List' }]);
});

test('OPTIONS returns CORS headers', async () => {
  const res = await worker.fetch(new Request('https://addon.test/manifest.json', { method: 'OPTIONS' }), makeEnv());
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), '*');
});

test('unknown paths return 404', async () => {
  const { res } = await get('/nope');
  assert.equal(res.status, 404);
});

// ---------- Catalog ----------
test('catalog returns one tile per episode in Trakt rank order', async () => {
  const { res, body } = await get('/catalog/series/trakt-episode-list.json');
  assert.equal(res.status, 200);
  assert.deepEqual(
    body.metas.map((m) => m.id),
    ['halloween:tt0096697:2:3', 'halloween:tt0096697:3:7']
  );
  const first = body.metas[0];
  assert.equal(first.name, 'Treehouse of Horror');
  assert.equal(first.posterShape, 'landscape');
  assert.equal(first.poster, 'https://episodes.metahub.space/tt0096697/2/3/w780.jpg');
  assert.match(first.description, /^The Simpsons S02E03 - /);
  assert.equal(first.videos, undefined, 'catalog previews should not include videos');
});

test('catalog calls Trakt with the configured list and client ID', async () => {
  await get('/catalog/series/trakt-episode-list.json');
  assert.equal(traktCalls.length, 1);
  assert.match(traktCalls[0].url, /\/users\/someone\/lists\/spooky\/items\/episode/);
  assert.equal(traktCalls[0].headers['trakt-api-key'], 'test-client-id');
});

test('catalog uses the show poster when STILL_URL_TEMPLATE is empty', async () => {
  const { body } = await get('/catalog/series/trakt-episode-list.json', makeEnv({ STILL_URL_TEMPLATE: '' }));
  assert.equal(body.metas[0].poster, 'https://images.metahub.space/poster/medium/tt0096697/img');
});

// ---------- Cache ----------
test('a fresh cache is served without calling Trakt', async () => {
  const env = makeEnv();
  await get('/catalog/series/trakt-episode-list.json', env);
  await get('/catalog/series/trakt-episode-list.json', env);
  assert.equal(traktCalls.length, 1);
  assert.ok(env.CACHE.store.has('list:someone:spooky'));
});

test('a stale cache is re-fetched from Trakt', async () => {
  const env = makeEnv({ CACHE_DAYS: '1' });
  env.CACHE.store.set('list:someone:spooky', JSON.stringify({ fetchedAt: 0, items: [] }));
  const { body } = await get('/catalog/series/trakt-episode-list.json', env);
  assert.equal(traktCalls.length, 1);
  assert.equal(body.metas.length, 2);
});

test('stale cache is served when Trakt fails', async () => {
  mockTrakt({ status: 503 });
  const env = makeEnv();
  const cachedItem = { imdb: 'tt0096697', season: 4, number: 5, title: 'Cached', show: 'The Simpsons' };
  env.CACHE.store.set('list:someone:spooky', JSON.stringify({ fetchedAt: 0, items: [cachedItem] }));
  const { body } = await get('/catalog/series/trakt-episode-list.json', env);
  assert.deepEqual(body.metas.map((m) => m.id), ['halloween:tt0096697:4:5']);
});

test('empty catalog when Trakt fails and nothing is cached', async () => {
  mockTrakt({ status: 503 });
  const { res, body } = await get('/catalog/series/trakt-episode-list.json');
  assert.equal(res.status, 200);
  assert.deepEqual(body.metas, []);
});

// ---------- Meta ----------
test('meta returns a one-episode series with the real IMDb episode ID', async () => {
  const { res, body } = await get('/meta/series/halloween:tt0096697:2:3.json');
  assert.equal(res.status, 200);
  assert.equal(body.meta.id, 'halloween:tt0096697:2:3');
  assert.equal(body.meta.type, 'series');
  assert.equal(body.meta.videos.length, 1);
  const [video] = body.meta.videos;
  assert.equal(video.id, 'tt0096697:2:3');
  assert.equal(video.season, 2);
  assert.equal(video.episode, 3);
  assert.equal(video.title, 'Treehouse of Horror');
});

test('meta still works for an episode not in the list', async () => {
  const { res, body } = await get('/meta/series/halloween:tt0096697:9:9.json');
  assert.equal(res.status, 200);
  assert.equal(body.meta.name, 'S09E09');
  assert.equal(body.meta.description, 'S09E09');
  assert.equal(body.meta.videos[0].id, 'tt0096697:9:9');
});

// ---------- Refresh ----------
test('refresh with the right token forces a Trakt fetch', async () => {
  const env = makeEnv({ REFRESH_TOKEN: 'secret-token' });
  await get('/catalog/series/trakt-episode-list.json', env);
  const { body } = await get('/refresh/secret-token', env);
  assert.deepEqual(body, { refreshed: true, episodes: 2 });
  assert.equal(traktCalls.length, 2);
});

test('refresh with the wrong token returns 404', async () => {
  const { res } = await get('/refresh/wrong', makeEnv({ REFRESH_TOKEN: 'secret-token' }));
  assert.equal(res.status, 404);
  assert.equal(traktCalls.length, 0);
});

test('refresh is disabled when REFRESH_TOKEN is not set', async () => {
  const { res } = await get('/refresh/anything');
  assert.equal(res.status, 404);
});
