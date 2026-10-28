import http from 'node:http';
import {timingSafeEqual} from 'node:crypto';
import {readPrivate} from './storage.js';
import {research, ledger} from './research.js';

const token = readPrivate('bridge-token.private.json').token;
if (!token || token.length < 40) throw new Error('Strong bridge token required');
const address = process.env.SEFODE_BIND || '127.0.0.1';
if (!/^(127\.0\.0\.1|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.1)$/.test(address)) {
  throw new Error('Only loopback or a private Docker gateway may be bound');
}
let busy = false;
const server = http.createServer(async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  const expected = Buffer.from('Bearer ' + token);
  const actual = Buffer.from(req.headers.authorization || '');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    res.writeHead(401); res.end('{"error":"Unauthorized"}'); return;
  }
  if (req.method === 'GET' && req.url === '/health') {
    res.end(JSON.stringify({status:'ok', mode:'DRAFT_ONLY', busy})); return;
  }
  if (req.method === 'GET' && req.url === '/dashboard') {
    res.end(JSON.stringify(ledger('all', {}))); return;
  }
  if (req.method !== 'POST' || req.url !== '/research') {
    res.writeHead(404); res.end('{"error":"Not found"}'); return;
  }
  if (busy) { res.writeHead(409); res.end('{"error":"Research already running"}'); return; }
  busy = true;
  try {
    const output = await research();
    res.end(JSON.stringify(output));
    console.log(JSON.stringify({event:'research_completed', day:output.day,
      analyzed:output.report.analyzed, sent:0, cached:output.cached || false}));
  } catch (error) {
    res.writeHead(503);
    // Responses contain only locally generated error messages, never token bodies.
    const message = String(error.message).replace(/[^a-z0-9 _().:;-]/gi, '').slice(0, 180);
    res.end(JSON.stringify({status:'RESEARCH_PENDING', error:message, should_send:false}));
    console.error(JSON.stringify({event:'research_pending', reason:message}));
  } finally { busy = false; }
});
server.requestTimeout = 240000;
server.listen(4011, address, () => console.log('Private draft-only research bridge ready'));
