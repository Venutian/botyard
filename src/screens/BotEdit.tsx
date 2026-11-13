/**
 * A bot's settings on the phone, saying the same as the PC's editor: who it is, which AI runs it, its
 * limits, what it may not do, its skills; then what is saved by itself (connectors, variables), and
 * removing it. A save sends only what changed.
 */
import { useMemo, useRef, useState } from 'react';
import { StyleSheet, TextInput, View } from 'react-native';
import {
  BotChange, BotChoices, BotFields, BotSettings, BotSkills, Connection, getBotSettings, getSetup, removeBot, removeBotVariable, saveBotSettings, setBotVariable,
} from '../api';
import { Nav } from '../crew';
import { portraitOf } from '../mascot/look';
import { useLook } from '../theme/prefs';
import { ask, tell } from '../ui/ask';
import { Choice, leaving, MONO, Small, useAct, useLeaveGuard } from '../ui/form';
import { Button, Chips, Field, Group, Label, Row, Toggle, Txt } from '../ui/kit';
import { Line, Page, plural, Tag, useLoad } from '../ui/page';

/** What the form holds while it is typed in: numbers stay text until they are sent. */
export type Draft = {
  name: string; title: string; does: string; role: string; reportsTo: string; ai: string; model: string; effort: string;
  minutes: string; turns: string; atOnce: string; mayNot: string; skillsMode?: BotSkills['mode']; skills: string[];
};
type Was = BotFields & { skills?: BotSkills | null };
/** Which AIs can run now, by their row in Setup. */
export type Ready = Record<string, string>;

const top = (mayNot: string[] | undefined) => (mayNot?.length ? mayNot[mayNot.length - 1] : 'push');

export const draftOf = (s: Was): Draft => ({
  name: s.name, title: s.title, does: s.does, role: s.role, reportsTo: s.reportsTo || '', ai: s.ai, model: s.model, effort: s.effort || '',
  minutes: String(s.minutes ?? ''), turns: s.turns == null ? '' : String(s.turns), atOnce: String(s.atOnce || 1), mayNot: top(s.mayNot),
  skillsMode: s.skills?.mode, skills: s.skills?.all.filter((k) => k.on).map((k) => k.name) ?? [],
});

/** The form as the fields the door takes. Effort and turns only where the AI has them. */
export function fieldsOf(d: Draft, choices: BotChoices): BotChange {
  const ai = choices.ais.find((a) => a.id === d.ai);
  return {
    name: d.name.trim(), title: d.title.trim(), does: d.does.trim(), role: d.role, reportsTo: d.reportsTo, ai: d.ai, model: d.model.trim(),
    minutes: Number(d.minutes), atOnce: Number(d.atOnce), mayNot: [d.mayNot],
    ...(ai?.effort ? { effort: d.effort } : {}),
    ...(ai?.turns ? { turns: d.turns.trim() === '' ? null : Number(d.turns) } : {}),
    ...(d.skillsMode ? { skills: d.skillsMode === 'list' ? d.skills : d.skillsMode } : {}),
  };
}

/** Only what differs from the bot as it was read: a save touches nothing else. */
export function changedFields(now: BotChange, was: Was): BotChange {
  const same = (a: unknown, b: unknown) => JSON.stringify(a ?? '') === JSON.stringify(b ?? '');
  const before: Record<string, unknown> = {
    name: was.name, title: was.title, does: was.does, role: was.role, reportsTo: was.reportsTo || '', ai: was.ai, model: was.model,
    minutes: was.minutes, atOnce: was.atOnce, mayNot: [top(was.mayNot)], effort: was.effort || '', turns: was.turns ?? null,
    skills: was.skills ? (was.skills.mode === 'list' ? was.skills.all.filter((k) => k.on).map((k) => k.name) : was.skills.mode) : undefined,
  };
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(now)) if (!same(value, before[key])) out[key] = value;
  // A new AI always comes with its model, and the old AI's effort means nothing there.
  if (out.ai) {
    out.model = now.model;
    if (now.effort !== undefined) out.effort = now.effort;
  }
  if (out.effort === '') delete out.effort;
  // The door changes a turn limit but does not take one off, as on the PC.
  if (out.turns === null) delete out.turns;
  return out as BotChange;
}

/** What stops the form being sent, in plain words; empty when it can go. */
export function draftProblem(d: Draft): string {
  if (!d.name.trim()) return 'Give the bot a name.';
  if (!d.ai) return 'Pick which AI runs it.';
  if (!d.model.trim()) return 'Pick a model, or write the id of another one.';
  const minutes = Number(d.minutes);
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 600) return 'A run may take between 1 and 600 minutes.';
  const atOnce = Number(d.atOnce);
  if (!Number.isInteger(atOnce) || atOnce < 1 || atOnce > 10) return 'It can do between 1 and 10 jobs at once.';
  if (d.turns.trim() && (!Number.isInteger(Number(d.turns)) || Number(d.turns) < 1 || Number(d.turns) > 2000)) return 'The most turns is between 1 and 2000, or empty for no limit.';
  return '';
}

const OTHER = '\u0000other';
const digits = (text: string) => text.replace(/\D/g, '');

/** The form both the editor and "Add a bot" show. `was` is the bot as it was read, so going back to its own AI brings its own model back. */
export function BotForm({ draft, set, choices, was, ready, adding, kept }: {
  draft: Draft; set: (next: Draft) => void; choices: BotChoices; was?: Was; ready?: Ready | null; adding?: boolean; kept?: boolean;
}) {
  const { t } = useLook();
  const ai = choices.ais.find((a) => a.id === draft.ai);
  const known = Boolean(ai?.models.some((m) => m.id === draft.model));
  const put = <K extends keyof Draft>(key: K) => (value: Draft[K]) => set({ ...draft, [key]: value });

  const pickAi = (id: string) => {
    if (id === draft.ai) return;
    const next = choices.ais.find((a) => a.id === id);
    const mine = was && id === was.ai;
    set({ ...draft, ai: id, model: mine ? was.model : next?.models[0]?.id ?? '', effort: mine ? was.effort || '' : '', turns: mine && was.turns != null ? String(was.turns) : next?.turns ? draft.turns : '' });
  };
  const aiTag = (setup: string) => {
    const state = ready?.[setup];
    if (!state) return undefined;
    if (state === 'ok') return <Tag text="Ready" color={t.good} />;
    if (state === 'unknown') return <Tag text="Installed" color={t.ink3} />;
    return <Tag text={state === 'missing' ? 'Not installed' : 'Not signed in'} color={t.warn} />;
  };
  const [first, ...more] = choices.mayNot;

  return (
    <>
      <Label>Who it is</Label>
      <View style={styles.stack}>
        <Field label="Name" value={draft.name} onChangeText={put('name')} maxLength={80} autoCorrect={false} placeholder="Builder" />
        <Field label="Title" value={draft.title} onChangeText={put('title')} maxLength={160} placeholder="A few words under its name" />
        <Field label="What it does" value={draft.does} onChangeText={put('does')} multiline maxLength={600} style={styles.does} textAlignVertical="top"
          placeholder="One or two lines. The bot that hands out work reads this to decide who gets a job." />
        <View style={styles.pick}>
          <Txt size={14} weight={600} color={t.ink2}>Kind of work</Txt>
          <Chips value={draft.role} options={choices.roles} onChange={put('role')} />
        </View>
        <View style={styles.pick}>
          <Txt size={14} weight={600} color={t.ink2}>Answers to</Txt>
          <Chips value={draft.reportsTo} options={[{ id: '', name: 'Nobody: it leads the crew' }, ...choices.bosses]} onChange={put('reportsTo')} />
        </View>
      </View>

      <Label>Which AI runs it</Label>
      <Group>
        {choices.ais.map((a, index) => (
          <Choice key={a.id} title={a.name} detail={a.about} active={draft.ai === a.id} right={aiTag(a.setup)} onPress={() => pickAi(a.id)} last={index === choices.ais.length - 1} />
        ))}
      </Group>
      {ai ? (
        <View style={[styles.stack, styles.under]}>
          <View style={styles.pick}>
            <Txt size={14} weight={600} color={t.ink2}>Model</Txt>
            <Chips value={known ? draft.model : OTHER} options={[...ai.models, { id: OTHER, name: 'Another model' }]} onChange={(id) => set({ ...draft, model: id === OTHER ? '' : id })} />
          </View>
          {known ? null : (
            <Field label="Its id, as the tool names it" value={draft.model} onChangeText={put('model')} maxLength={120} autoCapitalize="none" autoCorrect={false} spellCheck={false} placeholder="provider/model-name" style={MONO} />
          )}
          {ai.effort ? (
            <View style={styles.pick}>
              <Txt size={14} weight={600} color={t.ink2}>Effort</Txt>
              <Chips value={draft.effort} options={[{ id: '', name: "The tool's own" }, ...choices.efforts]} onChange={put('effort')} />
            </View>
          ) : null}
          {ai.turns ? <Field label="Most turns in one run" value={draft.turns} onChangeText={(text) => put('turns')(digits(text))} keyboardType="number-pad" maxLength={4} placeholder="No limit" /> : null}
          {ai.turns && was?.turns != null && was.ai === draft.ai && !draft.turns.trim() ? <Txt size={12} color={t.ink3}>{`A limit that is set can be changed here, but not taken off yet. It stays at ${was.turns}.`}</Txt> : null}
        </View>
      ) : <Txt size={13} color={t.ink2}>Pick which AI runs it first.</Txt>}
      {adding ? null : <Txt size={12} color={t.ink3}>Moving a bot to another AI keeps its instructions, variables and limits. Its next run starts a fresh conversation there.</Txt>}

      <Label>Limits</Label>
      <View style={styles.two}>
        <View style={styles.half}><Field label="Longest one run may take, in minutes" value={draft.minutes} onChangeText={(text) => put('minutes')(digits(text))} keyboardType="number-pad" maxLength={3} /></View>
        <View style={styles.half}><Field label="Jobs at once, side by side" value={draft.atOnce} onChangeText={(text) => put('atOnce')(digits(text))} keyboardType="number-pad" maxLength={2} /></View>
      </View>

      <Label>What it may not do</Label>
      <Group>
        <Choice title={first?.name ?? 'Push, merge, publish or delete'} detail={first?.about ?? 'Always on. Only you do these.'} active locked />
        <Choice title="Nothing more" detail="It may change files and commit its work." active={draft.mayNot === 'push'} onPress={() => put('mayNot')('push')} />
        {more.map((m, index) => (
          <Choice key={m.id} title={m.name} detail={m.about} active={draft.mayNot === m.id} onPress={() => put('mayNot')(m.id)} last={index === more.length - 1} />
        ))}
      </Group>
      {draft.ai && !kept && !adding ? <Txt size={12} color={t.ink3}>On Claude these are enforced by the tool itself. On the other AIs they are written into the bot's settings, and its instructions should say the same.</Txt> : null}

      {!adding && was?.skills && draft.skillsMode ? (
        <>
          <Label>Skills</Label>
          <Chips<BotSkills['mode']>
            value={draft.skillsMode}
            options={[{ id: 'set', name: 'What its job needs' }, { id: 'all', name: 'Every skill' }, ...(was.skills.all.length ? [{ id: 'list' as const, name: 'Only the ones I pick' }] : [])]}
            onChange={put('skillsMode')}
          />
          {draft.skillsMode === 'list' ? (
            <Group>
              {was.skills.all.map((k, index, all) => (
                <Row key={k.name} title={k.name} detail={k.about || undefined} last={index === all.length - 1}
                  right={<Toggle label={`Give it ${k.name}`} value={draft.skills.includes(k.name)} onChange={(on) => put('skills')(on ? [...draft.skills, k.name] : draft.skills.filter((name) => name !== k.name))} />} />
              ))}
            </Group>
          ) : null}
          <Txt size={12} color={t.ink3}>
            {was.skills.all.length ? `${was.skills.all.filter((k) => k.on).length} of ${was.skills.all.length} skills on the computer are given to it now. ` : 'No skills are on the computer yet. '}
            A skill is a folder of instructions a bot reads when a job calls for it.
          </Txt>
        </>
      ) : null}
    </>
  );
}

const LEVEL = { off: 'No', read: 'May look', write: 'May change things' } as const;
const VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Named values a bot's runs are given. A value is typed once, sent, and gone from the phone. */
function Variables({ connection, botId, variables, onChange }: { connection: Connection; botId: string; variables: BotSettings['variables']; onChange: (next: BotSettings['variables']) => void }) {
  const { t } = useLook();
  const { busy, run } = useAct();
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const valueBox = useRef<TextInput>(null);
  const replacing = variables.some((v) => v.name === name.trim());

  const send = () => {
    const key = name.trim();
    // The value leaves the screen before the request starts, and is never put back.
    const secret = value;
    setValue('');
    run('set', async () => {
      const answer = await setBotVariable(connection, botId, key, secret);
      onChange(answer.variables);
      setName('');
    }, 'The variable was not set');
  };
  const remove = (key: string) => ask(`Remove ${key}?`, 'Its runs are no longer given this value. The value itself cannot be read back, so keep a copy if you need it again.', 'Remove', () => {
    run(`remove:${key}`, async () => {
      const answer = await removeBotVariable(connection, botId, key);
      onChange(answer.variables ?? variables.filter((v) => v.name !== key));
    }, 'The variable was not removed');
  });

  return (
    <>
      <Label>Variables</Label>
      <Txt size={13} color={t.ink2}>Named values its runs are given, like a key for a service. A value is written once and never shown again, here or anywhere: replace it if it changes.</Txt>
      {variables.length ? (
        <Group>
          {variables.map((v, index) => (
            <View key={v.name} style={[styles.variable, index < variables.length - 1 && { borderBottomColor: t.line, borderBottomWidth: StyleSheet.hairlineWidth }]}>
              <View style={styles.variableHead}>
                <Txt size={14} weight={600} style={[MONO, styles.grow]} numberOfLines={1} selectable>{v.name}</Txt>
                <Tag text="Set" color={t.good} />
              </View>
              <View style={styles.acts}>
                <Small label="Replace" disabled={Boolean(busy)} onPress={() => { setName(v.name); valueBox.current?.focus(); }} />
                <Small label="Remove" danger disabled={Boolean(busy)} onPress={() => remove(v.name)} />
              </View>
            </View>
          ))}
        </Group>
      ) : <Txt color={t.ink2}>It has none. Add one below when a job needs a key or an address.</Txt>}
      <View style={[styles.stack, styles.under]}>
        <Field label="Name" value={name} onChangeText={setName} maxLength={64} autoCapitalize="characters" autoCorrect={false} spellCheck={false} placeholder="SHOP_API_KEY" style={MONO} />
        <Field ref={valueBox} label={replacing ? `New value for ${name.trim()}` : 'Value'} value={value} onChangeText={setValue} maxLength={8000} secureTextEntry autoCapitalize="none" autoCorrect={false} spellCheck={false}
          autoComplete="off" textContentType="none" importantForAutofill="no" placeholder="Written once, never shown" />
        {name.trim() && !VAR_NAME.test(name.trim()) ? <Txt size={12} color={t.bad}>A name is letters, digits and underscores, and does not start with a digit.</Txt> : null}
        <Button label={replacing ? 'Replace its value' : 'Set it'} kind="quiet" busy={busy === 'set'} disabled={!VAR_NAME.test(name.trim()) || !value || Boolean(busy)} onPress={send} />
      </View>
    </>
  );
}

export function BotEditScreen({ botId, connection, nav }: { botId: string; connection: Connection; nav: Nav }) {
  const { p, t } = useLook();
  const { data: s, error, load, setData } = useLoad(() => getBotSettings(connection, botId), [connection, botId]);
  const setup = useLoad(() => getSetup(connection).catch(() => null), [connection]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saved, setSaved] = useState(false);
  const { busy, run } = useAct();

  const shown = draft ?? (s ? draftOf(s) : null);
  const change = useMemo(() => (s && shown ? changedFields(fieldsOf(shown, s.choices), s) : {}), [s, shown]);
  const dirty = Boolean(draft) && Object.keys(change).length > 0;
  useLeaveGuard('botEdit', dirty, nav.back, 'The changes to this bot have not been saved.');

  const ready = useMemo<Ready | null>(() => (setup.data?.available ? Object.fromEntries(setup.data.rows.map((r) => [r.id, r.state])) : null), [setup.data]);
  const problem = shown ? draftProblem(shown) : '';
  const color = s ? portraitOf({ id: botId, name: s.name, look: s.look }, p.bots[botId]).colour : t.accent;

  const save = () => {
    if (!s || !shown) return;
    const send = () => run('save', async () => {
      await saveBotSettings(connection, botId, change);
      setData(await getBotSettings(connection, botId));
      setDraft(null);
      setSaved(true);
    }, 'The changes were not saved');
    const next = change.ai ? s.choices.ais.find((a) => a.id === change.ai) : null;
    if (next) ask(`Move ${s.name} to ${next.name}?`, 'Its next run starts a fresh conversation there. Its instructions, variables and limits stay.', `Move to ${next.name}`, send);
    else send();
  };

  const remove = () => {
    if (!s) return;
    const jobs = s.openJobs ? `Its ${plural(s.openJobs, 'open job')} ${s.openJobs === 1 ? 'stays' : 'stay'} open with nobody working on ${s.openJobs === 1 ? 'it' : 'them'} until you give ${s.openJobs === 1 ? 'it' : 'them'} to another bot.` : 'It has no open jobs.';
    const under = s.reports.length ? ` ${s.reports.join(', ')} will answer to nobody.` : '';
    ask(`Remove ${s.name}?`, `Any run it has going is stopped. ${jobs}${under} Its past jobs, runs and conversations stay in the studio's history. This cannot be undone here.`, 'Remove this bot', () => {
      run('remove', async () => {
        const gone = await removeBot(connection, botId);
        leaving.clear();
        tell(`${gone.name || s.name} was removed`, gone.openJobs ? `${plural(gone.openJobs, 'open job')} now ${gone.openJobs === 1 ? 'has' : 'have'} nobody working on ${gone.openJobs === 1 ? 'it' : 'them'}. Give ${gone.openJobs === 1 ? 'it' : 'them'} to another bot from Jobs.` : 'It left no open jobs behind.');
        // Its own page is gone with it, so step back past that too.
        nav.back();
        nav.back();
      }, 'The bot was not removed');
    });
  };

  return (
    <Page title={s ? `${s.name}: settings` : 'Settings'} note={s?.title || undefined} onBack={nav.back} onRefresh={dirty ? undefined : load} error={error} loading={!s}>
      {s && shown ? (
        <>
          <View style={[styles.suit, { backgroundColor: color, borderColor: t.plates && t.dark ? '#05070a' : t.ink }]} accessibilityElementsHidden importantForAccessibility="no" />
          {s.paused ? <Txt size={13} color={t.warn}>It is paused. Its settings can still be changed.</Txt> : null}
          <BotForm draft={shown} set={(next) => { setDraft(next); setSaved(false); }} choices={s.choices} was={s} ready={ready} kept={s.mayNotKept} />

          <View style={styles.saveBar}>
            {dirty ? <Tag text="Changed since last save" color={t.warn} /> : saved ? <Tag text="Saved" color={t.good} /> : null}
            {dirty && problem ? <Txt size={13} color={t.bad}>{problem}</Txt> : null}
            <Button label="Save changes" busy={busy === 'save'} disabled={!dirty || Boolean(problem) || Boolean(busy)} onPress={save} />
            {dirty ? <Button label="Put it back as it was" kind="quiet" disabled={Boolean(busy)} onPress={() => setDraft(null)} /> : null}
          </View>

          <Label>Connectors it may use</Label>
          {s.connectors.length ? (
            <Group>
              {s.connectors.map((c, index) => (
                <Line key={c.id} title={c.name} right={<Tag text={LEVEL[c.level] ?? c.level} color={c.level === 'off' ? t.ink3 : c.level === 'write' ? t.warn : t.good} />}
                  onPress={() => nav.push({ name: 'connector', id: c.id })} last={index === s.connectors.length - 1} />
              ))}
            </Group>
          ) : <Txt color={t.ink2}>Nothing is connected yet. A service is added on the PC, under Connectors.</Txt>}
          <Button label="Open Connectors" kind="quiet" onPress={() => nav.push({ name: 'connectors' })} />

          <Variables connection={connection} botId={botId} variables={s.variables} onChange={(variables) => setData({ ...s, variables })} />

          <Label>{`Remove ${s.name}`}</Label>
          <Txt size={13} color={t.ink2}>Its runs stop and it is given nothing more. Its past jobs, runs and conversations stay in the studio's history.{s.openJobs ? ` It has ${plural(s.openJobs, 'open job')}.` : ''}</Txt>
          <Button label="Remove this bot" kind="danger" busy={busy === 'remove'} disabled={Boolean(busy)} onPress={remove} />
        </>
      ) : null}
    </Page>
  );
}

const styles = StyleSheet.create({
  stack: { gap: 12 },
  under: { marginTop: 6 },
  pick: { gap: 8 },
  does: { minHeight: 84 },
  two: { alignItems: 'flex-end', flexDirection: 'row', gap: 10 },
  half: { flex: 1 },
  suit: { borderRadius: 3, borderWidth: 2, height: 10, marginTop: 2 },
  saveBar: { gap: 10, marginTop: 20 },
  variable: { gap: 8, paddingHorizontal: 14, paddingVertical: 11 },
  variableHead: { alignItems: 'center', flexDirection: 'row', gap: 10 },
  grow: { flex: 1 },
  acts: { flexDirection: 'row', gap: 8 },
});
