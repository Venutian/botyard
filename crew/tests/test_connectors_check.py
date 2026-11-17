"""The connector health check finds a gateway that is not there, and never prints a bot's pass."""
import http.server
import importlib.util
import json
import os
import tempfile
import threading
import unittest

CREW = os.path.dirname(os.path.dirname(os.path.realpath(__file__)))
spec = importlib.util.spec_from_file_location('connectors_check', os.path.join(CREW, 'connectors-check.py'))
check = importlib.util.module_from_spec(spec)
spec.loader.exec_module(check)


class Gateway(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        self.rfile.read(int(self.headers.get('Content-Length', 0)))
        gone = self.path.startswith('/api/mcp/gone/')
        self.send_response(404 if gone else 403)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(b'{"error":"API route not found"}' if gone else b'{"jsonrpc":"2.0","error":{}}')

    def log_message(self, *a):
        pass


class ConnectorsCheck(unittest.TestCase):
    def test_a_missing_route_is_a_fault_and_the_pass_is_never_shown(self):
        server = http.server.HTTPServer(('127.0.0.1', 0), Gateway)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.shutdown)
        base = f'http://127.0.0.1:{server.server_port}'
        folder = tempfile.mkdtemp()
        json.dump({'mcpServers': {'github': {'type': 'http', 'url': f'{base}/api/mcp/github/SECRETPASS'}}}, open(os.path.join(folder, 'lead.claude.json'), 'w'))
        self.assertEqual(check.faults(folder), [], 'an answer from the gateway, even a refusal, is fine')
        json.dump({'mcpServers': {'gone': {'type': 'http', 'url': f'{base}/api/mcp/gone/SECRETPASS'}}}, open(os.path.join(folder, 'lead.claude.json'), 'w'))
        found = check.faults(folder)
        self.assertEqual(len(found), 1)
        self.assertIn('ENDPOINT_NOT_FOUND', found[0])
        self.assertNotIn('SECRETPASS', found[0])
        json.dump({'mcp': {'x': {'url': 'http://127.0.0.1:1/api/mcp/x/SECRETPASS'}}}, open(os.path.join(folder, 'b.opencode.json'), 'w'))
        self.assertTrue(any('not reachable' in f and 'SECRETPASS' not in f for f in check.faults(folder)))
