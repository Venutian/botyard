import AsyncStorage from '@react-native-async-storage/async-storage';
import * as BackgroundTask from 'expo-background-task';
import * as Notifications from 'expo-notifications';
import * as SecureStore from 'expo-secure-store';
import * as TaskManager from 'expo-task-manager';
import { Connection, getSummary, Summary } from './api';

export const CONNECTION_KEY = 'studio-connection';
const TASK = 'studio-check';
// Keyed by decision, under a name of its own, so a list kept by words is never read as one kept by decision.
const SEEN_KEY = 'studio-notified-2';
const CHANNEL = 'studio';
const CHECK_MINUTES = 15;
const KEEP_SEEN = 200;

Notifications.setNotificationHandler({
  handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: false, shouldSetBadge: false }),
});

const tell = (title: string, body: string) => Notifications.scheduleNotificationAsync({ content: { title, body }, trigger: { channelId: CHANNEL } });

// The owner asked for decisions only: chats, finished jobs, failures and the morning report stay in the app.
const DECISIONS: Partial<Record<Summary['needsYou'][number]['kind'], string>> = { approval: 'Needs your approval', question: 'Decision for you' };

/**
 * One entry per decision, keyed by what it is, never by its words: a card whose wording changes (a chat
 * going from two questions to three, the lead rewording a card) is not a new decision. A chat's questions
 * count one by one.
 */
function news(summary: Summary) {
  // One the owner already read or archived, on the PC or here, is not news.
  return summary.needsYou.filter((item) => DECISIONS[item.kind] && !item.read && !item.archived).flatMap((item) => (
    item.asks?.length
      ? item.asks.map((ask) => ({ key: `ask:${ask.id}`, title: DECISIONS[item.kind] as string, body: ask.title }))
      : [{ key: `${item.kind}:${item.id}`, title: DECISIONS[item.kind] as string, body: item.title }]
  ));
}

let checking: Promise<void> | null = null;

/**
 * Asks the door what changed and raises a notification for anything new. Nothing leaves this phone
 * and the PC, so there is no push service: Android runs this about every 15 minutes, when it can.
 */
export function checkStudio() {
  // Two checks at once would both read the old list and both tell.
  checking ??= check().finally(() => { checking = null; });
  return checking;
}

async function check() {
  const saved = await SecureStore.getItemAsync(CONNECTION_KEY);
  if (!saved) return;
  const summary = await getSummary(JSON.parse(saved) as Connection);
  const items = news(summary);
  const raw = await AsyncStorage.getItem(SEEN_KEY);
  const seen = new Set<string>(raw ? JSON.parse(raw) : []);
  // The first check only learns what is already there, so opening the app does not set off a burst.
  if (raw) {
    const fresh = items.filter(({ key }) => !seen.has(key));
    // Several at once are one notification, not a burst.
    if (fresh.length === 1) await tell(fresh[0].title, fresh[0].body);
    if (fresh.length > 1) await tell(`${fresh.length} decisions for you`, fresh.map((item) => item.body).join('\n'));
  }
  await AsyncStorage.setItem(SEEN_KEY, JSON.stringify([...new Set([...items.map(({ key }) => key), ...seen])].slice(0, KEEP_SEEN)));
}

TaskManager.defineTask(TASK, async () => {
  try {
    await checkStudio();
    return BackgroundTask.BackgroundTaskResult.Success;
  } catch {
    return BackgroundTask.BackgroundTaskResult.Failed;
  }
});

export async function startNotifications() {
  const { granted } = await Notifications.requestPermissionsAsync();
  if (!granted) return false;
  await Notifications.setNotificationChannelAsync(CHANNEL, { name: 'Botyard', importance: Notifications.AndroidImportance.HIGH });
  await BackgroundTask.registerTaskAsync(TASK, { minimumInterval: CHECK_MINUTES });
  return true;
}

export async function stopNotifications() {
  if (await TaskManager.isTaskRegisteredAsync(TASK)) await BackgroundTask.unregisterTaskAsync(TASK);
}
