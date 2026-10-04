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
2. Each tile has the ID `halloween:<imdb>:<season>:<episode>` and opens a
   **one-episode series**.
3. That series' single video uses the real IMDb episode ID
   (`<imdb>:<season>:<episode>`), so stream addons such as AIOStreams resolve
   it like any normal episode.
4. The list is cached in KV for 7 days (configurable). If Trakt fails, the
   last cached copy is served instead of an empty catalog.

## Endpoints

| Endpoint | Returns |
|---|---|
| `/` | Plain-text page with the manifest URL and a `stremio://` install link |
| `/manifest.json` | Addon manifest with one `series` catalog |
| `/catalog/series/trakt-episode-list.json` | One tile per list episode, in Trakt order |
| `/meta/series/halloween:<imdb>:<s>:<e>.json` | The one-episode series behind a tile |
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

```sh
npm install
npx wrangler kv namespace create CACHE
```

Paste the returned `id` into `wrangler.toml`, replacing
`REPLACE_WITH_KV_NAMESPACE_ID`.

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

1. Open `https://<your-worker>.workers.dev/` to see the manifest URL.
2. Add `https://<your-worker>.workers.dev/manifest.json` to Stremio, or to
   AIOStreams as a catalog addon.

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
- Each tile is a one-episode series, so there is one extra tap before play.

## License

[MIT](LICENSE)
