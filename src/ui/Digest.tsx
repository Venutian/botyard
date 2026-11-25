import { useState } from 'react';
import { View } from 'react-native';
import { Connection, Digest, DigestCard, takeBackDefault } from '../api';
import { useLook } from '../theme/prefs';
import { Button, Group, Label, Row, Txt } from './kit';
import { Tag } from './page';

/**
 * The decision digest at the top of the home screen: five cards at most, the ones only the owner may answer
 * first. A default card says its answer and when that applies by itself; an answer already applied by default
 * can be taken back while the engine can still undo it. A card opens where it is answered.
 */
export function DigestCards({ digest, connection, onOpen, onChange }: { digest: Digest | null; connection: Connection; onOpen: (card: DigestCard) => void; onChange: (next: Digest) => void }) {
  const { t } = useLook();
  const [busy, setBusy] = useState('');
  const [said, setSaid] = useState('');
  if (!digest || (!digest.cards.length && !digest.applied.length)) return null;
  const takeBack = async (jobId: string, cardId: string) => {
    setBusy(cardId);
    setSaid('');
    try {
      onChange(await takeBackDefault(connection, jobId, cardId));
    } catch (err) {
      setSaid((err as Error).message);
    }
    setBusy('');
  };
  return (
    <View>
      {digest.cards.length ? <Label>{`Your decisions${digest.notes ? ` (${digest.notes})` : ''}`}</Label> : null}
      {digest.cards.length ? (
        <Group>
          {digest.cards.map((card, index) => (
            <Row key={card.id} title={card.title} detail={card.line} last={index === digest.cards.length - 1} onPress={() => onOpen(card)}
              right={<Tag text={card.kind === 'must' ? 'Only you' : card.count > 1 ? `Default, ${card.count}x` : 'Default'} color={card.kind === 'must' ? t.warn : t.ink2} />} />
          ))}
        </Group>
      ) : null}
      {digest.applied.length ? <Label>Decided for you</Label> : null}
      {digest.applied.length ? (
        <Group>
          {digest.applied.map((item, index) => (
            <Row key={item.id} title={item.title} detail={item.line} last={index === digest.applied.length - 1}>
              {item.canReverse ? <Button label="Take back" kind="quiet" busy={busy === item.id} onPress={() => takeBack(item.jobId, item.id)} hint="The question is open again and waits for your own answer. The bot is told." /> : null}
            </Row>
          ))}
        </Group>
      ) : null}
      {said ? <Txt size={14} color={t.bad} accessibilityLiveRegion="polite">{said}</Txt> : null}
    </View>
  );
}
