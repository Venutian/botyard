import { StatusBar } from 'expo-status-bar';
import * as SecureStore from 'expo-secure-store';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Animated, AppState, BackHandler, Easing, Linking, Platform, Pressable, StyleSheet, useWindowDimensions, View } from 'react-native';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import { claimDevice, Connection, faceSource, getFaces, getFirstRun, hello, onPC } from './src/api';
import { setSharedFaces } from './src/mascot/look';
import { ChatBot } from './src/api';
import { Crew, leadOf, Nav, Route, Tab, useCrew } from './src/crew';
import { JobLinks } from './src/ui/Markdown';
import { BotScreen } from './src/screens/Bot';
import { BotEditScreen } from './src/screens/BotEdit';
import { BotNewScreen } from './src/screens/BotNew';
import { BotRulesScreen } from './src/screens/BotRules';
import { FirstRunScreen } from './src/screens/FirstRun';
import { ProjectEditScreen, ProjectNewScreen } from './src/screens/ProjectEdit';
import { RoutineScreen } from './src/screens/Routine';
import { SetupScreen } from './src/screens/Setup';
import { leaving } from './src/ui/form';
import { ChatScreen } from './src/screens/Chat';
import { ConnectScreen } from './src/screens/Connect';
import { CONNECTION_KEY, startNotifications, stopNotifications } from './src/notify';
import { ChangesScreen } from './src/screens/Changes';
import { ReviewScreen } from './src/screens/Review';
import { TrayScreen } from './src/screens/Tray';
import { HomeScreen } from './src/screens/Home';
import { DevicesScreen } from './src/screens/Devices';
import { RoutinesScreen } from './src/screens/Routines';
import { TracksScreen } from './src/screens/Tracks';
import { TripScreen } from './src/screens/Trip';
import { JobScreen, NewJobScreen } from './src/screens/Job';
import { ImprovementsScreen } from './src/screens/Improvements';
import { ModelsScreen } from './src/screens/Models';
import { BotsScreen } from './src/screens/Crew';
import { JobsScreen } from './src/screens/Jobs';
import { CompanyScreen, LibraryScreen } from './src/screens/Library';
import { ConnectorScreen, ConnectorsScreen } from './src/screens/Connectors';
import { ProjectScreen, ProjectsScreen } from './src/screens/Projects';
import { RunScreen, RunsScreen } from './src/screens/Runs';
import { StudioScreen } from './src/screens/Studio';
import { StyleScreen } from './src/screens/Style';
import { BotBadge } from './src/mascot/BotBadge';
import { portraitOf } from './src/mascot/look';
import { LookProvider, Prefs, useLook } from './src/theme/prefs';
import { Icon, IconName } from './src/ui/Icon';
import { Txt, useTap } from './src/ui/kit';
import { tell } from './src/ui/ask';
import { Wallpaper } from './src/ui/Wallpaper';

const WEB = Platform.OS === 'web';
/** From this width, on the PC, chats sit beside the conversation instead of under it. */
const WIDE = 900;
const LIST_WIDTH = 400;
const RESTING = portraitOf({ name: 'Lead', role: 'lead' });
const useNativeDriver = !WEB;
/**
 * The web build is for checking the design, so it skips pairing and runs on sample data. The app has
 * no address built in: it learns the PC's from pairing, and the ways in from away from the door's /v1/hello.
 */
const SAMPLE: Connection = { host: '192.168.0.2:5288', token: '' };
/** How often the app asks the PC for its other ways in, until it hears back. */
const HELLO_RETRY_MS = 30_000;

const secure = {
  // Add ?pair to the web address to see the pairing screen.
  get: () => (WEB ? Promise.resolve(window.location.search.includes('pair') ? null : JSON.stringify(SAMPLE)) : SecureStore.getItemAsync(CONNECTION_KEY)),
  set: (value: string) => (WEB ? Promise.resolve() : SecureStore.setItemAsync(CONNECTION_KEY, value)),
  clear: () => (WEB ? Promise.resolve() : SecureStore.deleteItemAsync(CONNECTION_KEY)),
};

function parseLink(url: string | null): Connection | null {
  const match = url?.match(/^botyard:\/\/connect\?(.+)$/);
  if (!match) return null;
  const params = Object.fromEntries(match[1].split('&').map((p) => p.split('=').map(decodeURIComponent)));
  if (!params.host || !params.token) return null;
  // A link made with `npm run pair -- --edge` also carries Cloudflare's way in, so a phone can pair from
  // away from home. It is taken only over HTTPS with a well-formed gate, as the PC's own hello is.
  const edge = /^https:\/\/[a-z0-9.-]+$/.test(params.edge || '') && /^[0-9a-f]{64}$/.test(params.gate || '') ? { host: params.edge, gate: params.gate } : undefined;
  return { host: params.host, token: params.token, deviceId: params.device, away: params.away, edge };
}

/** The phone chats with the studio's lead alone, so the chat tab opens that conversation instead of a list. */
const LEAD = 'lead';
type TabId = Tab | typeof LEAD;
const TABS: { id: TabId; name: string; icon: IconName }[] = [
  { id: 'home', name: 'Now', icon: 'home' },
  { id: LEAD, name: 'Lead', icon: 'chat' },
  { id: 'studio', name: 'Studio', icon: 'studio' },
  { id: 'style', name: 'Style', icon: 'style' },
];

const isUnread = (bot: ChatBot, p: Prefs) => {
  const last = bot.lastMessage;
  return Boolean(last && !last.mine && last.at > (p.seen[bot.id] ?? ''));
};

function TabBar({ tab, onChange, unread }: { tab: Tab; onChange: (next: TabId) => void; unread: boolean }) {
  const { p, t } = useLook();
  const insets = useSafeAreaInsets();
  const tap = useTap();
  return (
    <View pointerEvents="box-none" style={[styles.tabHolder, { bottom: Math.max(insets.bottom, 12) }]}>
      <View style={[styles.tabBar, { backgroundColor: t.plates ? t.panel : t.glass, borderColor: t.outline ? (t.plates && t.dark ? '#05070a' : t.ink) : t.line, borderWidth: t.outline ? 2 : StyleSheet.hairlineWidth, boxShadow: t.shadow }, t.plates && { borderRadius: 12 }]}>
        {TABS.map(({ id, name, icon }) => {
          const active = tab === id;
          return (
            <Pressable
              key={id}
              accessibilityRole="tab"
              accessibilityLabel={name}
              accessibilityState={{ selected: active }}
              onPress={() => {
                tap();
                onChange(id);
              }}
              style={[styles.tab, t.plates && { borderRadius: 8 }, active && { backgroundColor: t.plates ? t.ink : t.accent }]}
            >
              <Icon name={icon} size={21} color={active ? (t.plates ? t.card : t.accentInk) : t.ink2} />
              {p.tabLabels ? <Txt size={13} weight={700} color={active ? (t.plates ? t.card : t.accentInk) : t.ink2}>{name}</Txt> : null}
              {id === LEAD && unread ? <View style={[styles.tabDot, { backgroundColor: t.accent }]} /> : null}
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

function Pushed({ route, connection, crew, nav }: { route: Route; connection: Connection; crew: Crew; nav: Nav }) {
  const { t } = useLook();
  const slide = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(slide, { toValue: 1, duration: 220, easing: Easing.out(Easing.cubic), useNativeDriver }).start();
  }, [slide]);
  return (
    <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: t.app, opacity: slide, transform: [{ translateX: slide.interpolate({ inputRange: [0, 1], outputRange: [36, 0] }) }] }]}>
      {route.name === 'chat' ? <ChatScreen key={route.botId} botId={route.botId} connection={connection} crew={crew} nav={nav} /> : null}
      {route.name === 'job' ? <JobScreen key={route.id} id={route.id} connection={connection} crew={crew} nav={nav} /> : null}
      {route.name === 'changes' ? <ChangesScreen id={route.id} connection={connection} nav={nav} /> : null}
      {route.name === 'tray' ? <TrayScreen connection={connection} nav={nav} /> : null}
      {route.name === 'review' ? <ReviewScreen key={`${route.job ?? ''}${route.bot ?? ''}`} job={route.job} bot={route.bot} connection={connection} nav={nav} /> : null}
      {route.name === 'routines' ? <RoutinesScreen connection={connection} crew={crew} nav={nav} /> : null}
      {route.name === 'bots' ? <BotsScreen connection={connection} nav={nav} /> : null}
      {route.name === 'runs' ? <RunsScreen key={route.bot ?? ''} bot={route.bot} connection={connection} nav={nav} /> : null}
      {route.name === 'run' ? <RunScreen key={route.id} id={route.id} connection={connection} nav={nav} /> : null}
      {route.name === 'jobs' ? <JobsScreen project={route.project} bot={route.bot} connection={connection} nav={nav} /> : null}
      {route.name === 'projects' ? <ProjectsScreen connection={connection} nav={nav} /> : null}
      {route.name === 'project' ? <ProjectScreen key={route.id} id={route.id} connection={connection} nav={nav} /> : null}
      {route.name === 'library' ? <LibraryScreen connection={connection} nav={nav} /> : null}
      {route.name === 'company' ? <CompanyScreen connection={connection} nav={nav} /> : null}
      {route.name === 'connectors' ? <ConnectorsScreen connection={connection} nav={nav} /> : null}
      {route.name === 'connector' ? <ConnectorScreen id={route.id} connection={connection} nav={nav} /> : null}
      {route.name === 'models' ? <ModelsScreen connection={connection} nav={nav} /> : null}
      {route.name === 'improvements' ? <ImprovementsScreen connection={connection} nav={nav} /> : null}
      {route.name === 'devices' ? <DevicesScreen connection={connection} nav={nav} /> : null}
      {route.name === 'new' ? <NewJobScreen connection={connection} crew={crew} nav={nav} /> : null}
      {route.name === 'bot' ? <BotScreen key={route.botId} botId={route.botId} connection={connection} crew={crew} nav={nav} /> : null}
      {route.name === 'botEdit' ? <BotEditScreen key={route.botId} botId={route.botId} connection={connection} nav={nav} /> : null}
      {route.name === 'botRules' ? <BotRulesScreen key={route.botId} botId={route.botId} botName={route.botName} connection={connection} crew={crew} nav={nav} /> : null}
      {route.name === 'botNew' ? <BotNewScreen from={route.from} connection={connection} nav={nav} /> : null}
      {route.name === 'setup' ? <SetupScreen connection={connection} nav={nav} /> : null}
      {route.name === 'firstRun' ? <FirstRunScreen step={route.step} connection={connection} nav={nav} /> : null}
      {route.name === 'projectNew' ? <ProjectNewScreen connection={connection} nav={nav} /> : null}
      {route.name === 'projectEdit' ? <ProjectEditScreen key={route.id} id={route.id} connection={connection} nav={nav} /> : null}
      {route.name === 'routine' ? <RoutineScreen key={route.id} id={route.id} connection={connection} crew={crew} nav={nav} /> : null}
      {route.name === 'tracks' ? <TracksScreen connection={connection} nav={nav} /> : null}
      {route.name === 'trip' ? <TripScreen key={route.id} id={route.id} connection={connection} nav={nav} /> : null}
    </Animated.View>
  );
}

function Studio({ connection, onForget }: { connection: Connection; onForget: () => void }) {
  const { p, t } = useLook();
  const crew = useCrew(connection);
  const { width } = useWindowDimensions();
  const wide = width >= WIDE;
  const [tab, setTab] = useState<Tab>('home');
  const [stack, setStack] = useState<Route[]>([]);
  // The screen on top, for the guard that asks before unsaved work is left.
  const top = useRef<Route | undefined>(undefined);
  top.current = stack[stack.length - 1];

  const nav = useMemo<Nav>(() => ({
    // Beside the list, choosing another chat swaps the conversation instead of piling on it.
    push: (route) => setStack((current) => (wide && route.name === 'chat' ? [route] : [...current, route])),
    back: () => {
      // A screen with unsaved work asks first, and steps back itself on a yes.
      if (leaving.blocked(top.current?.name)) return;
      setStack((current) => current.slice(0, -1));
      crew.reload();
    },
    replace: (route) => setStack((current) => {
      const rest = current.slice(0, -1);
      return JSON.stringify(rest[rest.length - 1]) === JSON.stringify(route) ? rest : [...rest, route];
    }),
  }), [crew.reload, wide]);
  // An empty studio opens on its first run, once each time the app starts. The PC window has its own.
  const offered = useRef(false);
  useEffect(() => {
    if (offered.current || onPC()) return;
    offered.current = true;
    getFirstRun(connection).then((first) => first.show && setStack((current) => (current.length ? current : [{ name: 'firstRun' }]))).catch(() => undefined);
  }, [connection]);
  // A job link in any message opens that job here.
  const openJob = useCallback((ref: string) => nav.push({ name: 'job', id: ref }), [nav]);

  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      if (stack.length) {
        nav.back();
        return true;
      }
      if (tab !== 'home') {
        setTab('home');
        return true;
      }
      return false;
    });
    return () => subscription.remove();
  }, [stack.length, tab, nav]);

  const lead = leadOf(crew.bots);
  const unread = Boolean(lead && isUnread(lead, p));
  const choose = (next: TabId) => {
    if (next !== LEAD) return setTab(next);
    if (lead) nav.push({ name: 'chat', botId: lead.id });
    // A studio with no lead has nobody to open by default: show the crew, and any of them can be chatted with.
    else if (crew.bots?.length) nav.push({ name: 'bots' });
    else tell('No bot is here yet', crew.error || (crew.bots ? 'This studio has no bots yet. Add one from the Studio tab.' : 'The crew list is still loading. Try again in a moment.'));
  };
  const list = (
    <>
      {p.wallpaperEverywhere ? <Wallpaper id={p.wallpaper} /> : null}
      {tab === 'home' ? <HomeScreen connection={connection} crew={crew} nav={nav} /> : null}
      {tab === 'studio' ? <StudioScreen connection={connection} nav={nav} /> : null}
      {tab === 'style' ? <StyleScreen crew={crew} nav={nav} onForget={onForget} /> : null}
      <TabBar tab={tab} onChange={choose} unread={unread} />
    </>
  );
  const pushed = stack.map((route, index) => <Pushed key={`${route.name}-${index}`} route={route} connection={connection} crew={crew} nav={nav} />);

  if (wide) {
    return (
      <JobLinks.Provider value={openJob}>
      <View style={styles.panes}>
        <View style={[styles.listPane, { borderRightColor: t.line }]}>{list}</View>
        <View style={styles.fill}>
          {stack.length ? pushed : (
            <View style={styles.resting}>
              <BotBadge who={RESTING} size={120} state="free" />
              <Txt color={t.ink2}>Pick a job, or talk to the lead.</Txt>
            </View>
          )}
        </View>
      </View>
      </JobLinks.Provider>
    );
  }

  return (
    <JobLinks.Provider value={openJob}>
    <View style={styles.fill}>
      {list}
      {pushed}
      <StatusBar style={t.dark ? 'light' : 'dark'} />
    </View>
    </JobLinks.Provider>
  );
}

function Root() {
  const { p, t } = useLook();
  const [connection, setConnection] = useState<Connection | null>(null);
  // The bots' portraits, as the map on the PC shows them: read once per connection, shown wherever a bot is.
  const [, facesRead] = useState(0);
  useEffect(() => {
    if (!connection) return;
    let gone = false;
    getFaces(connection).then(async ({ faces }) => {
      const out: Record<string, { uri: string; headers?: Record<string, string> }> = {};
      for (const [id, name] of Object.entries(faces)) {
        const source = await faceSource(connection, name).catch(() => null);
        if (source) out[id] = source;
      }
      if (gone) return;
      setSharedFaces(out);
      facesRead((n) => n + 1);
    }).catch(() => {});
    return () => { gone = true; };
  }, [connection]);
  const [ready, setReady] = useState(false);
  // The newest connection, so answers that arrive late change it rather than an older copy.
  const latest = useRef<Connection | null>(null);
  const claimed = useRef<string | null>(null);

  const remember = useCallback(async (next: Connection) => {
    latest.current = next;
    await secure.set(JSON.stringify(next));
    setConnection(next);
  }, []);

  const amend = useCallback((change: Partial<Connection>) => {
    if (latest.current) remember({ ...latest.current, ...change });
  }, [remember]);

  const forget = useCallback(async () => {
    latest.current = null;
    claimed.current = null;
    await secure.clear();
    setConnection(null);
  }, []);

  useEffect(() => {
    (async () => {
      const paired = parseLink(await Linking.getInitialURL());
      if (paired) {
        await remember(paired);
      } else {
        const saved = await secure.get();
        if (saved) {
          latest.current = JSON.parse(saved);
          setConnection(latest.current);
        }
      }
      setReady(true);
    })();
    const subscription = Linking.addEventListener('url', ({ url }) => {
      const paired = parseLink(url);
      if (paired) remember(paired);
    });
    return () => subscription.remove();
  }, [remember]);

  // A device paired with a shared or typed-in key swaps it for its own the first time it can, once.
  useEffect(() => {
    if (WEB || !connection || connection.deviceId || claimed.current === connection.token) return;
    claimed.current = connection.token;
    const name = (Platform.constants as { Model?: string }).Model || 'Phone';
    claimDevice(connection, name).then(({ id, key }) => amend({ token: key, deviceId: id })).catch(() => {
      claimed.current = null;
    });
  }, [connection, amend]);

  // The PC tells the app its other ways in, so away access needs nothing typed on the phone. It can
  // only say so while the app can reach it, so the app keeps asking until it hears, and asks again
  // each time it comes back to the front.
  useEffect(() => {
    if (WEB || !connection) return;
    let heard = false;
    const ask = () => hello(connection).then(({ away, edge }) => {
      heard = true;
      // The edge only over HTTPS, so the key never crosses the internet readable.
      const cloud = edge && /^https:\/\/[a-z0-9.-]+$/.test(edge.host) && /^[0-9a-f]{64}$/.test(edge.gate) ? edge : undefined;
      const current = latest.current;
      if ((away ?? undefined) !== current?.away || JSON.stringify(cloud) !== JSON.stringify(current?.edge)) {
        amend({ away: away ?? undefined, edge: cloud });
      }
    }).catch(() => undefined);
    ask();
    const retry = setInterval(() => !heard && ask(), HELLO_RETRY_MS);
    const front = AppState.addEventListener('change', (state) => state === 'active' && ask());
    return () => {
      clearInterval(retry);
      front.remove();
    };
  }, [connection, amend]);

  const paired = Boolean(connection);
  useEffect(() => {
    if (WEB || !paired) return;
    (p.notify ? startNotifications() : stopNotifications()).catch(() => undefined);
  }, [paired, p.notify]);

  return (
    <View style={[styles.fill, { backgroundColor: t.app }]}>
      {!ready ? <View style={styles.center}><ActivityIndicator color={t.accent} /></View> : connection ? <Studio connection={connection} onForget={forget} /> : <ConnectScreen onConnect={remember} />}
    </View>
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <LookProvider>
        <Root />
      </LookProvider>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  panes: { flex: 1, flexDirection: 'row' },
  listPane: { borderRightWidth: 1, width: LIST_WIDTH },
  resting: { alignItems: 'center', flex: 1, gap: 10, justifyContent: 'center' },
  center: { alignItems: 'center', flex: 1, justifyContent: 'center' },
  tabHolder: { alignItems: 'center', left: 0, position: 'absolute', right: 0 },
  tabBar: { borderRadius: 30, flexDirection: 'row', gap: 4, padding: 5 },
  tab: { alignItems: 'center', borderRadius: 25, flexDirection: 'row', gap: 7, justifyContent: 'center', minHeight: 48, minWidth: 58, paddingHorizontal: 13 },
  tabDot: { borderRadius: 4, height: 8, position: 'absolute', right: 12, top: 9, width: 8 },
});
