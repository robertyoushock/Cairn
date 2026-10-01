# Cairn relay (optional)

Only needed for sources marked `needsRelay` in `data/catalog.json` (today: DeFlock cameras).

1. Free Cloudflare account, then `npm i -g wrangler && wrangler login`
2. In this folder: `wrangler deploy`
3. Put the printed URL in `js/config.js` as `RELAY_URL`, commit, push.

It only fetches hosts listed in `ALLOWED_HOSTS` and only answers the sites in `ALLOWED_ORIGINS`.
