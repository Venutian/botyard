import { useCallback, useEffect, useState } from 'react';
import { ChatBot, Connection, getChats, NeedsYou } from './api';

const REFRESH_MS = 20_000;

export type Crew = { bots: ChatBot[] | null; error: string; reload: () => Promise<void> };

/** The bots and their latest messages, shared by every screen that shows them. */
export function useCrew(connection: Connection | null): Crew {
  const [bots, setBots] = useState<ChatBot[] | null>(null);
  const [error, setError] = useState('');

  const reload = useCallback(async () => {
    if (!connection) return;
    try {
      const answer = await getChats(connection);
      setBots(answer.bots);
      // The door keeps the last list it had when the engine is down, and says so.
      setError(answer.error || '');
    } catch (err) {
      setError((err as Error).message);
    }
  }, [connection]);

  useEffect(() => {
    reload();
    const timer = setInterval(reload, REFRESH_MS);
    return () => clearInterval(timer);
  }, [reload]);

  return { bots, error, reload };
}

export type Route =
  | { name: 'chat'; botId: string }
  | { name: 'job'; id: string }
  | { name: 'changes'; id: string }
  /** Mark exact places in a job's work, or in what a bot said in its chat, and send every mark at once. */
  | { name: 'review'; job?: string; bot?: string }
  | { name: 'routines' }
  | { name: 'models' }
  | { name: 'improvements' }
  | { name: 'devices' }
  | { name: 'new' }
  | { name: 'bot'; botId: string }
  | { name: 'bots' }
  | { name: 'runs'; bot?: string }
  | { name: 'run'; id: string }
  | { name: 'jobs'; project?: string; bot?: string }
  | { name: 'projects' }
  | { name: 'project'; id: string }
  | { name: 'library' }
  | { name: 'company' }
  | { name: 'connectors' }
  | { name: 'connector'; id: string }
  | { name: 'botEdit'; botId: string }
  /** `botName` titles the page for a bot the crew list has not caught up with yet. */
  | { name: 'botRules'; botId: string; botName?: string }
  /** `from` starts on a template instead of the list to pick from. */
  | { name: 'botNew'; from?: string }
  | { name: 'setup' }
  /** `step` opens that step instead of the next one left. */
  | { name: 'firstRun'; step?: string }
  | { name: 'projectNew' }
  | { name: 'projectEdit'; id: string }
  | { name: 'routine'; id: string };
export type Tab = 'home' | 'studio' | 'style';
/**
 * The one bot the owner chats with on the phone: the studio's lead, the bot whose role is `lead`.
 * Everyone else is reached through jobs. A studio with no lead (or a door too old to say) has none,
 * and then every bot is offered instead.
 */
export const leadOf = <B extends { id: string; role?: string }>(bots: B[] | null) => bots?.find((bot) => bot.role === 'lead') ?? null;
/** Who a job or routine can be given to by hand: everyone but the lead, who is the "decides" choice. */
export const handsOf = <B extends { id: string; role?: string }>(bots: B[] | null) => (bots ?? []).filter((bot) => bot.role !== 'lead');
/** `replace` swaps the top screen, and steps back instead when that route is already underneath. */
export type Nav = { push: (route: Route) => void; back: () => void; replace: (route: Route) => void };

/** A card that waits on the owner's answer: an approval or a question. */
export const isDecision = (n: Pick<NeedsYou, 'kind'>) => n.kind === 'approval' || n.kind === 'question';
/** The one Needs-you number everywhere: decision cards that are not archived. */
export const waitingCount = (items: Pick<NeedsYou, 'kind' | 'archived'>[]) => items.filter((n) => isDecision(n) && !n.archived).length;
