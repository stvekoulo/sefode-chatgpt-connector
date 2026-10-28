import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {authDirectory, hostId, prepareDirectory, savePrivate} from './storage.js';
import {begin, finish} from './oauth.js';

const directory = prepareDirectory();
if (fs.existsSync(path.join(directory, 'credentials.private.json'))) {
  throw new Error('An account already exists; use a separate auth directory for a new registration');
}
const port = Number(process.env.SEFODE_CALLBACK_PORT || 1455);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid callback port');
const pending = begin(hostId(), port);
let consumed = false;
let busy = false;
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${port}`);
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  if (req.method !== 'GET' || url.pathname !== '/auth/callback') {
    res.writeHead(404); res.end('Not found'); return;
  }
  if (consumed || busy) { res.writeHead(409); res.end('Attempt already used'); return; }
  busy = true;
  try {
    const tokens = await finish(url, pending);
    consumed = true;
    savePrivate('credentials.private.json', tokens);
    res.end('Connexion ChatGPT validee. Vous pouvez fermer cet onglet.');
    console.log('AUTHENTICATED: protected credentials saved; ChatGPT plan permission verified.');
    clearTimeout(timeout);
    server.close();
  } catch (error) {
    res.writeHead(400); res.end('Connexion non validee. Consultez le terminal du connecteur.');
    // Only locally generated messages are logged; never callback URLs, codes or token bodies.
    console.error(error.message);
  } finally { busy = false; }
});
server.on('error', () => { console.error('Loopback listener unavailable'); process.exitCode = 1; });
const timeout = setTimeout(() => {
  console.error('Authorization expired after 15 minutes; restart login.');
  server.close();
}, 15 * 60 * 1000);
server.listen(port, '127.0.0.1', () => {
  fs.writeFileSync(path.join(directory, 'authorization-url.txt'), pending.url, {mode: 0o600});
  console.log('Open the authorization URL in authorization-url.txt and approve the named app.');
  console.log('OAuth listener ready on loopback port ' + port + '; credentials remain outside the repository.');
});
