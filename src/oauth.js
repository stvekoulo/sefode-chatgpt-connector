import {createHash, randomBytes, timingSafeEqual} from 'node:crypto';
import {createRemoteJWKSet, jwtVerify} from 'jose';

export const issuer = 'https://auth.openai.com';
export const resource = 'https://api.openai.com/v1';
export const scopes = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const jwks = createRemoteJWKSet(new URL(issuer + '/.well-known/jwks.json'));
export const random = () => randomBytes(32).toString('base64url');

export function equal(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const a = Buffer.from(left), b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function begin(host, port = 1455) {
  const pending = {state: random(), nonce: random(), verifier: random(),
    redirect_uri: `http://127.0.0.1:${port}/auth/callback`};
  const url = new URL(issuer + '/api/accounts/authorize');
  url.search = new URLSearchParams({client_id: 'dynamic_agent_client',
    agent_name_hint: 'SEFODE Prospection Connector', ext_agent_host_id: host,
    response_type: 'code', redirect_uri: pending.redirect_uri, scope: scopes, resource,
    state: pending.state, nonce: pending.nonce, code_challenge_method: 'S256',
    code_challenge: createHash('sha256').update(pending.verifier).digest('base64url')}).toString();
  return {...pending, url: url.href};
}

export function validateCallback(url, pending) {
  if (url.pathname !== '/auth/callback' || !equal(url.searchParams.get('state'), pending.state)) {
    throw new Error('Invalid callback state or path');
  }
  if (url.searchParams.has('error')) throw new Error('Authorization was not granted');
  const client = url.searchParams.get('client_id');
  const code = url.searchParams.get('code');
  if (!client || !/^oaiapp_[a-z0-9_-]+$/i.test(client) || !code) throw new Error('Registration incomplete');
  return {client_id: client, code};
}

export async function tokenRequest(fields) {
  const response = await fetch(issuer + '/api/accounts/oauth/token', {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30000),
    headers: {'Content-Type': 'application/x-www-form-urlencoded'},
    body: new URLSearchParams({...fields, resource}),
  });
  if (!response.ok) throw new Error(`OAuth exchange rejected (HTTP ${response.status}); reconnect required`);
  return response.json();
}

export function hasPlanPermission(scope) {
  return typeof scope === 'string' && new Set(scope.split(/\s+/)).has('chatgpt.tokens.use.direct');
}

export async function finish(url, pending) {
  const {client_id, code} = validateCallback(url, pending);
  const tokens = await tokenRequest({grant_type: 'authorization_code', client_id, code,
    code_verifier: pending.verifier, redirect_uri: pending.redirect_uri});
  if (!hasPlanPermission(tokens.scope)) throw new Error('ChatGPT plan usage permission was not granted');
  if (!tokens.access_token || !tokens.refresh_token || !tokens.id_token) throw new Error('Incomplete OAuth credentials');
  const {payload} = await jwtVerify(tokens.id_token, jwks, {issuer, audience: client_id});
  if (!equal(payload.nonce, pending.nonce) || !payload.sub) throw new Error('Identity validation failed');
  return {...tokens, client_id, identity_sub: payload.sub,
    expires_at: Date.now() + Number(tokens.expires_in || 300) * 1000};
}
