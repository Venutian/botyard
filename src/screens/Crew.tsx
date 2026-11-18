import { Connection, CrewBot, getBots, RunRow } from '../api';
import { Nav } from '../crew';
import { Theme, useLook } from '../theme/prefs';
import { BOT_WORDS, DESCRIBE } from '../ui/describe';
import { GlassButton, Group, Label, Txt, Words } from '../ui/kit';
import { ago, Line, Page, Tag, tokens, useLoad } from '../ui/page';

const REFRESH_MS = 20_000;

export const stateTone = (status: string, t: Theme) => (status === 'running' ? t.accentText : status === 'error' ? t.bad : status === 'paused' ? t.warn : t.ink3);
export const wasteWords = (share: number) => `${Math.round(share * 100)} % of runs wasted`;
/** What a bot thinks on, and why only when it is not the plain reason (its own subscription, the free list). */
export function engineLine({ engine, model, why }: { engine: string; model: string; why: string }) {
  const plain = !why || why === engine || why === `${engine} subscription` || why === 'Free models, the best that answers first';
  return { what: model || engine, why: plain ? '' : why };
}

/** One run in a list: how it ended and on which job, why it failed in plain words, and when. */
export function RunLine({ run, showBot, last, onOpen }: { run: RunRow; showBot?: boolean; last?: boolean; onOpen: () => void }) {
  const { t } = useLook();
  const job = run.job ? `${run.job.ref} ${run.job.title}` : 'No job';
  return (
    <Line
      title={showBot ? `${run.bot}: ${job}` : job}
      detail={run.failed && run.why !== run.state ? run.why : undefined}
      tone={t.bad}
      note={[ago(run.at), run.tokens ? `${tokens(run.tokens)} tokens` : ''].filter(Boolean).join(', ')}
      right={<Tag text={run.state} color={run.failed ? t.bad : run.status === 'running' ? t.accentText : t.ink3} />}
      last={last}
      onPress={onOpen}
    />
  );
}

function BotLine({ bot, last, onOpen }: { bot: CrewBot; last: boolean; onOpen: () => void }) {
  const { t } = useLook();
  const flagged = bot.waste?.flagged;
  const { what, why } = engineLine(bot);
  return (
    <Line
      title={bot.name}
      detail={[bot.resting ? bot.state : '', what, why].filter(Boolean).join('. ')}
      note={[bot.tokensToday ? `${tokens(bot.tokensToday)} today` : '', bot.tokensWeek ? `${tokens(bot.tokensWeek)} this week` : ''].filter(Boolean).join(', ')}
      alert={flagged ? wasteWords(bot.waste!.share) : undefined}
      right={<Tag text={bot.resting ? 'Resting' : bot.state} color={stateTone(bot.status, t)} />}
      last={last}
      onPress={onOpen}
    />
  );
}

/** The crew at a glance: who is working, resting or stuck, on what engine and why, and who wastes runs. */
export function BotsScreen({ connection, nav }: { connection: Connection; nav: Nav }) {
  const { t } = useLook();
  const { data, error, load } = useLoad(() => getBots(connection), [connection], REFRESH_MS);
  const wasteful = data?.bots.filter((b) => b.waste?.flagged) ?? [];
  return (
    <Page title="Bots" onBack={nav.back} onRefresh={load} error={error} loading={!data} right={<GlassButton icon="plus" label="Add a bot" hint={DESCRIBE.icon.addBot} onPress={() => nav.push({ name: 'botNew' })} />}>
      {wasteful.length ? (
        <Txt size={14} color={t.bad}>
          {wasteful.map((b) => `${b.name}: ${wasteWords(b.waste!.share)}${b.waste!.causes[0] ? ` (${b.waste!.causes[0].text})` : ''}`).join('. ')}.
        </Txt>
      ) : null}
      {data ? (
        <>
          <Label>{`${data.bots.filter((b) => b.status === 'running').length} working, ${data.bots.filter((b) => b.status === 'paused').length} resting or paused`}</Label>
          <Words from={BOT_WORDS} words={data.bots.map((b) => (b.resting ? 'Resting' : b.state))} />
          {data.bots.length ? (
            <Group>
              {data.bots.map((bot, index) => <BotLine key={bot.id} bot={bot} last={index === data.bots.length - 1} onOpen={() => nav.push({ name: 'bot', botId: bot.id })} />)}
            </Group>
          ) : <Txt color={t.ink2}>This studio has no bots yet. Add one below, or add the default crew from the first run in Setup.</Txt>}
          <Group>
            <Line title="Add a bot" detail="Start from nothing, or from a bot that is already written" onPress={() => nav.push({ name: 'botNew' })} last />
          </Group>
          {data.wasteStale ? <Txt size={12} color={t.ink3}>The waste count is more than two hours old{data.wasteAt ? ` (${ago(data.wasteAt)})` : ''}.</Txt> : null}
        </>
      ) : null}
    </Page>
  );
}
