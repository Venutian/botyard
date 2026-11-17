#!/usr/bin/env python3
"""Can each bot's connector config reach the gateway? No AI, and the pass is never printed.

For every file in the bots' connectors folder (<bot>.claude.json, <bot>.opencode.json), POST an
MCP `initialize` to each server URL in it. A 404 ("API route not found") or no answer is a fault;
any other answer (even a refusal) means the road to the gateway is there.

    python3 connectors-check.py        one line per fault
"""
import glob
import json
import os
import re
import sys
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.realpath(__file__))
INIT = {'jsonrpc': '2.0', 'id': 1, 'method': 'initialize', 'params': {'protocolVersion': '2025-06-18', 'capabilities': {}, 'clientInfo': {'name': 'health', 'version': '1'}}}


def urls(path):
    """The (connector, url) pairs in one bot's config file."""
    try:
        data = json.load(open(path))
    except (OSError, ValueError):
        return []
    servers = data.get('mcpServers') or data.get('mcp') or {}
    return [(name, s['url']) for name, s in servers.items() if isinstance(s, dict) and s.get('url')]


def hide(url):
    """The address without the pass: /api/mcp/<connector>/<pass> becomes /api/mcp/<connector>/..."""
    return re.sub(r'(/api/mcp/[^/]+/)[^/?#]+', r'\1...', url)


def probe(url, timeout=5):
    """'' when the gateway answered, else why not (never with the pass in it)."""
    req = urllib.request.Request(url, data=json.dumps(INIT).encode(), method='POST',
                                 headers={'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream'})
    try:
        urllib.request.urlopen(req, timeout=timeout).read(1)
        return ''
    except urllib.error.HTTPError as err:
        if err.code == 404:
            return 'ENDPOINT_NOT_FOUND (404)'
        return ''
    except Exception as err:  # refused, timed out, not an address
        return f'not reachable ({type(err).__name__})'


def faults(folder=None, probe=probe):
    folder = folder or os.environ.get('BOTYARD_BOT_CONNECTORS') or os.path.join(HERE, 'connectors')
    out = []
    for path in sorted(glob.glob(os.path.join(folder, '*.json'))):
        for name, url in urls(path):
            why = probe(url)
            if why:
                out.append(f'{os.path.basename(path)}: {name} at {hide(url)}: {why}')
    return out


if __name__ == '__main__':
    found = faults()
    print('\n'.join(found) if found else 'connectors: ok')
    sys.exit(1 if found else 0)
