# Cairn helper (Cloudflare Worker)

Deployed at `https://cairn-relay.robertyoushock.workers.dev` on Robert's Cloudflare account, **Workers Free plan**.
Keep it on Free: over the daily allowance it returns errors, it never bills.

What it does: fetches DeFlock's camera file (which blocks browsers), expands short Google Maps links, and can
proxy OpenRouteService directions if a key is added. See the comments at the top of `relay.js`.

## Updating it

The code was pasted into the Cloudflare dashboard editor (Workers & Pages, cairn-relay, Edit code). After changing
`relay.js` here, paste the new version there and press Deploy. Or, with Node installed: `npx wrangler deploy` from
this folder.

## Optional: routing key

Routes already work without a key (FOSSGIS OSRM). For a second provider, create a free key at openrouteservice.org
and add it in Cloudflare under the worker's Settings, Variables and Secrets, as a **Secret** named `ORS_KEY`.
Never put the key in this repo.

## If the site moves

Add the new site address to `ALLOWED_ORIGINS` in `relay.js`, or every call will be refused.
