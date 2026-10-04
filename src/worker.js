// Stremio addon: shows each episode of a Trakt list as its own tile.
// Each tile is a one-episode "series" that uses the real IMDb episode ID,
// so stream addons (e.g. AIOStreams) resolve it like any normal episode.

const CATALOG_ID = 'trakt-episode-list';
const ID_PREFIX = 'halloween:';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

// ---------- Config ----------
function getConfig(env) {
  const days = Number(env.CACHE_DAYS || 7);
  return {
    user: env.TRAKT_USER,
    list: env.TRAKT_LIST,
    listName: env.LIST_NAME,
    clientId: env.TRAKT_CLIENT_ID,
    cacheMs: days * 24 * 60 * 60 * 1000,
    // "true": every tile's page lists the whole list so next episode / binge
    // watching carries on through it. Anything else: just the tile's episode.
    playThroughList: env.PLAY_THROUGH_LIST === 'true',
    // {imdb} {season} {episode} are replaced. Leave empty to use the show poster.
    stillTemplate:
      env.STILL_URL_TEMPLATE ?? 'https://episodes.metahub.space/{imdb}/{season}/{episode}/w780.jpg',
  };
}

// Required plain vars (wrangler.toml [vars]). There are no built-in defaults.
const REQUIRED_VARS = ['TRAKT_USER', 'TRAKT_LIST', 'LIST_NAME'];

function missingVars(env) {
  return REQUIRED_VARS.filter((name) => !env[name]);
}

// ---------- Trakt + KV cache ----------
async function fetchFromTrakt(c) {
  if (!c.clientId) throw new Error('TRAKT_CLIENT_ID secret is not set');

  const all = [];
  let page = 1;
  let pageCount = 1;

  do {
    const url =
      `https://api.trakt.tv/users/${encodeURIComponent(c.user)}` +
      `/lists/${encodeURIComponent(c.list)}/items/episode` +
      `?extended=full&page=${page}&limit=100`;

    const res = await fetch(url, {
      headers: {
        'Content-Type': 'application/json',
        'trakt-api-version': '2',
        'trakt-api-key': c.clientId,
        // Trakt's API sits behind Cloudflare, which rejects requests with no User-Agent.
        'User-Agent': 'stremio-treehouse-of-horror/1.0',
      },
    });
    if (!res.ok) {
      throw new Error(`Trakt responded ${res.status} for ${c.user}/${c.list} (is the list public and the Client ID right?)`);
    }

    pageCount = Number(res.headers.get('x-pagination-page-count') || 1);
    all.push(...(await res.json()));
    page++;
  } while (page <= pageCount);

  const items = all
    .filter((i) => i.type === 'episode' && i.show?.ids?.imdb)
    .sort((a, b) => a.rank - b.rank)
    .map((i) => ({
      imdb: i.show.ids.imdb,
      season: i.episode.season,
      number: i.episode.number,
      title: i.episode.title,
      overview: i.episode.overview,
      released: i.episode.first_aired,
      show: i.show.title,
      year: i.show.year,
    }));
  return { items, rawCount: all.length };
}

// Returns the list plus where it came from, so /status can explain an empty catalog.
async function loadList(env, { force = false } = {}) {
  const c = getConfig(env);
  const key = `list:${c.user}:${c.list}`;

  const cached = await env.CACHE.get(key, 'json');
  const isFresh = cached && Date.now() - cached.fetchedAt < c.cacheMs;
  if (isFresh && !force) {
    return { items: cached.items, source: 'cache', fetchedAt: cached.fetchedAt };
  }

  try {
    const { items, rawCount } = await fetchFromTrakt(c);
    const fetchedAt = Date.now();
    if (items.length > 0) {
      // No KV expiry on purpose: keeps the last copy around as a fallback.
      await env.CACHE.put(key, JSON.stringify({ fetchedAt, items }));
    }
    return { items, source: 'trakt', fetchedAt, traktItems: rawCount };
  } catch (err) {
    console.error('Trakt fetch failed:', err.message);
    // Serve stale rather than nothing.
    return {
      items: cached ? cached.items : [],
      source: cached ? 'stale-cache' : 'none',
      fetchedAt: cached?.fetchedAt,
      error: err.message,
    };
  }
}

async function getItems(env, opts) {
  return (await loadList(env, opts)).items;
}

// ---------- Helpers ----------
const pad = (n) => String(n).padStart(2, '0');

function artwork(c, it) {
  if (!c.stillTemplate) return `https://images.metahub.space/poster/medium/${it.imdb}/img`;
  return c.stillTemplate
    .replace('{imdb}', it.imdb)
    .replace('{season}', it.season)
    .replace('{episode}', it.number);
}

function tileId(it) {
  return `${ID_PREFIX}${it.imdb}:${it.season}:${it.number}`;
}

function json(data, maxAge = 3600) {
  return new Response(JSON.stringify(data), {
    headers: {
      ...CORS,
      'Content-Type': 'application/json',
      'Cache-Control': `public, max-age=${maxAge}`,
    },
  });
}

const code = (it) => `S${pad(it.season)}E${pad(it.number)}`;
const videoId = (it) => `${it.imdb}:${it.season}:${it.number}`; // real ID used for streams
const sameEpisode = (a, b) => videoId(a) === videoId(b);

// Catalog tile: one per episode.
function buildPreview(c, it) {
  const art = artwork(c, it);
  return {
    id: tileId(it),
    type: 'series',
    name: it.title || code(it),
    poster: art,
    posterShape: 'landscape',
    background: art,
    description: `${it.show ? it.show + ' ' : ''}${code(it)}${it.overview ? ' - ' + it.overview : ''}`,
    releaseInfo: it.year ? String(it.year) : undefined,
  };
}

// Detail page behind a tile. With PLAY_THROUGH_LIST it lists every episode in
// the Trakt list, so Stremio's "next episode" and binge watching carry on
// through the list; otherwise just the tile's own episode. Episodes are
// numbered 1..n in list order (season 1) so Stremio's next episode follows
// the list; each video keeps its real IMDb ID for streams.
// defaultVideoId opens the tile's own episode straight away.
function buildMeta(c, it, items) {
  let playlist = [it];
  if (c.playThroughList) {
    playlist = items.some((x) => sameEpisode(x, it)) ? items : [it, ...items];
  }
  return {
    ...buildPreview(c, it),
    behaviorHints: { defaultVideoId: videoId(it) },
    videos: playlist.map((ep, i) => ({
      id: videoId(ep),
      title: ep.title || code(ep),
      season: 1,
      episode: i + 1,
      released: ep.released || new Date(0).toISOString(),
      overview: `${code(ep)}${ep.overview ? ' - ' + ep.overview : ''}`,
      thumbnail: artwork(c, ep),
    })),
  };
}

function manifest(c) {
  return {
    id: `community.trakt.episodelist.${c.user}.${c.list}`.replace(/[^a-zA-Z0-9.]/g, ''),
    version: '1.0.0',
    name: `${c.listName} (Trakt)`,
    description: 'One tile per episode from a Trakt list of episodes.',
    resources: ['catalog', 'meta'],
    types: ['series'],
    idPrefixes: [ID_PREFIX],
    catalogs: [{ type: 'series', id: CATALOG_ID, name: c.listName }],
  };
}

// ---------- Routing ----------
export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });

    const missing = missingVars(env);
    if (missing.length > 0) {
      return new Response(
        JSON.stringify({ error: `Missing required config: ${missing.join(', ')}. Set them in wrangler.toml [vars].` }),
        { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } }
      );
    }

    const url = new URL(request.url);
    const c = getConfig(env);
    const parts = url.pathname
      .split('/')
      .filter(Boolean)
      .map((p) => decodeURIComponent(p).replace(/\.json$/, ''));

    // Landing page
    if (parts.length === 0) {
      const manifestUrl = `${url.origin}/manifest.json`;
      return new Response(
        `${c.listName} addon is running.\n\nManifest URL:\n${manifestUrl}\n\nInstall in Stremio:\n${manifestUrl.replace(/^https?:/, 'stremio:')}\n`,
        { headers: { ...CORS, 'Content-Type': 'text/plain' } }
      );
    }

    if (parts[0] === 'manifest') return json(manifest(c));

    // Diagnostics: episode count, where the list came from, and the last Trakt error
    if (parts[0] === 'status') {
      const { items, source, fetchedAt, traktItems, error } = await loadList(env);
      return json(
        {
          list: `${c.user}/${c.list}`,
          episodes: items.length,
          source,
          fetchedAt: fetchedAt ? new Date(fetchedAt).toISOString() : null,
          traktItems,
          error,
        },
        0
      );
    }

    // Optional: /refresh/<REFRESH_TOKEN> forces a re-fetch from Trakt
    if (parts[0] === 'refresh' && env.REFRESH_TOKEN && parts[1] === env.REFRESH_TOKEN) {
      const items = await getItems(env, { force: true });
      return json({ refreshed: true, episodes: items.length }, 0);
    }

    // Catalog: one tile per episode
    if (parts[0] === 'catalog' && parts[1] === 'series' && parts[2] === CATALOG_ID) {
      const items = await getItems(env);
      return json({ metas: items.map((it) => buildPreview(c, it)) });
    }

    // Meta: the detail page behind a tile
    if (parts[0] === 'meta' && parts[1] === 'series' && parts[2]?.startsWith(ID_PREFIX)) {
      const [imdb, season, number] = parts[2].slice(ID_PREFIX.length).split(':');
      const items = await getItems(env);
      const found = items.find(
        (it) => it.imdb === imdb && String(it.season) === season && String(it.number) === number
      );
      const it = found || { imdb, season: Number(season), number: Number(number) };
      return json({ meta: buildMeta(c, it, items) });
    }

    return new Response('Not found', { status: 404, headers: CORS });
  },
};
