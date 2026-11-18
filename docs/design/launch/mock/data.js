/* The demo yard's made-up launch board (Lighthouse Labs). Same shape as GET /api/studio/launch, plus `stage` used only by direction C. */
window.LAUNCH = {
  readMinutesAgo: 4,
  channels: [
    { id: 'play', name: 'Google Play' }, { id: 'appstore', name: 'App Store' }, { id: 'web', name: 'Web' }, { id: 'github', name: 'GitHub release' },
    { id: 'itch', name: 'itch.io' }, { id: 'steam', name: 'Steam' }, { id: 'crazygames', name: 'CrazyGames' }, { id: 'poki', name: 'Poki' },
  ],
  rows: [
    { name: 'Tide Tables', kind: 'Phone app', next: { channel: 'Google Play', text: 'Your yes to release 2.1.0 to production', waits: 'you', act: 'Release 2.1.0' }, cells: {
      play: { state: 'Production draft 2.1.0 (41)', tone: 'look', how: 'read', waits: 'you', next: 'Your yes to release 2.1.0 to production', act: 'Open the card', stage: 'gate' },
      appstore: { state: 'Not known: no App Store key', tone: 'wait', how: 'none', waits: 'you', next: 'Add the App Store Connect key, so it can be read', act: 'Add the key', stage: 'unset' },
      web: { state: 'Live 2.0.3', tone: 'ok', how: 'read', stage: 'live' } } },
    { name: 'Harbour Shop', kind: 'Web shop', next: { channel: 'Web', text: 'Find out why the address fails', waits: 'the crew' }, cells: {
      web: { state: 'Down: answers 502', tone: 'bad', how: 'read', since: '3 hours', waits: 'the crew', next: 'Find out why the address fails', stage: 'down' } } },
    { name: 'Signal Kit', kind: 'UI kit', next: { channel: 'GitHub release', text: 'Your yes to publish v0.9.0', waits: 'you', act: 'Publish v0.9.0' }, cells: {
      github: { state: 'Draft v0.9.0', tone: 'look', how: 'read', detail: 'Published now: v0.8.2', waits: 'you', next: 'Your yes to publish v0.9.0', act: 'Open the card', stage: 'gate' },
      itch: { state: 'Pushed 0.8.2 on html5', tone: 'ok', how: 'read', stage: 'live' } } },
    { name: 'Lantern Run', kind: 'Browser game', next: { channel: 'Poki', text: 'Say its Poki game id', waits: 'you', act: 'Add the id' }, cells: {
      web: { state: 'Live 0.7.0', tone: 'ok', how: 'read', stage: 'live' },
      itch: { state: 'Pushed 0.7.0 on html5', tone: 'ok', how: 'read', stage: 'live' },
      steam: { state: 'Store page in review', tone: 'look', how: 'told', age: '9 days', old: true, waits: 'you', next: 'Told 9 days ago: say again where it stands', act: 'Say again', stage: 'review' },
      crazygames: { state: 'Not told yet', tone: 'wait', how: 'none', waits: 'you', next: 'Say where it stands: CrazyGames cannot be read', act: 'Say where it stands', stage: 'unset' },
      poki: { state: 'Not set up', tone: 'wait', how: 'none', waits: 'you', next: 'Say its Poki game id', act: 'Add the id', stage: 'unset' } } },
    { name: 'Lighthouse Site', kind: 'Website', next: null, cells: {
      web: { state: 'Live 1.4.0', tone: 'ok', how: 'read', stage: 'live' } } },
  ],
}
/* The theme comes from ?theme=day|night, as the studio's day and night plates. */
document.documentElement.dataset.plates = new URLSearchParams(location.search).get('theme') === 'night' ? 'night' : 'day'
