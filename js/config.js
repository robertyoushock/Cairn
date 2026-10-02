// Address of Cairn's helper on Cloudflare Workers (worker/relay.js). An empty string turns the helper off;
// everything still works except DeFlock cameras and short Google Maps links.
// This is an address, not a secret. Secrets (the routing key) live only inside Cloudflare.
export const RELAY_URL = 'https://cairn-relay.robertyoushock.workers.dev';
