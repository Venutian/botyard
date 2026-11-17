#!/usr/bin/env python3
"""Finds new free models, tests them, and hands the ones that pass to the free builder and the checker. No Claude.

Free offers rotate every week or two: OpenCode adds one and drops another, OpenRouter's :free list moves,
and a provider the owner signs in to (NVIDIA, Mistral, Kilo) brings models of its own. Once a day this
lists every model OpenCode can reach, picks the free ones worth a coding agent's time, and gives each
new one the same hidden 25-case coding test every model in setup-bots.py passed on 9 November. A full
pass adds it as strong, 22 to 24 as light, and anything less is noted and tried again in a month, or
the next day when it only timed out.
Models that disappear from the listing are dropped. Botyard's timetable runs it.

    python3 ~/.botyard/crew/free-scout.py [--dry-run]
"""
import argparse
import importlib.util
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor

sys.path.insert(0, os.path.dirname(os.path.realpath(__file__)))
import botyard_home  # noqa: E402

HERE = os.path.dirname(os.path.realpath(__file__))
BENCH = botyard_home.source('bench')
LOG = botyard_home.state('free-scout.log')
TRIED = botyard_home.state('free-tried.json')
RETRY_AFTER = 30 * 86400
MOST_PER_RUN = 6
TEST_MINUTES = 7
TASK = ('Write calc.py in the current folder with evaluate(expr, vars=None) -> fractions.Fraction. It evaluates an '
        'arithmetic expression exactly, without eval(): numbers (integers and decimals like 1.5), variables from the '
        'vars dict, + - * / ^, unary minus, parentheses, and the functions min and max with one or more comma-separated '
        'arguments. ^ is power, right-associative, and binds tighter than unary minus (so -2^2 is -4, and 2^-1 is 1/2). '
        'Whitespace is ignored. Raise ValueError for every bad input: syntax errors, unknown names, division by zero, '
        'empty input, implicit multiplication like 2(3), and min/max with no arguments. Write your own tests and run '
        'them before you finish.')
# Which models are free: OpenCode's own free offers, OpenRouter's :free, and the free-tier providers the
# owner signs in to, where every model is free but only coding-grade families are worth testing. Not Groq:
# its free plan allows 8,000 tokens a minute, less than a coding agent's own instructions, so a run there
# never starts (measured 17 November 2026: the call waits out the minute and times out).
FREE_PROVIDERS = ('nvidia/', 'mistral/')
WORTH = re.compile(r'kimi|glm-5|deepseek-v4|qwen3[.-]?(coder|8|6)|devstral|codestral|mistral-(large|medium)|'
                   r'nemotron-3-ultra|nemotron-3.5-super|gpt-oss-120b|minimax-m\d|step-5|kat-coder|north-mini-code', re.I)
SMALL = re.compile(r'(^|[-/:])(0\.\d|1(\.\d)?|2(\.\d)?|3|4|7|8|9)b\b|nano|(^|[-/:])mini([-:]|$)|lite|tiny|guard|safety|whisper|orpheus|embed', re.I)
FAMILIES = ('kimi', 'glm', 'deepseek', 'qwen', 'devstral', 'codestral', 'mistral', 'nemotron', 'gpt-oss', 'minimax',
            'gemma', 'kat', 'longcat', 'mimo', 'cohere', 'north', 'flint', 'beam', 'iceman', 'llama')


def setup():
    spec = importlib.util.spec_from_file_location('setup_bots', f'{HERE}/setup-bots.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def family(model):
    name = model.lower()
    found = next((f for f in FAMILIES if f in name), name.split('/')[-1].split('-')[0])
    return {'devstral': 'mistral', 'codestral': 'mistral', 'north': 'cohere'}.get(found, found)


def listed(bots):
    out = subprocess.run([bots.OPENCODE, 'models', '--refresh'], capture_output=True, text=True, timeout=180,
                         stdin=subprocess.DEVNULL)
    return [line.strip() for line in out.stdout.splitlines() if '/' in line and ' ' not in line.strip()]


def core(model):
    """The model's own name, without its provider or free mark. OpenRouter's free pool is small, so a model
    offered there and elsewhere is tested once; a provider with its own allowance adds a second supply."""
    return re.sub(r'(:free|-free)$', '', model.split('/')[-1].lower())


def is_free(model):
    if SMALL.search(model.split('/', 1)[1]):
        return False
    if model.startswith('opencode/'):
        # Big Pickle is free without saying so in its name (OpenCode's Zen page, 11 November 2026).
        return model.endswith('-free') or model == 'opencode/big-pickle'
    if model.startswith('openrouter/'):
        return model.endswith(':free')
    # Kilo's gateway sells hundreds of models on the same key; only those marked free cost nothing.
    if model.startswith('kilo/'):
        return model.endswith((':free', '-free')) and bool(WORTH.search(model))
    # Providers the owner signed up to on 11 November 2026 where only some models are free: Z.ai's Flash
    # models cost nothing, its others bill the key; Cloudflare gives 10,000 "neurons" a day, enough for
    # these and then it refuses, as long as the account has no paid plan.
    if model.startswith('zai/'):
        return bool(re.search(r'glm-4\.[57]-flash$', model))
    if model.startswith('cloudflare-workers-ai/'):
        # GLM-5.3 and DeepSeek V4 are listed too but refused on the Workers Free plan (17 November 2026).
        return bool(re.search(r'glm-4\.7-flash|gpt-oss-120b|qwen2\.5-coder-32b|qwen3[.-]?8', model))
    return model.startswith(FREE_PROVIDERS) and bool(WORTH.search(model))


def at(folder):
    """OpenCode works in the folder PWD names, not the one it is started in: without this the models
    wrote their test files into whatever folder the scout was run from."""
    return {**os.environ, 'PWD': folder}


def answers(bots, model):
    """One word first: a model out of its daily allowance or stuck in a queue is skipped, not judged."""
    try:
        out = subprocess.run([bots.OPENCODE, 'run', '-m', model, 'Reply with exactly: pong'], capture_output=True,
                             text=True, timeout=90, stdin=subprocess.DEVNULL, cwd=tempfile.gettempdir(),
                             env=at(tempfile.gettempdir()))
    except subprocess.TimeoutExpired:
        return False
    return 'pong' in out.stdout.lower()


def test(bots, model):
    """The hidden test's score out of 25, and how long the model took. 0 when it wrote nothing; None when
    it does not answer now."""
    if not answers(bots, model):
        return None, 0
    work = tempfile.mkdtemp(prefix='free-scout-')
    start = time.time()
    try:
        subprocess.run([bots.OPENCODE, 'run', '--dangerously-skip-permissions', '-m', model, TASK], cwd=work, env=at(work),
                       capture_output=True, text=True, timeout=TEST_MINUTES * 60, stdin=subprocess.DEVNULL)
    except subprocess.TimeoutExpired:
        pass
    took = int(time.time() - start)
    try:
        if not os.path.exists(f'{work}/calc.py'):
            return 0, took
        shutil.copy(f'{BENCH}/calc_hidden.py', f'{work}/hidden.py')
        out = subprocess.run([sys.executable, 'hidden.py'], cwd=work, capture_output=True, text=True, timeout=30)
        found = re.findall(r'(\d+)/25', out.stdout)
        return (int(found[-1]) if found else 0), took
    except subprocess.TimeoutExpired:
        return 0, took
    finally:
        shutil.rmtree(work, ignore_errors=True)


def main():
    parser = argparse.ArgumentParser(description='Find, test and add new free models')
    parser.add_argument('--dry-run', action='store_true', help='list what would be tested, and test nothing')
    args = parser.parse_args()
    bots = setup()
    if not bots.OPENCODE:
        sys.exit(botyard_home.INSTALL['opencode'])
    # Keys pasted in Botyard reach OpenCode as the variables it reads; with none, only its own free models are listed.
    os.environ.update(botyard_home.key_env())
    models = listed(bots)
    if not models:
        sys.exit('OpenCode listed no models, so nothing was changed. Check this computer is online, then run this again.')
    here = set(models)
    # What the tool lists now is what every script may offer a bot until the next listing.
    bots.keep_tool_models(models)
    found = [row for row in bots.read_json(bots.FREE_FOUND, []) if row[0] in here]
    tried = {m: t for m, t in bots.read_json(TRIED, {}).items() if time.time() - t < RETRY_AFTER}
    known = {m for m, _, _ in bots.FREE} | {row[0] for row in found}
    cores = {core(m) for m in known}
    new = [m for m in models if is_free(m) and m not in known and m not in tried
           and not (m.startswith('openrouter/') and core(m) in cores)]
    # Providers with their own allowance first: OpenRouter's one shared count of requests a day goes furthest last.
    new = sorted(new, key=lambda m: m.startswith('openrouter/'))[:MOST_PER_RUN]
    # A provider with no key here lists nothing: that is not its models going away.
    gone = [m for m, _, _ in bots.FREE if m not in here and bots.reachable(m)]
    lines = [f"gone from the listing, kept in setup-bots.py until removed there: {m}" for m in gone]
    if args.dry_run:
        print('would test:', *new, sep='\n  ')
        print(*lines, sep='\n')
        return
    with ThreadPoolExecutor(max_workers=3) as pool:
        results = list(pool.map(lambda m: (m, *test(bots, m)), new))
    for model, points, took in results:
        if points is None:
            lines.append(f"{model}: does not answer now, tried again next run")
            continue
        tier = 'strong' if points == 25 else 'light' if points >= 22 else None
        if tier:
            found.append([model, family(model), tier])
        elif points == 0 and took >= TEST_MINUTES * 60 - 5:
            # It never answered: a busy free queue (NVIDIA's hosted models at night), not a bad model.
            tried[model] = time.time() - RETRY_AFTER + 86400
        else:
            tried[model] = time.time()
        lines.append(f"{model}: {points}/25 in {took}s, {tier or 'not added'}")
    with open(bots.FREE_FOUND, 'w') as f:
        json.dump(found, f, indent=1)
    with open(TRIED, 'w') as f:
        json.dump(tried, f, indent=1)
    if lines:
        with open(LOG, 'a') as f:
            f.writelines(f"{time.strftime('%Y-%m-%d %H:%M')} {line}\n" for line in lines)
    print(*(lines or ['no new free models']), sep='\n')


if __name__ == '__main__':
    main()
