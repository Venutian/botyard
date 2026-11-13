/** The ways the app can reach the PC, and what to say when none of them answer. */
/** Cloudflare's address for the PC, and the gate secret its Worker asks for. */
export type Edge = { host: string; gate: string };
/** The addresses the app knows: home Wi-Fi, the WireGuard tunnel and Cloudflare. */
export type ConnectionWays = { host: string; away?: string; edge?: Edge };

/** One way to the PC: an address, and any header that way needs, such as Cloudflare's gate. */
export type Route = { name: 'home' | 'away' | 'edge'; base: string; headers: Record<string, string> };

export type Way = Route['name'];

export const normalizeHost = (host: string) => {
  const trimmed = host.trim().replace(/\/+$/, '');
  return /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
};

/** How a way is said on screen. */
export const wayLabel = (name: Way) => (name === 'home' ? 'home Wi-Fi' : name === 'away' ? 'WireGuard' : 'Cloudflare');

/** Home Wi-Fi first in the list, then the WireGuard tunnel, then Cloudflare, each once. */
export function ways(c: ConnectionWays): Route[] {
  const all: Route[] = [
    { name: 'home', base: normalizeHost(c.host), headers: {} },
    ...(c.away ? [{ name: 'away' as const, base: normalizeHost(c.away), headers: {} }] : []),
    ...(c.edge ? [{ name: 'edge' as const, base: c.edge.host, headers: { 'X-Botyard-Gate': c.edge.gate } }] : []),
  ];
  return all.filter((way, index) => all.findIndex((other) => other.base === way.base) === index);
}

/** Names every way the app tried, so a failure says what was checked rather than only that it failed. */
export function unreachable(c: ConnectionWays): string {
  const tried = ways(c).map((way) => wayLabel(way.name));
  const list = tried.length > 1 ? `${tried.slice(0, -1).join(', ')} or ${tried[tried.length - 1]}` : tried[0];
  const advice = c.edge
    ? 'Check the PC is on and the phone has internet.'
    : c.away
      ? 'Check the PC is on, and turn WireGuard on when you are away from home.'
      : 'Check the PC is on and on this network.';
  return `Cannot reach the studio on ${list}. ${advice}`;
}

/** How long each way waits for the ones before it, so home Wi-Fi wins when it is there. */
export const HEAD_START_MS = 400;

/**
 * Knocks each way in turn and keeps the first to answer. Each starts after a short head start for
 * the ones before it, or at once when all of those have failed, so traffic stays in the house when
 * it can and through WireGuard before Cloudflare. A way that fails hands over to the next at once.
 */
export function pickWay(all: Route[], knock: (way: Route) => Promise<Route>, headStartMs = HEAD_START_MS): Promise<Route> {
  return new Promise<Route>((resolve, reject) => {
    const failed = all.map(() => false);
    const starts: (() => void)[] = [];
    all.forEach((way, index) => {
      let started = false;
      starts[index] = () => {
        if (started) return;
        started = true;
        knock(way).then(resolve, () => {
          failed[index] = true;
          if (failed.every(Boolean)) reject(new Error('Cannot reach the studio'));
          const next = failed.indexOf(false);
          if (next > index && failed.slice(0, next).every(Boolean)) starts[next]();
        });
      };
      setTimeout(starts[index], headStartMs * index);
    });
  });
}
