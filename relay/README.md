# CircuitPilot relay (Cloudflare Worker)

The web version of CircuitPilot runs entirely in the browser from GitHub Pages. A few services it uses do not accept
requests from other websites (no CORS): the JLCPCB parts catalogue, the EasyEDA part library, DuckDuckGo search, and
ordinary web pages and datasheets (for the AI's `web_fetch`). This relay forwards just those requests. It runs on
Cloudflare's free plan (100,000 requests a day) and stores nothing.

It only answers the websites listed in `ALLOWED_ORIGINS` (`wrangler.toml`) and only forwards to the fixed services
above (`web_fetch` is limited to public http(s) addresses). **It handles no API keys:** AI providers are called straight
from the browser, and providers that refuse browser requests (Ollama Cloud, NVIDIA …) and Brave search work only in the
desktop version, where requests leave from the user's own PC.

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
