# CircuitPilot relay (Cloudflare Worker)

The web version of CircuitPilot runs entirely in the browser from GitHub Pages. A few services it uses do not accept
requests from other websites (no CORS): the JLCPCB parts catalogue, the EasyEDA part library, DuckDuckGo search, and
ordinary web pages and datasheets (for the AI's `web_fetch`). This relay forwards just those requests. It runs on
Cloudflare's free plan (100,000 requests a day) and stores nothing.

It only answers the websites listed in `ALLOWED_ORIGINS` (`wrangler.toml`) and only forwards to the fixed services
above (`web_fetch` is limited to public http(s) addresses). **Your own API keys never reach it:** a visitor who uses their own key calls the provider straight from the browser. The only keys the relay holds are the ones the owner adds for the **shared AI** (below), and they stay in its key-value store.

## Deploy (about 2 minutes)

You need Node.js and a free Cloudflare account.

```bash
cd relay
npx wrangler login
npx wrangler deploy
```

`wrangler login` opens the browser to sign in to Cloudflare. `wrangler deploy` prints the relay address, for example
`https://circuitpilot-relay.your-name.workers.dev`.

Then put that address in `js/config.js` (`relay: '…'`) so every visitor of the web version uses it, or paste it in the
app under **⚙ Settings → Relay address** to use it only in your browser.

## Forks

If you host your own copy on GitHub Pages, add its address to `ALLOWED_ORIGINS` in `wrangler.toml`
(for example `https://your-name.github.io`) and deploy again.

## Check that it works

Open `https://circuitpilot-relay.your-name.workers.dev/health` in the browser. It answers
`{"ok":true,"service":"circuitpilot-relay"}`.

## Shared AI (pool of the owner's accounts)

Visitors who sign in with GitHub can use the **CircuitPilot shared AI** without a key of their own, within a daily limit.
The relay (`pool.js`) holds the provider accounts the owner adds and tries them in order: when one runs out of quota or
fails, it is put to rest and the next one answers. Users sign in with GitHub, so the daily limit is per GitHub account.

One-time setup (after `wrangler deploy`):

```bash
cd relay
npx wrangler kv namespace create POOL
```

Paste the printed id into `wrangler.toml` (`[[kv_namespaces]]` → `id`), then:

```bash
npx wrangler secret put ADMIN_LOGIN     # your GitHub login: the only account that can open /admin
npx wrangler deploy
```

Open `https://<your-relay>/admin`, paste a GitHub token of the admin account, and add accounts (provider, model, key).
The admin page shows only the last four characters of a key. Limits (requests per user per day, output tokens) are
on the same page.

Before adding accounts: check each provider's terms. Free-tier keys and plans often forbid sharing the key with other
people, and paid keys are charged to you for every request made through the pool.
