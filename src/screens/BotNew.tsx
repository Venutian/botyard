/** Add a bot: start from nothing or from a template, fill the same form the editor shows, then write its instructions. */
import { useMemo, useState } from 'react';
import { View } from 'react-native';
import { addBot, BotFields, Connection, getNewBot, getSetup, NewBotChoices } from '../api';
import { Nav } from '../crew';
import { useLook } from '../theme/prefs';
import { tell } from '../ui/ask';
import { leaving, useAct, useLeaveGuard } from '../ui/form';
import { Button, Group, Label, Txt } from '../ui/kit';
import { Line, Page, Tag, useLoad } from '../ui/page';
import { BotForm, Draft, draftOf, draftProblem, fieldsOf, Ready } from './BotEdit';

/** A blank bot's starting fields, or a template's. */
function startFields(d: NewBotChoices, from: string): BotFields {
  const base: BotFields = { name: '', title: '', does: '', role: 'general', reportsTo: d.lead || '', ai: 'free', model: 'auto', effort: '', minutes: 60, turns: null, atOnce: 1, mayNot: ['push'] };
  const f = d.templates.find((x) => x.id === from)?.fields;
  if (!f) return base;
  return { ...base, ...f, reportsTo: f.role === 'ceo' ? '' : d.lead || '', effort: f.effort || '', turns: f.turns ?? null, atOnce: f.atOnce || 1 };
}

export function BotNewScreen({ from, connection, nav }: { from?: string; connection: Connection; nav: Nav }) {
  const { t } = useLook();
  const { data, error, load } = useLoad(() => getNewBot(connection), [connection]);
  const setup = useLoad(() => getSetup(connection).catch(() => null), [connection]);
  const [picked, setPicked] = useState<string | null>(from ?? null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const { busy, run } = useAct();

  const start = useMemo(() => (data && picked !== null ? startFields(data, picked) : null), [data, picked]);
  const shown = draft ?? (start ? draftOf(start) : null);
  useLeaveGuard('botNew', Boolean(draft), nav.back, 'This bot has not been added yet.');
  const ready = useMemo<Ready | null>(() => (setup.data?.available ? Object.fromEntries(setup.data.rows.map((r) => [r.id, r.state])) : null), [setup.data]);
  const template = data?.templates.find((x) => x.id === picked);
  const problem = shown ? draftProblem(shown) : '';
  const sets = data ? [...new Set(data.templates.map((x) => x.setName))] : [];

  const add = () => {
    if (!data || !shown) return;
    run('add', async () => {
      const made = await addBot(connection, { ...fieldsOf(shown, data.choices), ...(picked ? { from: picked } : {}) });
      leaving.clear();
      if (made.paused) {
        const needs = data.choices.ais.find((a) => a.id === made.needs)?.name;
        tell(`${made.name} was added, switched off`, needs ? `It is switched on by itself once ${needs} is signed in. Setup shows how.` : 'Switch it on from its page when you want it to take work.');
      }
      nav.replace({ name: 'botRules', botId: made.id, botName: made.name });
    }, 'The bot was not added');
  };

  // The list to pick from, unless the screen was opened on a template or on blank.
  if (picked === null) {
    return (
      <Page title="Add a bot" note="Start from nothing, or from a bot that is already written." onBack={nav.back} onRefresh={load} error={error} loading={!data}>
        {data ? (
          <>
            <Group>
              <Line title="A blank bot" detail="You say what it is for and write its instructions." right={<Tag text="Blank" color={t.ink3} />} onPress={() => setPicked('')} last />
            </Group>
            {sets.map((name) => (
              <View key={name}>
                <Label>{name}</Label>
                <Group>
                  {data.templates.filter((x) => x.setName === name).map((x, index, all) => (
                    <Line key={x.id} title={x.name} detail={x.does || x.title} note={x.needs ? `${x.aiName}, off until signed in` : x.aiName} onPress={() => setPicked(x.id)} last={index === all.length - 1} />
                  ))}
                </Group>
              </View>
            ))}
            {sets.length ? null : <Txt color={t.ink2}>This copy of Botyard ships no templates yet. Start from a blank bot.</Txt>}
          </>
        ) : null}
      </Page>
    );
  }

  const back = () => {
    // Opened on the list: step back to it, asking first when something was typed.
    if (from === undefined && !draft) setPicked(null);
    else nav.back();
  };
  return (
    <Page title={template ? `Add ${template.name}` : 'Add a blank bot'} note={template ? 'Change anything before it is added. Its instructions come with it.' : 'You write its instructions in the next step.'} onBack={back} error={error} loading={!data}>
      {data && shown ? (
        <>
          <BotForm draft={shown} set={setDraft} choices={data.choices} ready={ready} adding />
          <View style={{ gap: 10, marginTop: 20 }}>
            {draft && problem ? <Txt size={13} color={t.bad}>{problem}</Txt> : null}
            <Button label="Add the bot" busy={busy === 'add'} disabled={Boolean(problem) || Boolean(busy)} onPress={add} />
            <Txt size={12} color={t.ink3}>It is added and its instructions open, ready to read or write.</Txt>
          </View>
        </>
      ) : null}
    </Page>
  );
}
