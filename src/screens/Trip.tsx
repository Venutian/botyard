/** One request on its track: where it stands, the gate's three answers when it waits for you, the drawing, each step's result and cost, and running a step again. The same hands as the PC page. */
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Connection, getTrip, TripAction, tripAction, TripStep } from '../api';
import { Nav } from '../crew';
import { useLook } from '../theme/prefs';
import { ask } from '../ui/ask';
import { useAct } from '../ui/form';
import { Button, Chips, Field, Group, Label, Txt } from '../ui/kit';
import { Line, Page, Tag, useLoad } from '../ui/page';
import { TrackDrawing } from '../ui/track';

const KIND: Record<string, string> = { bot: 'Bot', script: 'Script', gate: 'You', track: 'Track' };
const WORDS: Record<string, string> = { passed: 'Passed', failed: 'Failed', working: 'Working', waiting: 'Next', 'not-started': 'Not yet' };

export function TripScreen({ id, connection, nav }: { id: string; connection: Connection; nav: Nav }) {
  const { t } = useLook();
  const { data: trip, error, load } = useLoad(() => getTrip(connection, id), [connection, id]);
  const { busy, run } = useAct();
  const [note, setNote] = useState('');
  const [to, setTo] = useState('');
  const [from, setFrom] = useState('');
  const [rerunNote, setRerunNote] = useState('');

  const act = (action: TripAction, body: { step?: string; to?: string; note?: string } = {}) => run(action, async () => {
    await tripAction(connection, id, action, body);
    if (action !== 'pause' && action !== 'resume' && action !== 'stop') { setNote(''); setRerunNote(''); }
    await load();
    // The next step starts on the engine's next turn: look once more, so the screen shows the move.
    setTimeout(() => { load(); }, 6000);
  }, 'That did not reach the trip');

  const tone = (s: TripStep) => (s.state === 'passed' ? t.good : s.state === 'failed' ? t.bad : s.state === 'working' || s.state === 'waiting' ? t.warn : t.ink3);
  const gate = trip?.gate;
  const before = gate?.backTo[gate.backTo.length - 1];
  const target = to || before?.id || '';
  const rerunFrom = from || trip?.steps[0]?.id || '';
  const needNote = !note.trim();
  // Marks are made on the work itself: the newest job of a step before the gate, or the request's own job; they go back as the note.
  const workJob = gate && trip ? [...trip.steps.slice(0, trip.steps.findIndex((s) => s.id === gate.step))].reverse().find((s) => s.jobId)?.jobId || trip.request.jobId || '' : '';
  return (
    <Page title={trip?.request.title ?? 'Trip'} note={trip ? `${trip.request.job} · ${trip.track.key} v${trip.track.version} · ${trip.request.cost} for the request` : undefined} onBack={nav.back} onRefresh={load} error={error} loading={!trip}>
      {trip ? (
        <>
          <View style={styles.head}>
            <Tag text={trip.state} color={trip.status === 'stuck' ? t.bad : trip.status === 'done' ? t.good : t.warn} />
            {trip.reason ? <Txt size={14} color={trip.status === 'stuck' ? t.bad : t.ink2}>{trip.reason}</Txt> : null}
            {trip.status === 'not-in-main' ? <Txt size={14} color={t.ink2}>{`The steps are done. It is finished when commit ${trip.commit.slice(0, 10)} is in ${trip.track.main}.`}</Txt> : null}
          </View>

          {gate ? (
            <View style={[styles.gate, { borderColor: t.warn, backgroundColor: t.card }]}>
              <Txt size={16} weight={700}>{`Waits for you: ${gate.title}`}</Txt>
              <Button label="Approve" busy={busy === 'approve'} disabled={Boolean(busy)} onPress={() => { act('approve'); }} />
              {workJob ? <Button label="Mark exact places in the work" kind="quiet" icon="pin" disabled={Boolean(busy)} onPress={() => nav.push({ name: 'review', job: workJob })} /> : null}
              <Field label="Note for the work" value={note} onChangeText={setNote} multiline tall maxLength={4000} placeholder="What to change, or what the step should know" />
              {before ? <Button label={`Add this and run “${before.title}” again`} kind="quiet" busy={busy === 'context'} disabled={needNote || Boolean(busy)} onPress={() => { act('context', { note }); }} /> : null}
              {gate.backTo.length ? (
                <>
                  <Txt size={14} weight={600} color={t.ink2}>Send back to</Txt>
                  <Chips value={target} options={gate.backTo.map((s) => ({ id: s.id, name: s.title }))} onChange={setTo} />
                  <Button label="Send back with the note" kind="quiet" busy={busy === 'back'} disabled={needNote || Boolean(busy)} onPress={() => { act('back', { to: target, note }); }} />
                </>
              ) : null}
            </View>
          ) : null}

          <Label>The track</Label>
          <TrackDrawing steps={trip.steps} lines={trip.lines} states={Object.fromEntries(trip.steps.map((s) => [s.id, s.state]))} current={trip.current} title={trip.track.title} />

          <Label>Steps</Label>
          <Group>
            {trip.steps.map((s, index) => (
              <Line key={s.id} title={`${index + 1}. ${s.title}`}
                detail={[s.state === 'failed' && s.findings ? s.findings.slice(0, 400) : '', s.note ? `Your note: ${s.note}` : '', ...s.leftNames.filter((k) => !['workdir', 'branch', 'verdict'].includes(k)).map((k) => `${k}: ${k === 'commit' ? String(s.left[k]).slice(0, 10) : String(s.left[k] ?? '').slice(0, 240)}`), s.kind === 'script' && s.summary && s.state !== 'failed' ? s.summary.slice(0, 200) : ''].filter(Boolean).join('\n') || undefined}
                tone={s.state === 'failed' ? t.bad : undefined}
                note={[KIND[s.kind], s.job, s.tries > 1 ? `round ${s.tries}` : '', s.costUsd ? s.cost : ''].filter(Boolean).join(' · ')}
                right={<Tag text={s.state === 'working' && s.kind === 'gate' ? 'Waits for you' : WORDS[s.state] || s.state} color={tone(s)} />}
                onPress={s.jobId ? () => nav.push({ name: 'job', id: s.jobId }) : undefined} last={index === trip.steps.length - 1} />
            ))}
          </Group>

          <Label>Change its course</Label>
          <View style={styles.row}>
            {trip.can.pause ? <Button label="Pause" kind="quiet" busy={busy === 'pause'} disabled={Boolean(busy)} onPress={() => { act('pause'); }} /> : null}
            {trip.can.resume ? <Button label="Resume" busy={busy === 'resume'} disabled={Boolean(busy)} onPress={() => { act('resume'); }} /> : null}
          </View>
          <Txt size={14} weight={600} color={t.ink2}>Run again from</Txt>
          <Chips value={rerunFrom} options={trip.steps.map((s) => ({ id: s.id, name: s.title }))} onChange={setFrom} />
          <Field label="Context for that step (optional)" value={rerunNote} onChangeText={setRerunNote} multiline maxLength={4000} />
          <Button label="Run again from there" kind="quiet" busy={busy === 'rerun'} disabled={Boolean(busy)} onPress={() => { act('rerun', { step: rerunFrom, note: rerunNote }); }} />
          <Txt size={13} color={t.ink3}>What the steps before it left is kept, so they are not paid for again.</Txt>
          {trip.can.stop ? (
            <Button label="Stop this trip" kind="danger" busy={busy === 'stop'} disabled={Boolean(busy)}
              onPress={() => ask('Stop this trip?', 'The step at work is let go of and nothing more starts. You can run it again from a step later.', 'Stop', () => { act('stop'); })} />
          ) : null}
        </>
      ) : null}
    </Page>
  );
}

const styles = StyleSheet.create({
  head: { gap: 6 },
  gate: { borderWidth: 2, borderRadius: 12, padding: 12, gap: 10 },
  row: { flexDirection: 'row', gap: 10, flexWrap: 'wrap' },
});
