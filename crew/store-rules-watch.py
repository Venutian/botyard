#!/usr/bin/env python3
"""The store rules are kept current, once a week: no AI here.

    python3 store-rules-watch.py          open one job for the lead to read the stores' and laws' change pages
    python3 store-rules-watch.py --dry    only say whether it would

Botyard's store scan (studio/server/lib/store-scan/, docs/store-rules.md) holds rules, dates and statements that
change: Play raises its target level every August, Apple its SDK every spring, laws come into force. A bot reads the
official pages; this script only opens that job, at most one at a time and one a week (store-rules-watch.json).
"""
import json
import os
import sys
import time
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.realpath(__file__)))
import botyard_home  # noqa: E402

STATE = botyard_home.state('store-rules-watch.json')
SIGN = '\n\n<!-- botyard-script: store-rules-watch -->'
WEEK = 7 * 86400
SOURCES = [
    ('Apple: upcoming requirements', 'https://developer.apple.com/news/upcoming-requirements/'),
    ('Apple: developer news', 'https://developer.apple.com/news/'),
    ('Apple: App Review Guidelines (and their change list)', 'https://developer.apple.com/app-store/review/guidelines/'),
    ('Google Play: policy announcements', 'https://support.google.com/googleplay/android-developer/announcements'),
    ('Google Play: target API level', 'https://developer.android.com/google/play/requirements/target-sdk'),
    ('Google Play: developer policy center', 'https://play.google/developer-content-policy/'),
    ('EU: digital strategy (AI Act, Cyber Resilience Act, DSA)', 'https://digital-strategy.ec.europa.eu/en/news'),
    ('US: FTC children\'s privacy', 'https://www.ftc.gov/business-guidance/privacy-security/childrens-privacy'),
]


def brief(since):
    rows = '\n'.join(f'- {name}: {url}' for name, url in SOURCES)
    return (
        f"Keep Botyard's store rules current. Read what changed on these official pages since {since}:\n{rows}\n\n"
        "Then, in the Botyard repository, change only what an official page now says:\n"
        "- `studio/server/lib/store-scan/rules.mjs`: a rule a store added, changed or dropped (its level stop, fix or look, "
        "its plain title and fix, its official page); Play's target level by date (`PLAY_TARGET`).\n"
        "- `studio/server/lib/store-scan/owner.mjs`: a law or store duty that now applies or has a new date (`STATEMENTS`, "
        "raising `revision` when what the owner states changes), a console form (`CONSOLE`), a dated change (`DATES`).\n"
        "- `docs/store-rules.md`: the same, in words; and a test for each new rule in `studio/test/store-scan.test.mjs`.\n"
        "Every change names its official page and the day it applies. Never add what a page does not say, and never "
        "name or copy another product's rules. When nothing changed, say so in your report and change nothing. Land it as usual."
        + SIGN)


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    try:
        state = json.load(open(STATE))
    except (OSError, ValueError):
        state = {}
    now = time.time()
    api = botyard_home.api()
    studio = botyard_home.studio_id()
    headers = {'Content-Type': 'application/json', **botyard_home.script_headers()}
    get = lambda path: json.loads(urllib.request.urlopen(urllib.request.Request(api + path, headers=headers), timeout=30).read() or b'[]')
    if state.get('job'):
        try:
            job = get(f"/issues/{state['job']}")
            if job.get('status') not in ('done', 'cancelled'):
                print(f"the last watch ({job.get('identifier', state['job'])}) is still open")
                return 0
        except Exception:  # noqa: BLE001 - a job that cannot be read is treated as ended
            pass
    if now - float(state.get('at') or 0) < WEEK:
        print('watched less than a week ago')
        return 0
    since = time.strftime('%Y-%m-%d', time.gmtime(float(state['at']))) if state.get('at') else 'the last 90 days'
    print(f'to watch: changes since {since}')
    if '--dry' in argv:
        return 0
    lead = next((a for a in get(f'/companies/{studio}/agents') if a.get('role') == 'ceo' and a.get('status') != 'terminated'), None)
    if not lead:
        print('no lead in the crew to ask')
        return 1
    body = {'title': "Store rules: this week's changes from Apple, Google and the EU", 'status': 'todo', 'priority': 'low',
            'assigneeAgentId': lead['id'], 'description': brief(since)}
    made = json.loads(urllib.request.urlopen(urllib.request.Request(f'{api}/companies/{studio}/issues', data=json.dumps(body).encode(), headers=headers, method='POST'), timeout=30).read() or b'{}')
    tmp = STATE + '.tmp'
    json.dump({'at': now, 'job': made.get('id', '')}, open(tmp, 'w'), indent=1)
    os.replace(tmp, STATE)
    print(f"asked the lead ({made.get('identifier', '')})")
    return 0


if __name__ == '__main__':
    sys.exit(main())
