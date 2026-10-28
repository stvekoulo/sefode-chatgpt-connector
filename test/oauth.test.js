import test from 'node:test';
import assert from 'node:assert/strict';
import {begin, validateCallback, hasPlanPermission} from '../src/oauth.js';
import {consumeStream} from '../src/client.js';

test('PKCE uses a loopback callback and an independent opaque host ID', () => {
  const pending = begin('urn:uuid:123');
  const url = new URL(pending.url);
  assert.equal(url.origin, 'https://auth.openai.com');
  assert.equal(url.searchParams.get('client_id'), 'dynamic_agent_client');
  assert.equal(url.searchParams.get('ext_agent_host_id'), 'urn:uuid:123');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('redirect_uri'), 'http://127.0.0.1:1455/auth/callback');
  assert.notEqual(url.searchParams.get('code_challenge'), pending.verifier);
});
test('wrong state, error, missing issued client, and reused generic client are rejected', () => {
  const pending = begin('urn:uuid:123');
  const callback = new URL(pending.redirect_uri);
  callback.search = new URLSearchParams({state: 'wrong', client_id: 'oaiapp_example', code: 'abc'});
  assert.throws(() => validateCallback(callback, pending));
  callback.searchParams.set('state', pending.state);
  callback.searchParams.set('error', 'access_denied');
  assert.throws(() => validateCallback(callback, pending));
  callback.searchParams.delete('error');
  callback.searchParams.set('client_id', 'dynamic_agent_client');
  assert.throws(() => validateCallback(callback, pending));
  callback.searchParams.set('client_id', 'oaiapp_example');
  assert.deepEqual(validateCallback(callback, pending), {client_id: 'oaiapp_example', code: 'abc'});
});
test('identity scopes alone never grant plan usage', () => {
  assert.equal(hasPlanPermission('openid email'), false);
  assert.equal(hasPlanPermission('chatgpt.tokens.use.direct.extra'), false);
  assert.equal(hasPlanPermission('openid chatgpt.tokens.use.direct'), true);
});
async function* chunks(text) {
  const buffer = Buffer.from(text);
  for (let index = 0; index < buffer.length; index += 7) yield buffer.subarray(index, index + 7);
}
test('partial streaming output is not a successful result', async () => {
  await assert.rejects(consumeStream(chunks('data: {"type":"response.output_text.delta","delta":"Hello"}\n\n')));
});
test('late quota error prevents success', async () => {
  await assert.rejects(consumeStream(chunks('data: {"type":"response.failed","response":{"error":{"code":"subscription_sharing_usage_limit_exceeded"}}}\n\n')), /usage_limit_exceeded/);
});
test('completed response is required and preserved', async () => {
  const result = await consumeStream(chunks('data: {"type":"response.completed","response":{"id":"test","output":[]}}\n\n'));
  assert.equal(result.id, 'test');
});
