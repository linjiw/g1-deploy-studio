import http.client
import json
from pathlib import Path
import tempfile
import threading
import unittest

from studio.server import Catalog, Gateway


class ServerBoundaryTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        config = Path(self.tmp.name) / 'sessions.json'
        config.write_text(json.dumps({'sessions': [{'id': 'missing', 'path': self.tmp.name + '/absent'}]}))
        self.server = Gateway(('127.0.0.1', 0), Catalog(config))
        self.worker = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.worker.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.worker.join()
        self.tmp.cleanup()

    def get(self, path, headers=None, method='GET'):
        conn = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=3)
        conn.request(method, path, headers=headers or {})
        response = conn.getresponse()
        result = (response.status, response.read())
        conn.close()
        return result

    def test_safety_and_unavailable_catalog(self):
        status, body = self.get('/api/safety')
        data = json.loads(body)
        self.assertEqual(status, 200)
        self.assertFalse(data['hardware_enabled'])
        self.assertEqual(data['publishers'], [])
        self.assertEqual(data['dds_participants'], 0)
        self.assertFalse(json.loads(self.get('/api/sessions')[1])['sessions'][0]['available'])

    def test_http_boundaries(self):
        for path in ['/../AGENTS.md', '/%2e%2e/config/references.json', '/vendor/three/../../package.json', '/api/session?id=bad']:
            self.assertEqual(self.get(path)[0], 404)
        self.assertEqual(self.get('/api/sessions', {'Host': 'attacker.invalid'})[0], 403)
        self.assertEqual(self.get('/api/sessions', {'Origin': 'https://attacker.invalid'})[0], 403)
        self.assertEqual(self.get('/api/sessions', {'Sec-Fetch-Site': 'cross-site'})[0], 403)
        self.assertEqual(self.get('/api/control', method='POST')[0], 405)
        self.assertEqual(self.get('/api/session?id=missing')[0], 422)

    def test_fails_closed_on_public_binding(self):
        with self.assertRaises(ValueError):
            Gateway(('0.0.0.0', 0), self.server.catalog)

    def test_disconnect_keeps_gateway_working(self):
        conn = http.client.HTTPConnection('127.0.0.1', self.server.server_port)
        conn.request('GET', '/api/sessions')
        conn.close()
        self.assertEqual(self.get('/api/safety')[0], 200)


if __name__ == '__main__':
    unittest.main()
