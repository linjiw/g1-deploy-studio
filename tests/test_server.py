import http.client
import json
from pathlib import Path
import socket
import tempfile
import threading
import unittest

from studio.server import Catalog, Gateway, loopback_gateways


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
        # A configured source whose file is absent is Not Found, without its filesystem path.
        status, body = self.get('/api/session?id=missing')
        self.assertEqual(status, 404)
        self.assertIn('no replayable recording', json.loads(body)['error'])

    def test_fails_closed_on_public_binding(self):
        for host in ['0.0.0.0', '::', 'localhost', '192.0.2.1']:
            with self.subTest(host=host), self.assertRaises(ValueError):
                Gateway((host, 0), self.server.catalog)

    def test_terminal_provider_becomes_static_and_replay_cache_is_bounded(self):
        catalog = self.server.catalog
        path = Path(self.tmp.name)/'finished.json'
        payload = {'schema_version': 1, 'metadata': {'fixture': True}, 'frames': [{'time': 0}]}
        path.write_text(json.dumps(payload))
        calls = []
        def provider():
            calls.append(1)
            return payload
        catalog.register('finished', path, 'Fixture', provider=provider)
        catalog.session('finished')
        catalog.session('finished')
        self.assertEqual(len(calls), 2, 'Active providers must refresh')
        catalog.register('finished', path, 'Fixture')
        first = catalog.session('finished')
        self.assertIs(first, catalog.session('finished'))
        self.assertEqual(len(calls), 2, 'Completed replay must stop invoking the provider')
        for index in range(5):
            catalog.register(f'fixture-{index}', path, 'Fixture')
            catalog.session(f'fixture-{index}')
        self.assertEqual(len(catalog.cache), 4)
        self.assertNotIn('finished', catalog.cache)
        catalog.session('fixture-1')
        catalog.session('finished')
        self.assertIn('fixture-1', catalog.cache, 'Recently used replay must survive eviction')
        self.assertNotIn('fixture-2', catalog.cache)

    def test_forwarded_local_authority_and_matching_origin(self):
        for host in ['localhost:64842', '127.0.0.1:64842', '[::1]:64842', 'localhost']:
            with self.subTest(host=host):
                status, body = self.get('/api/safety', {'Host': host, 'Origin': 'http://' + host})
                self.assertEqual(status, 200)
                self.assertTrue(json.loads(body)['read_only'])
                self.assertEqual(self.get('/', {'Host': host})[0], 200)

    def test_forwarded_authority_does_not_relax_origin_boundary(self):
        invalid_hosts = ['attacker.invalid:64842', 'localhost.attacker.invalid:64842',
                         '127.0.0.1.attacker.invalid:64842', 'user@localhost:64842',
                         'localhost:65536', 'localhost:0', 'localhost:064842',
                         'localhost:64842/path', 'localhost:64842,attacker.invalid',
                         '[::]:64842', '[::ffff:127.0.0.1]:64842', '2130706433:64842', '']
        for host in invalid_hosts:
            with self.subTest(host=host):
                self.assertEqual(self.get('/api/safety', {'Host': host})[0], 403)
        for origin in ['http://localhost:8790', 'http://127.0.0.1:64842',
                       'https://localhost:64842', 'http://attacker.invalid',
                       'http://localhost:64842.attacker.invalid', 'null', '']:
            with self.subTest(origin=origin):
                self.assertEqual(self.get('/api/safety', {'Host': 'localhost:64842', 'Origin': origin})[0], 403)
        self.assertEqual(self.get('/api/safety', {'Host': 'localhost:64842',
                         'Origin': 'http://localhost:64842', 'Sec-Fetch-Site': 'cross-site'})[0], 403)
        # Forwarding metadata must not authorize a foreign Host.
        self.assertEqual(self.get('/api/safety', {'Host': 'attacker.invalid',
                         'X-Forwarded-Host': 'localhost:64842'})[0], 403)

    def test_duplicate_authorities_are_rejected(self):
        for duplicate in ['Host', 'Origin']:
            with self.subTest(duplicate=duplicate):
                conn = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=3)
                conn.putrequest('GET', '/api/safety', skip_host=True)
                conn.putheader('Host', 'localhost:64842')
                conn.putheader('Origin', 'http://localhost:64842')
                conn.putheader(duplicate, 'localhost:64842' if duplicate == 'Host' else 'http://localhost:64842')
                conn.endheaders()
                response = conn.getresponse()
                self.assertEqual(response.status, 403)
                response.read()
                conn.close()

    def test_overload_returns_http_error_then_recovers(self):
        for _ in range(12):
            self.assertTrue(self.server.slots.acquire(blocking=False))
        try:
            self.assertEqual(self.get('/api/safety')[0], 503)
        finally:
            for _ in range(12):
                self.server.slots.release()
        self.assertEqual(self.get('/api/safety')[0], 200)

    def test_both_loopback_families_share_catalog_and_port(self):
        if not socket.has_ipv6:
            self.skipTest('IPv6 is not supported on this host')
        probe = socket.socket(socket.AF_INET6, socket.SOCK_STREAM)
        try:
            probe.bind(('::1', 0))
        except OSError as error:
            self.skipTest(f'IPv6 loopback is unavailable: {error}')
        finally:
            probe.close()
        servers = loopback_gateways(0, self.server.catalog)
        workers = [threading.Thread(target=server.serve_forever, daemon=True) for server in servers]
        for worker in workers:
            worker.start()
        try:
            self.assertEqual(servers[0].server_port, servers[1].server_port)
            self.assertIs(servers[0].catalog, servers[1].catalog)
            self.assertEqual(servers[1].socket.getsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY), 1)
            for host in ['127.0.0.1', '::1']:
                conn = http.client.HTTPConnection(host, servers[0].server_port, timeout=3)
                conn.request('GET', '/api/safety')
                response = conn.getresponse()
                self.assertEqual(response.status, 200)
                self.assertEqual(json.loads(response.read())['binding'], host)
                conn.close()
        finally:
            for server in servers:
                server.shutdown()
                server.server_close()
            for worker in workers:
                worker.join()

    def test_disconnect_keeps_gateway_working(self):
        conn = http.client.HTTPConnection('127.0.0.1', self.server.server_port)
        conn.request('GET', '/api/sessions')
        conn.close()
        self.assertEqual(self.get('/api/safety')[0], 200)


if __name__ == '__main__':
    unittest.main()
