# Stremio Treehouse of Horror

A [Stremio](https://www.stremio.com/) addon that turns a public Trakt list of
individual episodes into a catalog with **one tile per episode**. This repo's
`wrangler.toml` points it at the list [`juicyj92/simpsons-halloween`](https://trakt.tv/users/juicyj92/lists/simpsons-halloween),
which collects The Simpsons "Treehouse of Horror" episodes.

It runs on Cloudflare Workers and caches the Trakt list in Workers KV.

## Contents

- [How it works](#how-it-works)
- [Endpoints](#endpoints)
- [Project layout](#project-layout)
- [Configuration](#configuration)
- [Setup and deployment](#setup-and-deployment)
- [Installing in Stremio](#installing-in-stremio)
- [Testing](#testing)
- [Automated tests](#automated-tests)
- [Refreshing the list early](#refreshing-the-list-early)
- [Local development](#local-development)
- [Limitations](#limitations)
- [License](#license)

## How it works

1. The catalog endpoint fetches the Trakt list (all pages, in Trakt rank order)
   and returns one tile per episode.
2. Each tile has the ID `halloween:<imdb>:<season>:<episode>`. Opening it
   goes straight to that episode's streams (`behaviorHints.defaultVideoId`).
3. With `PLAY_THROUGH_LIST = "true"`, behind every tile is the **whole list
   as one playlist**: the detail page
   lists every episode in Trakt order, numbered Episode 1..n, so Stremio's
   next-episode button and binge watching move through the list. Each video
   keeps the real IMDb episode ID (`<imdb>:<season>:<episode>`), so stream
   addons such as AIOStreams resolve it like any normal episode. The real
   `SxxEyy` code is shown in each episode's description.
4. The list is cached in KV for 7 days (configurable). If Trakt fails, the
   last cached copy is served instead of an empty catalog.

## Endpoints

| Endpoint | Returns |
|---|---|
| `/` | Plain-text page with the manifest URL and a `stremio://` install link |
| `/manifest.json` | Addon manifest with one `series` catalog |
| `/catalog/series/trakt-episode-list.json` | One tile per list episode, in Trakt order |
| `/meta/series/halloween:<imdb>:<s>:<e>.json` | The one-episode series behind a tile |
| `/status` | Episode count, where the list came from (cache or Trakt) and the last Trakt error. Use it when the catalog is empty |
| `/refresh/<REFRESH_TOKEN>` | Optional. Forces a re-fetch from Trakt |

## Project layout

```
.
├── src/worker.js     # The whole addon: config, Trakt fetch, KV cache, routing
├── test/             # Unit tests (node --test)
├── .github/workflows # CI: runs the tests on pull requests
├── wrangler.toml     # Worker name, plain config vars, KV binding
├── package.json      # Wrangler dev dependency and npm scripts
└── README.md
```

## Configuration

### Plain variables (`wrangler.toml` → `[vars]`)

| Variable | Required | Value in this repo | Notes |
|---|---|---|---|
| `TRAKT_USER` | Yes | `juicyj92` | Trakt username that owns the list |
| `TRAKT_LIST` | Yes | `simpsons-halloween` | List slug |
| `LIST_NAME` | Yes | `Simpsons Halloween` | Catalog name shown in Stremio |
| `CACHE_DAYS` | No | `7` | How long the cached list is considered fresh. Defaults to `7` |
| `PLAY_THROUGH_LIST` | No | `true` | `true`: each tile's page holds the whole list, so next episode and binge watching move through it. Anything else: each tile has only its own episode and playback stops after it |
| `STILL_URL_TEMPLATE` | No | Not set | Uses `{imdb}`, `{season}`, `{episode}`. Defaults to Metahub episode stills; set to an empty string to use the show poster instead |

The Worker has no built-in values for the three required variables. If any is
missing, every request returns HTTP 500 with a JSON error naming what is missing.

### Secrets (Worker → Settings → Variables and Secrets)

| Secret | Required | Notes |
|---|---|---|
| `TRAKT_CLIENT_ID` | Yes | Client ID of your Trakt API app |
| `REFRESH_TOKEN` | No | Any long random string. Enables `/refresh/<token>` |

Store these as the **Secret** type so redeploys don't remove them, and never
commit them. The addon does not use your Trakt Client *Secret*.

### KV binding

| Binding | Purpose |
|---|---|
| `CACHE` | Stores the list under the key `list:<user>:<list>` |

## Setup and deployment

### 1. Prepare Trakt

1. Make sure the list is **Public**.
2. Create an app at <https://trakt.tv/oauth/applications>
   (redirect URI: `urn:ietf:wg:oauth:2.0:oob`) and copy its **Client ID**.
3. Set `TRAKT_USER`, `TRAKT_LIST` and `LIST_NAME` in `wrangler.toml` `[vars]`
   to match your list.

### 2. Create the KV namespace

`wrangler.toml` already points at this project's namespace
(`stremio-treehouse-of-horror-CACHE`). If you deploy to a different
Cloudflare account, create your own and put its `id` in `wrangler.toml`:

```sh
npm install
npx wrangler kv namespace create CACHE
```

### 3. Deploy from GitHub

In the Cloudflare dashboard go to **Workers & Pages → Create → Import a
repository**, pick this repo and keep the default deploy command
(`npx wrangler deploy`). Every push to `main` then redeploys automatically.

To deploy once from your machine instead, run `npm run deploy`.

### 4. Add the secrets

In the dashboard: **Worker → Settings → Variables and Secrets → Add**, type
**Secret**. Or from the terminal:

```sh
npx wrangler secret put TRAKT_CLIENT_ID
npx wrangler secret put REFRESH_TOKEN   # optional
```

## Installing in Stremio

This addon only provides the catalog and episode pages. To actually play
episodes you also need a **stream addon** installed, such as AIOStreams.

### Find your manifest URL

Open `https://<your-worker>.workers.dev/` in a browser. The page shows:

- the manifest URL: `https://<your-worker>.workers.dev/manifest.json`
- a one-click install link: `stremio://<your-worker>.workers.dev/manifest.json`

### Option A: one-click link (desktop)

With the Stremio desktop app installed, open the `stremio://` link from the
landing page. Stremio opens the addon page; click **Install**.

### Option B: paste the URL (desktop, web or Android)

1. Open Stremio (the app, or <https://web.stremio.com>) and sign in.
2. Go to **Addons**.
3. Paste the manifest URL into the search box at the top of the Addons page
   and press Enter.
4. Click **Install** on the addon that appears.

Because addons are saved to your Stremio account, installing it once makes it
available on every device signed in to that account.

### Option C: through AIOStreams

If you manage your addons with AIOStreams, add the manifest URL there as a
**catalog** addon instead, and reinstall your AIOStreams manifest in Stremio
if prompted.

### Where to find it

After installing, the **Simpsons Halloween** row (or whatever `LIST_NAME` is
set to) appears on the Stremio **Board** and under **Discover → Series**.
Open a tile, pick the single episode, and your stream addon lists sources.

### Uninstalling

Go to **Addons → Installed**, find the addon and click **Uninstall**.

## Testing

1. Open `/manifest.json` and confirm it loads.
2. Open `/catalog/series/trakt-episode-list.json` and check your episodes are listed.
3. In Stremio, open one tile (S02E03 is a good first test) and press play.
   Streams should appear.
4. Open one still image URL from the catalog output in a browser. If it
   returns 404, change `STILL_URL_TEMPLATE` or set it to an empty string.

## Automated tests

Unit tests live in `test/` and use Node's built-in test runner, so they need
no extra dependencies. They mock Trakt and KV and cover the manifest, catalog,
meta, refresh and cache paths, plus the missing-config error.

```sh
npm test
```

GitHub Actions runs them on every pull request and every push to `main`
(see `.github/workflows/test.yml`).

## Refreshing the list early

Either visit `/refresh/<REFRESH_TOKEN>`, or delete the KV entry
`list:<user>:<list>` in the Cloudflare dashboard.

## Local development

```sh
npm install
echo 'TRAKT_CLIENT_ID=your-client-id' > .dev.vars   # git-ignored
npm run dev
```

Then open <http://localhost:8787/manifest.json>.

## Limitations

- New list items appear only after the cache expires, unless you refresh it.
- Episode stills rely on a third-party URL pattern (Metahub).
- Auto-playing the next episode is up to Stremio: turn on its binge-watching
  setting, and Stremio only picks the next stream automatically when it has
  the same `bingeGroup` as the current one (set by your stream addon, e.g.
  AIOStreams). Otherwise you get the next-episode prompt and choose a stream.
- Watch progress is tracked per tile, so the same episode watched from two
  different tiles counts separately.

## License

[MIT](LICENSE)
