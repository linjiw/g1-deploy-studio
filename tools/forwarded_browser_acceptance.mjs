// Exercise browser access through a loopback TCP tunnel that preserves Host.
// This reproduces desktop/SSH forwarding: browser and backend ports differ.
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const backend = new URL(process.env.STUDIO_URL || 'http://127.0.0.1:8790');
if (backend.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(backend.hostname)) {
  throw new Error('Forwarding acceptance requires an HTTP loopback backend');
}
const sockets = new Set();
const proxy = net.createServer(client => {
  const upstream = net.connect({
    host: backend.hostname.replace(/^\[|\]$/g, ''), port: Number(backend.port || 80),
  });
  for (const socket of [client, upstream]) {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => { client.destroy(); upstream.destroy(); });
  }
  client.pipe(upstream).pipe(client);
});
await new Promise((resolve, reject) => {
  proxy.once('error', reject);
  proxy.listen(0, '127.0.0.1', resolve);
});
process.env.STUDIO_URL = `http://localhost:${proxy.address().port}`;
process.env.STUDIO_EVIDENCE ||= path.join(os.homedir(), 'research-data/g1-deploy-studio/evidence/browser-forwarded');
console.log(`Checking preserved browser Host via ${process.env.STUDIO_URL} → ${backend.origin}`);
try {
  await import('./browser_acceptance.mjs');
} finally {
  for (const socket of sockets) socket.destroy();
  await new Promise(resolve => proxy.close(resolve));
}
