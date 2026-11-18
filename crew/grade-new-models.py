#!/usr/bin/env python3
"""New free models get their benchmark grade asked for, once: no AI here.

    python3 grade-new-models.py          open one job for the lead if any free model has no grade yet
    python3 grade-new-models.py --dry    only say which

Every free model the crew can use (setup-bots.py free_list: the built-in list, what free-scout.py finds, any
provider added later) is shown with a chip against Claude from the moment it appears: the crew's own checks
until three are in, "unrated" before that. Its published grade (SWE-bench Verified against Claude, in
studio/server/lib/model-grades.json) needs a web search, which a bot does: this script finds the models with no
row and no "no published score" entry, and opens one job for the lead to have them graded. A model is asked
about once (grade-asked.json).
"""
import importlib.util
import json
import os
import re
import sys
import time
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.realpath(__file__)))
import botyard_home  # noqa: E402

HERE = os.path.dirname(os.path.realpath(__file__))
GRADES = os.path.join(HERE, '..', 'studio', 'server', 'lib', 'model-grades.json')
ASKED = botyard_home.state('grade-asked.json')
SIGN = '\n\n<!-- botyard-script: grade-new-models -->'


def _bots():
    spec = importlib.util.spec_from_file_location('setup_bots', os.path.join(HERE, 'setup-bots.py'))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def slug(text):
    return re.sub(r'[^a-z0-9]+', '', str(text).lower())


def known(model, table):
    """True when the table grades the model or records that it has no published score."""
    name = slug(re.sub(r'(:free|-free)$', '', model.split('/')[-1]))
    keys = [m for row in table.get('models', []) for m in row.get('match', [])] + table.get('no_published_score', [])
    return any(slug(k) and slug(k) in name for k in keys)


def ungraded(models, table, asked):
    return [m for m in models if not known(m, table) and m not in asked]


def brief(models):
    rows = '\n'.join(f'- {m}' for m in models)
    return (f"New free models have no published coding grade yet:\n{rows}\n\n"
            "For each, look up its SWE-bench Verified score online (an independent run such as Vals.ai first, the maker's own claim if that is all there is, "
            "and say which). Set it against Claude's score on the same benchmark (the baselines in the file) and add a row to "
            "`studio/server/lib/model-grades.json` in the Botyard repo: name, match (the part of the model's id that names it), score, benchmark, "
            "independent, grade (-Haiku, Haiku, +Haiku, Sonnet, +Sonnet, Opus), source, note. A model with no published score goes into "
            "`no_published_score` by name instead. Never guess a number. Land it as usual; the page and the phone show the new chips at once, "
            "and the free models are tried best first by them." + SIGN)


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    table = json.load(open(GRADES))
    try:
        asked = json.load(open(ASKED))
    except (OSError, ValueError):
        asked = {}
    models = [m for m, _, _ in _bots().free_list()]
    new = ungraded(models, table, asked)
    if not new:
        print('every free model has a grade or a recorded "no published score"')
        return 0
    print('to grade:', ', '.join(new))
    if '--dry' in argv:
        return 0
    api = botyard_home.api()
    studio = botyard_home.studio_id()
    headers = {'Content-Type': 'application/json', **botyard_home.script_headers()}
    get = lambda path: json.loads(urllib.request.urlopen(urllib.request.Request(api + path, headers=headers), timeout=30).read() or b'[]')
    lead = next((a for a in get(f'/companies/{studio}/agents') if a.get('role') == 'ceo'), None)
    if not lead:
        print('no lead in the crew to ask')
        return 1
    body = {'title': f'Grade {len(new)} new free model{"s" if len(new) > 1 else ""} on SWE-bench Verified', 'status': 'todo',
            'priority': 'low', 'assigneeAgentId': lead['id'], 'description': brief(new)}
    urllib.request.urlopen(urllib.request.Request(f'{api}/companies/{studio}/issues', data=json.dumps(body).encode(), headers=headers, method='POST'), timeout=30)
    for m in new:
        asked[m] = int(time.time())
    tmp = ASKED + '.tmp'
    json.dump(asked, open(tmp, 'w'), indent=1)
    os.replace(tmp, ASKED)
    print(f'asked the lead to grade {len(new)}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
