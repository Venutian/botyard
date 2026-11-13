/** Adding a project from a folder or a repository address, and a project's own settings: its name, its folder, putting it away. */
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { addProject, archiveProject, Connection, getProject, moveProject, Refusal, renameProject } from '../api';
import { Nav } from '../crew';
import { useLook } from '../theme/prefs';
import { ask, tell } from '../ui/ask';
import { MONO, Note, useAct } from '../ui/form';
import { Button, Field, Label, Segmented, Txt, useTap } from '../ui/kit';
import { Page, useLoad } from '../ui/page';

type Added = { id: string; name: string; folder: string };

/** Add a project: a folder that is already on the computer Botyard runs on, or a repository's address to copy there. */
export function ProjectAddForm({ connection, onAdded }: { connection: Connection; onAdded: (project: Added) => void }) {
  const { t } = useLook();
  const tap = useTap();
  const [from, setFrom] = useState<'folder' | 'repo'>('folder');
  const [folder, setFolder] = useState('');
  const [repo, setRepo] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  /** The door's own words when the folder has no git yet, with its offer to start one. */
  const [noGit, setNoGit] = useState('');
  const where = from === 'folder' ? folder.trim() : repo.trim();

  const send = async (init = false) => {
    setBusy(true);
    try {
      const made = await addProject(connection, { ...(name.trim() ? { name: name.trim() } : {}), ...(from === 'folder' ? { folder: where } : { repo: where }), ...(init ? { init: true } : {}) });
      tap('done');
      setFolder('');
      setRepo('');
      setName('');
      setNoGit('');
      onAdded(made);
    } catch (err) {
      const refusal = err as Refusal;
      if (refusal.canInit) setNoGit(refusal.message);
      else {
        setNoGit('');
        tell('The project was not added', refusal.message);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.stack}>
      <Segmented value={from} options={[{ id: 'folder', name: 'A folder on the computer' }, { id: 'repo', name: 'A GitHub address' }]} onChange={(next) => { setFrom(next); setNoGit(''); }} />
      {from === 'folder' ? (
        <Field label="Folder" value={folder} onChangeText={(text) => { setFolder(text); setNoGit(''); }} autoCapitalize="none" autoCorrect={false} spellCheck={false} placeholder="~/projects/tea-shop" style={MONO} />
      ) : (
        <Field label="Address" value={repo} onChangeText={setRepo} autoCapitalize="none" autoCorrect={false} spellCheck={false} keyboardType="url" placeholder="https://github.com/you/tea-shop" style={MONO} />
      )}
      <Field label="Name" value={name} onChangeText={setName} maxLength={80} placeholder="Leave empty to use the folder's name" />
      {from === 'folder'
        ? <Txt size={12} color={t.ink3}>The folder is on the computer Botyard runs on, not on this phone. Write it as that computer names it.</Txt>
        : <Txt size={12} color={t.ink3}>It is copied into the projects folder inside Botyard's own folder on that computer. A private one needs GitHub signed in first, in Setup.</Txt>}
      {noGit ? (
        <>
          <Note tone="warn">{`${noGit}.`}</Note>
          <Button label="Start git in that folder and add it" busy={busy} onPress={() => send(true)} />
        </>
      ) : <Button label="Add the project" busy={busy} disabled={!where} onPress={() => send()} />}
    </View>
  );
}

export function ProjectNewScreen({ connection, nav }: { connection: Connection; nav: Nav }) {
  return (
    <Page title="Add a project" note="A folder of code the crew works in. Each job gets its own branch there, so nothing touches your own work until you take it." onBack={nav.back}>
      <View style={styles.form}>
        <ProjectAddForm connection={connection} onAdded={(project) => nav.replace({ name: 'project', id: project.id })} />
      </View>
    </Page>
  );
}

/** A project's name, its folder, and archiving it. The phone is not told folders, so the folder box starts empty. */
export function ProjectEditScreen({ id, connection, nav }: { id: string; connection: Connection; nav: Nav }) {
  const { t } = useLook();
  const { data: p, error, load } = useLoad(() => getProject(connection, id), [connection, id]);
  const { busy, run } = useAct();
  const [name, setName] = useState<string | null>(null);
  const [folder, setFolder] = useState('');
  const [noGit, setNoGit] = useState('');
  const [moved, setMoved] = useState('');
  const title = name ?? p?.name ?? '';

  const rename = () => run('rename', async () => {
    await renameProject(connection, id, title.trim());
    await load();
    setName(null);
  }, 'The name was not saved');

  const move = (init = false) => run('move', async () => {
    try {
      await moveProject(connection, id, folder.trim(), init);
      setMoved(folder.trim());
      setFolder('');
      setNoGit('');
    } catch (err) {
      const refusal = err as Refusal;
      if (!refusal.canInit) throw err;
      setNoGit(refusal.message);
    }
  }, 'The folder was not changed');

  const archive = () => p && ask(`Archive ${p.name}?`, 'It leaves the map and every list, and the crew is given nothing more from it. Its jobs, history and folder stay. You can bring it back from Setup.', 'Archive', () => {
    run('archive', async () => {
      await archiveProject(connection, id);
      tell(`${p.name} is archived`, 'Bring it back from Setup, under Archived projects.');
      // Its own page is off every list now, so step back past that too.
      nav.back();
      nav.back();
    }, 'The project was not archived');
  });

  return (
    <Page title={p?.name ?? 'Project'} note={p ? 'Its name, its folder, and putting it away.' : undefined} onBack={nav.back} error={error} loading={!p}>
      {p ? (
        <>
          <Label>Name</Label>
          <View style={styles.stack}>
            <Field label="Project name" value={title} onChangeText={setName} maxLength={80} />
            <Button label="Save the name" kind="quiet" busy={busy === 'rename'} disabled={!title.trim() || title.trim() === p.name || Boolean(busy)} onPress={rename} />
          </View>

          <Label>Folder</Label>
          <View style={styles.stack}>
            <Txt size={13} color={t.ink2}>Where its code is on the computer Botyard runs on. New jobs branch from here; jobs already going stay where they are. The phone is not shown the folder it uses now.</Txt>
            <Field label="New folder" value={folder} onChangeText={(text) => { setFolder(text); setNoGit(''); }} autoCapitalize="none" autoCorrect={false} spellCheck={false} placeholder="~/projects/tea-shop" style={MONO} />
            {moved ? <Note tone="good">{`New jobs now branch from ${moved}.`}</Note> : null}
            {noGit ? (
              <>
                <Note tone="warn">{`${noGit}.`}</Note>
                <Button label="Start git in that folder and use it" busy={busy === 'move'} disabled={Boolean(busy)} onPress={() => move(true)} />
              </>
            ) : <Button label="Use this folder" kind="quiet" busy={busy === 'move'} disabled={!folder.trim() || Boolean(busy)} onPress={() => move()} />}
          </View>

          <Label>Archive</Label>
          <View style={styles.stack}>
            <Txt size={13} color={t.ink2}>Takes it off the map and out of every list. Nothing is deleted: its jobs, history and folder stay, and it can be brought back from Setup.</Txt>
            <Button label={`Archive ${p.name}`} kind="danger" busy={busy === 'archive'} disabled={Boolean(busy)} onPress={archive} />
          </View>
        </>
      ) : null}
    </Page>
  );
}

const styles = StyleSheet.create({
  stack: { gap: 12 },
  form: { marginTop: 12 },
});
