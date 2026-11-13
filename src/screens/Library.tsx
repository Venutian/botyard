import { useState } from 'react';
import { Connection, getCompany, getLibrary, LibraryItem } from '../api';
import { Nav } from '../crew';
import { useLook } from '../theme/prefs';
import { tell } from '../ui/ask';
import { Group, Label, Txt } from '../ui/kit';
import { ago, Line, More, Page, useLoad } from '../ui/page';
import { ProofRow } from '../ui/Proof';

const KIND_WORDS: Record<string, string> = { image: 'Picture', document: 'Document', text: 'Text', video: 'Video', file: 'File' };

/** What the crew made, newest first: the pictures as a strip, everything else as a list, each with its job. */
export function LibraryScreen({ connection, nav }: { connection: Connection; nav: Nav }) {
  const { t } = useLook();
  const first = useLoad(() => getLibrary(connection), [connection]);
  const [extra, setExtra] = useState<{ items: LibraryItem[]; next: string | null }>({ items: [], next: null });
  const [busy, setBusy] = useState(false);
  const items = [...(first.data?.items ?? []), ...extra.items];
  const next = extra.next ?? first.data?.next ?? '';

  const more = async () => {
    setBusy(true);
    try {
      const page = await getLibrary(connection, next);
      setExtra({ items: [...extra.items, ...page.items], next: page.next });
    } catch (err) {
      tell('That did not load', (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const pictures = items.filter((i) => i.kind === 'image' && i.file);
  const rest = items.filter((i) => !(i.kind === 'image' && i.file));
  return (
    <Page title="Library" note="What the crew made, newest first." onBack={nav.back} onRefresh={async () => { setExtra({ items: [], next: null }); await first.load(); }} error={first.error} loading={!first.data}>
      {first.data && !items.length ? <Txt color={t.ink2}>Nothing yet.</Txt> : null}
      {pictures.length ? (
        <>
          <Label>Pictures</Label>
          <ProofRow connection={connection} proof={pictures.slice(0, 12).map((p) => ({ id: p.file, name: p.job ? `${p.title}, ${p.job.ref}` : p.title }))} />
        </>
      ) : null}
      {rest.length ? (
        <>
          <Label>Documents and files</Label>
          <Group>
            {rest.map((item, index) => (
              <Line key={item.id} title={item.title} detail={item.preview || undefined}
                note={[KIND_WORDS[item.kind] ?? item.kind, item.job?.ref, item.bot, ago(item.at)].filter(Boolean).join(', ')}
                last={index === rest.length - 1} onPress={item.job ? () => nav.push({ name: 'job', id: item.job!.id }) : undefined} />
            ))}
          </Group>
        </>
      ) : null}
      {next ? <More onPress={more} busy={busy} /> : null}
    </Page>
  );
}

const ROLE_WORDS: Record<string, string> = { owner: 'Owner', admin: 'Admin', member: 'Member', viewer: 'Viewer', operator: 'Operator' };

/** The company, read only on the phone: who is in it and the invites nobody has used. Changes are made on the PC. */
export function CompanyScreen({ connection, nav }: { connection: Connection; nav: Nav }) {
  const { t } = useLook();
  const { data, error, load } = useLoad(() => getCompany(connection), [connection]);
  return (
    <Page title={data?.name || 'Company'} note={data ? [data.code && `Jobs are numbered ${data.code}-1, ${data.code}-2…`, data.about].filter(Boolean).join('. ') : undefined} onBack={nav.back} onRefresh={load} error={error} loading={!data}>
      {data ? (
        <>
          <Label>{`${data.members.length} member${data.members.length === 1 ? '' : 's'}`}</Label>
          <Group>
            {data.members.map((m, index) => <Line key={m.id} title={m.name} detail={`${ROLE_WORDS[m.role] ?? m.role}${m.active ? '' : ', not active'}`} note={m.since ? `Since ${new Date(m.since).toLocaleDateString()}` : undefined} last={index === data.members.length - 1} />)}
          </Group>
          <Label>Open invites</Label>
          {data.invites.length ? (
            <Group>
              {data.invites.map((i, index) => <Line key={i.id} title={ROLE_WORDS[i.role] ?? (i.role || 'Invite')} detail={i.expires ? `Runs out ${new Date(i.expires).toLocaleDateString()}` : 'Does not run out'} last={index === data.invites.length - 1} />)}
            </Group>
          ) : <Txt color={t.ink2}>None.</Txt>}
          <Txt size={12} color={t.ink3}>Invite people, take back an invite and see the secrets on the PC, in Settings.</Txt>
        </>
      ) : null}
    </Page>
  );
}
