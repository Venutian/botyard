# Botyard on Cloudflare (optional)

One way to reach your yard away from home with nothing to switch on in the phone: a Cloudflare Worker
on two names of a domain you own, for example `studio.example.org` for the phone's door and
`play.example.org` for playable builds. You need a Cloudflare account and a domain on it. The private
way, with nobody in between, is WireGuard (`tools/away.mjs`, see the front-page README).

The computer runs a Cloudflare Tunnel with no public address (`cloudflared`, kept running by Botyard's
timetable as the helper `edge`). Only this Worker reaches through it, over Workers VPC. It lets a
request through only with the gate secret, which the door hands to phones that already hold a key, and
it accepts a build link only when the door signed it for that build. Everything else gets a 404 at
Cloudflare and never touches the computer. The door still checks the phone's key on every request.

Cloudflare can read what passes through it, because HTTPS ends there.

## Setting it up

From this folder, with wrangler signed in to your account:

1. Put your two names in `wrangler.json` in place of `studio.example.org` and `play.example.org`.
2. `wrangler tunnel create botyard`, then save its run token as `TUNNEL_TOKEN=...` in
   `$BOTYARD_HOME/config/edge-tunnel.env` (mode 600; `BOTYARD_HOME` is `~/.botyard` unless you chose
   another). Botyard's timetable starts the tunnel once that file is there.
3. `wrangler vpc service create botyard-door --type http --tunnel-id <id> --ipv4 127.0.0.1 --http-port 5288`,
   and the same as `botyard-play` for port 5290. Put both service ids in `wrangler.json`.
4. Write `$BOTYARD_HOME/config/edge.json` (mode 600) with `studio` and `play` (your two addresses,
   with `https://`) and a `gate` of 64 hex characters (`openssl rand -hex 32`).
5. `wrangler deploy`, then pipe the same gate into `wrangler secret put GATE`.
6. To pair a phone that is away from home, `npm run pair -- --edge` puts this way in the pairing code,
   so the phone can reach the door before it has ever been home (`--link` prints it as a link too).

`wrangler types` writes `worker-configuration.d.ts` for type checking: `tsc -p tsconfig.json`.
