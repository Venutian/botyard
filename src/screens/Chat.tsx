import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as ImagePicker from 'expo-image-picker';
import { ActivityIndicator, FlatList, Image, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { acceptQuestion, Answer, answerQuestion, ChatCard, ChatMessage, ChatThread, Connection, getChat, MOST_PICTURES, PICTURE_BYTES, PICTURE_TYPES, PickedPicture, SYSTEM, rejectQuestion, settleConnectCard, requestId, sendChat, uploadChatPicture } from '../api';
import { Crew, Nav } from '../crew';
import { BotBadge } from '../mascot/BotBadge';
import { portraitOf } from '../mascot/look';
import { useLook } from '../theme/prefs';
import { tell } from '../ui/ask';
import { Bubble, TypingBubble } from '../ui/Bubble';
import { ChatPictures } from '../ui/Proof';
import { Icon } from '../ui/Icon';
import { Button, GlassButton, plainField, Txt, useTap } from '../ui/kit';
import { Wallpaper } from '../ui/Wallpaper';
import { ChoiceCard, ConfirmCard } from './Job';
import { CAN_TALK, speak, stopSpeaking, useDictation } from '../voice';

/** A bot usually answers within seconds, so a conversation checks far more often than the rest. */
const CHAT_WORKING_MS = 2_500;
const CHAT_IDLE_MS = 8_000;
const HEADER = 112;
/** Within this distance of the newest message, a new one scrolls into view by itself. */
const NEAR_BOTTOM = 120;
type Item = ChatMessage | ChatCard;
const isCard = (item?: Item): item is ChatCard => Boolean(item && 'state' in item);
const side = (m?: Item) => (m ? (isCard(m) ? 'card' : m.note || SYSTEM.includes(m.from) ? 'note' : m.mine ? 'mine' : 'bot') : null);

/** A card a bot put in the conversation, where it was asked: answered here when the app can, otherwise it says where. */
function CardRow({ card, busy, onAnswer, onConnect }: { card: ChatCard; busy: boolean; onAnswer: (verb: 'respond' | 'accept' | 'reject', answers?: Answer[]) => void; onConnect: (connected: boolean | 'open') => void }) {
  const { t } = useLook();
  if (card.state === 'pending' && card.question?.kind === 'choice') {
    return <View style={styles.card}><ChoiceCard question={card.question} busy={busy} onAnswer={(answers) => onAnswer('respond', answers)} /></View>;
  }
  if (card.state === 'pending' && card.question?.kind === 'confirm') {
    return <View style={styles.card}><ConfirmCard question={card.question} busy={busy} onAccept={() => onAnswer('accept')} onReject={() => onAnswer('reject')} /></View>;
  }
  const pending = card.state === 'pending';
  const asksService = pending && card.kind === 'connect';
  return (
    <View style={[styles.card, styles.cardBox, { backgroundColor: t.card, borderColor: pending ? (t.plates ? t.ink : t.accent) : t.line, borderWidth: t.hair, borderRadius: t.r.card }]}>
      <Txt size={12} weight={700} color={pending ? t.accentText : t.ink3}>{pending ? 'Needs you' : card.state === 'done' ? 'Answered' : 'Withdrawn'}</Txt>
      <Txt size={15} weight={600}>{card.title}</Txt>
      {card.detail ? <Txt size={14} color={t.ink2}>{card.detail}</Txt> : null}
      {asksService ? <Txt size={13} color={t.ink2}>Connect it under Connectors (a new service is added on the PC) and choose who may use it. Then say so here, and the bot carries on.</Txt> : null}
      {pending && !asksService ? <Txt size={13} color={t.ink2}>Answer it in a message below.</Txt> : null}
      {asksService ? (
        <View style={styles.connectRow}>
          <Button label="Connectors" onPress={() => onConnect('open')} />
          <Button label="It is connected" kind="quiet" busy={busy} onPress={() => onConnect(true)} />
          <Button label="No" kind="quiet" busy={busy} onPress={() => onConnect(false)} />
        </View>
      ) : null}
    </View>
  );
}

export function ChatScreen({ botId, connection, crew, nav }: { botId: string; connection: Connection; crew: Crew; nav: Nav }) {
  const { p, t, font, markSeen } = useLook();
  const insets = useSafeAreaInsets();
  const tap = useTap();
  const [thread, setThread] = useState<ChatThread | null>(null);
  const [error, setError] = useState('');
  const [text, setText] = useState('');
  const [pending, setPending] = useState<ChatMessage | null>(null);
  // Pictures chosen for the next message, shown above the composer until it is sent.
  const [pictures, setPictures] = useState<PickedPicture[]>([]);
  const [quick, setQuick] = useState(false);
  const list = useRef<FlatList<Item>>(null);
  const [answering, setAnswering] = useState(false);
  // Questions still waiting are pinned under the header until answered: opened from Needs you they
  // would be buried in the chat. The owner can fold them away; a new one unfolds them.
  const [folded, setFolded] = useState(false);
  const known = useRef<Set<string> | null>(null);
  const spoken = useRef<string | null>(null);
  const { listening, toggle } = useDictation(setText);

  const load = useCallback(async () => {
    try {
      setThread(await getChat(connection, botId));
      setError('');
    } catch (err) {
      setError((err as Error).message);
    }
  }, [connection, botId]);

  useEffect(() => {
    load();
  }, [load]);

  const busy = Boolean(pending) || Boolean(thread?.working);
  useEffect(() => {
    const timer = setInterval(load, busy ? CHAT_WORKING_MS : CHAT_IDLE_MS);
    return () => clearInterval(timer);
  }, [load, busy]);

  const newest = thread?.messages[thread.messages.length - 1]?.at;
  useEffect(() => {
    if (newest) markSeen(botId, newest);
  }, [newest, botId, markSeen]);

  /** The system's own photo picker: it asks for no access to the phone's photos, only for the ones chosen. */
  const pick = async () => {
    const room = MOST_PICTURES - pictures.length;
    if (room <= 0) return tell('That is the most for one message', `A message carries at most ${MOST_PICTURES} pictures.`);
    const picked = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], allowsMultipleSelection: true, selectionLimit: room, quality: 1, exif: false });
    if (picked.canceled) return;
    const taken: PickedPicture[] = [];
    const refused: string[] = [];
    for (const [n, asset] of picked.assets.slice(0, room).entries()) {
      const type = (asset.mimeType || '').toLowerCase();
      const name = asset.fileName || `picture-${Date.now()}-${n + 1}.${type.split('/')[1]?.replace('jpeg', 'jpg') || 'png'}`;
      if (!PICTURE_TYPES.includes(type)) refused.push(`${name} is not a PNG, JPEG, WebP or GIF picture`);
      else if (asset.fileSize && asset.fileSize > PICTURE_BYTES) refused.push(`${name} is larger than 10 MB`);
      else taken.push({ uri: asset.uri, name, type, size: asset.fileSize });
    }
    if (refused.length) tell('Some pictures were left out', refused.join('\n'));
    if (taken.length) setPictures((now) => [...now, ...taken].slice(0, MOST_PICTURES));
  };

  const send = async (words: string) => {
    const message = words.trim();
    const going = pictures;
    if (!message && !going.length) return;
    tap('light');
    const id = requestId();
    setText('');
    setPictures([]);
    setQuick(false);
    list.current?.scrollToOffset({ offset: 0, animated: true });
    setPending({ id, from: 'You', mine: true, text: message, at: '', pictures: going.map((pic, n) => ({ id: `${id}-${n}`, name: pic.name, uri: pic.uri })) });
    try {
      // Each picture goes up first; the message then names them, so the bot sees them with the words.
      const ids: string[] = [];
      for (const pic of going) ids.push((await uploadChatPicture(connection, botId, pic)).id);
      await sendChat(connection, botId, message, id, ids);
      await load();
      crew.reload();
    } catch (err) {
      setText(message);
      setPictures(going);
      tell('That was not sent', (err as Error).message);
    } finally {
      setPending(null);
    }
  };

  // Read new replies aloud when the owner turned that on for this bot.
  const lastMessage = thread?.messages[thread.messages.length - 1];
  const speakReplies = Boolean(p.bots[botId]?.speak);
  useEffect(() => {
    if (!lastMessage || lastMessage.mine || lastMessage.note || SYSTEM.includes(lastMessage.from) || spoken.current === lastMessage.id) return;
    const first = spoken.current === null;
    spoken.current = lastMessage.id;
    if (!first && speakReplies) speak(lastMessage.text);
  }, [lastMessage, speakReplies]);
  useEffect(() => () => {
    stopSpeaking();
  }, []);

  const bot = crew.bots?.find((b) => b.id === botId);
  const look = p.bots[botId];
  const who = useMemo(() => portraitOf({ id: botId, name: bot?.name ?? thread?.bot.name ?? '', status: bot?.status, role: bot?.role ?? thread?.bot.role, look: bot?.look ?? thread?.bot.look }, look), [botId, bot?.name, bot?.status, bot?.role, bot?.look, thread?.bot, look]);
  // Newest first, drawn upside down: a conversation opens on its last message with nothing to scroll.
  const waiting = (thread?.cards ?? []).filter((c) => c.state === 'pending');
  const waitingKey = waiting.map((c) => c.id).join();
  useEffect(() => {
    if (waitingKey) setFolded(false);
  }, [waitingKey]);
  const newestFirst: Item[] = [
    ...(pending ? [pending] : []),
    ...[...(thread?.messages ?? []), ...(thread?.cards ?? [])].sort((a, b) => Date.parse(b.at) - Date.parse(a.at)),
  ];
  const answer = async (card: ChatCard, verb: 'respond' | 'accept' | 'reject', answers?: Answer[]) => {
    if (!thread?.chatId || answering) return;
    setAnswering(true);
    try {
      if (verb === 'respond') await answerQuestion(connection, thread.chatId, card.id, answers ?? []);
      else if (verb === 'accept') await acceptQuestion(connection, thread.chatId, card.id);
      else await rejectQuestion(connection, thread.chatId, card.id);
      await load();
    } catch (err) {
      tell('The answer was not sent', (err as Error).message);
    }
    setAnswering(false);
  };
  /** A bot asked for a service: open Connectors, or settle the card (connected, or no). */
  const connect = async (card: ChatCard, how: boolean | 'open') => {
    if (how === 'open') return nav.push({ name: 'connectors' });
    if (answering) return;
    setAnswering(true);
    try {
      await settleConnectCard(connection, card.id, how, card.service);
      await load();
    } catch (err) {
      tell('The answer was not sent', (err as Error).message);
    }
    setAnswering(false);
  };
  // Messages already there on arrival appear at once. Only new ones pop in.
  if (!known.current && thread) known.current = new Set(thread.messages.map((m) => m.id));
  // Typing a slash lists saved prompts.
  const query = text.startsWith('/') ? text.slice(1).toLowerCase() : null;
  const matches = query === null ? [] : p.prompts.filter((words) => words.toLowerCase().includes(query));
  const subtitle = thread?.working ? 'Working now' : bot?.title ?? thread?.bot.title ?? '';

  return (
    <KeyboardAvoidingView behavior="padding" style={[styles.fill, { backgroundColor: t.app }]}>
      <Wallpaper id={look?.wallpaper ?? p.wallpaper} />
      <FlatList
        ref={list}
        inverted
        data={newestFirst}
        extraData={who}
        keyExtractor={(message) => message.id}
        style={styles.fill}
        keyboardShouldPersistTaps="handled"
        maintainVisibleContentPosition={{ minIndexForVisible: 0, autoscrollToTopThreshold: NEAR_BOTTOM }}
        // The list is flipped, so its top padding sits under the composer and its bottom padding under the header.
        contentContainerStyle={{ paddingTop: 12, paddingBottom: insets.top + HEADER, paddingHorizontal: 12 }}
        renderItem={({ item, index }) => {
          if (isCard(item) && item.state === 'pending') {
            return (
              <Pressable accessibilityRole="button" onPress={() => setFolded(false)} style={({ pressed }) => [styles.askedHere, { borderColor: t.ink3 }, pressed && styles.pressed]}>
                <Txt size={13} color={t.ink2}>{`Asked here: ${item.title}. It waits at the top.`}</Txt>
              </Pressable>
            );
          }
          if (isCard(item)) return <CardRow card={item} busy={answering} onAnswer={(verb, answers) => answer(item, verb, answers)} onConnect={(how) => connect(item, how)} />;
          const mine = side(item);
          const fresh = known.current ? !known.current.has(item.id) : false;
          const bubble = item.text || !item.pictures?.length
            ? <Bubble message={item} first={side(newestFirst[index + 1]) !== mine || Boolean(item.pictures?.length)} last={side(newestFirst[index - 1]) !== mine} bot={who} fresh={fresh} />
            : null;
          if (!item.pictures?.length) return bubble;
          return (
            <View>
              <ChatPictures connection={connection} pictures={item.pictures} mine={item.mine} />
              {bubble}
            </View>
          );
        }}
        ListHeaderComponent={
          <>
            {thread?.working ? <TypingBubble bot={who} /> : null}
            {error ? <Txt color={t.bad} style={styles.error}>{error}</Txt> : null}
          </>
        }
        ListEmptyComponent={
          !thread ? (
            error ? null : <ActivityIndicator color={t.accent} style={styles.spinner} />
          ) : (
            <View style={styles.empty}>
              <Txt color={t.ink2} style={styles.centerText}>Say hello. Ask for status, or tell {who.name} what you need.</Txt>
            </View>
          )
        }
      />

      <View pointerEvents="box-none" style={[styles.header, { paddingTop: insets.top + 8 }]}>
        <GlassButton icon="back" label="Back" onPress={nav.back} />
        <Pressable accessibilityRole="button" accessibilityLabel={`Open ${who.name}'s profile`} onPress={() => nav.push({ name: 'bot', botId })} style={styles.who}>
          <BotBadge who={who} size={54} />
          <View style={[styles.namePill, { backgroundColor: t.glass, borderColor: t.ink, borderWidth: t.outline ? 2 : 0 }]}>
            <Txt size={14} weight={700} numberOfLines={1}>{who.name}</Txt>
            {subtitle ? <Txt size={11} color={thread?.working ? t.accentText : t.ink2} numberOfLines={1}>{subtitle}</Txt> : null}
          </View>
        </Pressable>
        <GlassButton icon="more" label={`Customize ${who.name}`} onPress={() => nav.push({ name: 'bot', botId })} />
      </View>

      {waiting.length ? (
        <View style={[styles.waiting, { top: insets.top + HEADER - 8 }]}>
          <Pressable accessibilityRole="button" accessibilityState={{ expanded: !folded }} onPress={() => setFolded(!folded)} style={({ pressed }) => [styles.waitingHead, { backgroundColor: t.accent }, pressed && styles.pressed]}>
            <Txt size={13} weight={700} color={t.accentInk}>{`Waiting for your answer${waiting.length > 1 ? ` (${waiting.length})` : ''}`}</Txt>
            <Icon name={folded ? 'down' : 'up'} size={16} color={t.accentInk} />
          </Pressable>
          {!folded ? (
            <ScrollView style={styles.waitingList} keyboardShouldPersistTaps="handled">
              {waiting.map((card) => <CardRow key={card.id} card={card} busy={answering} onAnswer={(verb, answers) => answer(card, verb, answers)} onConnect={(how) => connect(card, how)} />)}
            </ScrollView>
          ) : null}
        </View>
      ) : null}

      {quick ? (
        <View style={styles.quick}>
          {p.prompts.map((words) => (
            <Pressable key={words} accessibilityRole="button" onPress={() => send(words)} style={({ pressed }) => [styles.quickItem, { backgroundColor: t.glass, borderColor: t.ink, borderWidth: t.outline ? 2 : 0 }, pressed && styles.pressed]}>
              <Txt size={14} weight={600}>{words}</Txt>
            </Pressable>
          ))}
          <Pressable accessibilityRole="button" onPress={() => { setQuick(false); nav.push({ name: 'new' }); }} style={({ pressed }) => [styles.quickItem, { backgroundColor: t.accent }, pressed && styles.pressed]}>
            <Txt size={14} weight={700} color={t.accentInk}>Add a new job</Txt>
          </Pressable>
        </View>
      ) : null}

      {matches.length ? (
        <View style={styles.quick}>
          {matches.map((words) => (
            <Pressable key={words} accessibilityRole="button" onPress={() => send(words)} style={({ pressed }) => [styles.quickItem, { backgroundColor: t.glass, borderColor: t.ink, borderWidth: t.outline ? 2 : 0 }, pressed && styles.pressed]}>
              <Txt size={14} weight={600}>{words}</Txt>
            </Pressable>
          ))}
        </View>
      ) : null}

      {pictures.length ? (
        <ScrollView horizontal keyboardShouldPersistTaps="handled" showsHorizontalScrollIndicator={false} style={styles.trayRow} contentContainerStyle={styles.tray} accessibilityLabel="Pictures to send">
          {pictures.map((pic, n) => (
            <View key={`${pic.uri}-${n}`} style={[styles.trayItem, { borderColor: t.outline ? t.ink : t.line, borderWidth: t.outline ? 2 : 1 }]}>
              <Image source={{ uri: pic.uri }} style={styles.trayImage} resizeMode="cover" accessibilityLabel={pic.name} />
              <Pressable accessibilityRole="button" accessibilityLabel={`Take ${pic.name} out`} hitSlop={8} onPress={() => setPictures((now) => now.filter((_, i) => i !== n))} style={styles.trayDrop}>
                <Icon name="close" size={14} color="#ffffff" weight={2.6} />
              </Pressable>
            </View>
          ))}
        </ScrollView>
      ) : null}

      <View style={[styles.composer, { paddingBottom: Math.max(insets.bottom, 10) }]}>
        <GlassButton icon={quick ? 'close' : 'plus'} label={quick ? 'Close quick messages' : 'Open quick messages'} onPress={() => setQuick(!quick)} size={42} />
        <GlassButton icon="image" label="Add a picture" onPress={pick} size={42} />
        <View style={[styles.pill, { backgroundColor: t.composer, borderColor: t.outline ? t.ink : t.line, borderWidth: t.hair }]}>
          <TextInput
            value={text}
            onChangeText={setText}
            multiline
            maxLength={8000}
            placeholder={`Message ${who.name}`}
            placeholderTextColor={t.ink3}
            numberOfLines={Platform.OS === 'web' ? 1 : undefined}
            onKeyPress={Platform.OS === 'web' ? (event) => {
              // On the PC, Enter sends and Shift+Enter starts a new line.
              const key = event.nativeEvent as unknown as { key: string; shiftKey?: boolean };
              if (key.key === 'Enter' && !key.shiftKey) {
                event.preventDefault();
                send(text);
              }
            } : undefined}
            style={[styles.input, font(400), plainField, { color: t.ink }]}
          />
          {text.trim() || pictures.length ? (
            <Pressable accessibilityRole="button" accessibilityLabel="Send" disabled={Boolean(pending)} onPress={() => send(text)} style={({ pressed }) => [styles.send, { backgroundColor: t.accent }, pressed && styles.pressed]}>
              <Icon name="send" size={19} color={t.accentInk} weight={2.6} />
            </Pressable>
          ) : CAN_TALK ? (
            <Pressable accessibilityRole="button" accessibilityLabel={listening ? 'Stop listening' : 'Talk'} onPress={toggle} style={({ pressed }) => [styles.send, listening && { backgroundColor: t.bad }, pressed && styles.pressed]}>
              <Icon name="mic" size={20} color={listening ? '#ffffff' : t.ink2} />
            </Pressable>
          ) : null}
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  waiting: { position: 'absolute', left: 10, right: 10, maxHeight: '58%', gap: 6 },
  waitingHead: { alignItems: 'center', alignSelf: 'flex-start', borderRadius: 16, flexDirection: 'row', gap: 6, paddingHorizontal: 12, paddingVertical: 7 },
  waitingList: { flexGrow: 0 },
  askedHere: { borderRadius: 12, borderStyle: 'dashed', borderWidth: 1, marginVertical: 6, paddingHorizontal: 12, paddingVertical: 8 },
  fill: { flex: 1 },
  card: { marginVertical: 6 },
  cardBox: { borderRadius: 18, gap: 6, padding: 14 },
  connectRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 6 },
  cardButton: { alignItems: 'center', alignSelf: 'flex-start', borderRadius: 12, marginTop: 4, minHeight: 44, justifyContent: 'center', paddingHorizontal: 16 },
  spinner: { marginTop: 40 },
  empty: { paddingHorizontal: 32, paddingVertical: 40 },
  centerText: { textAlign: 'center' },
  error: { marginTop: 12, textAlign: 'center' },
  header: { alignItems: 'flex-start', flexDirection: 'row', gap: 10, justifyContent: 'space-between', left: 0, paddingHorizontal: 14, position: 'absolute', right: 0, top: 0 },
  who: { alignItems: 'center', flex: 1, gap: 2 },
  namePill: { alignItems: 'center', borderRadius: 16, maxWidth: 220, paddingHorizontal: 14, paddingVertical: 3 },
  quick: { alignItems: 'flex-start', gap: 8, paddingBottom: 8, paddingHorizontal: 14 },
  quickItem: { borderRadius: 18, justifyContent: 'center', minHeight: 40, paddingHorizontal: 15 },
  pressed: { opacity: 0.7 },
  composer: { alignItems: 'flex-end', flexDirection: 'row', gap: 8, paddingHorizontal: 12, paddingTop: 6 },
  pill: { alignItems: 'flex-end', borderRadius: 22, flex: 1, flexDirection: 'row', minHeight: 44, paddingLeft: 16, paddingRight: 4, paddingVertical: 3 },
  input: { flex: 1, fontSize: 16, maxHeight: 130, paddingVertical: 7 },
  send: { alignItems: 'center', borderRadius: 18, height: 36, justifyContent: 'center', width: 36 },
  trayRow: { flexGrow: 0, flexShrink: 0 },
  tray: { gap: 8, paddingHorizontal: 14, paddingTop: 6 },
  trayItem: { borderRadius: 12, height: 72, overflow: 'hidden', width: 72 },
  trayImage: { height: '100%', width: '100%' },
  trayDrop: { alignItems: 'center', backgroundColor: 'rgba(0,0,0,0.65)', borderRadius: 11, height: 22, justifyContent: 'center', position: 'absolute', right: 4, top: 4, width: 22 },
});
