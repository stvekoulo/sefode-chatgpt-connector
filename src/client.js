import {readPrivate, savePrivate, hostId} from './storage.js';
import {tokenRequest, hasPlanPermission} from './oauth.js';

let refreshInFlight;
async function refresh() {
  const current = readPrivate('credentials.private.json');
  if (!hasPlanPermission(current.scope)) throw new Error('ChatGPT plan use is disabled');
  if (current.expires_at > Date.now() + 60000) return current;
  const result = await tokenRequest({grant_type: 'refresh_token', client_id: current.client_id,
    refresh_token: current.refresh_token, ext_agent_host_id: hostId()});
  const next = {...current, ...result, expires_at: Date.now() + Number(result.expires_in || 300) * 1000};
  if (!hasPlanPermission(next.scope) || !next.access_token) throw new Error('Refreshed session lacks plan access');
  savePrivate('credentials.private.json', next);
  return next;
}

export async function credentials() {
  if (!refreshInFlight) refreshInFlight = refresh().finally(() => { refreshInFlight = undefined; });
  return refreshInFlight;
}

export async function models() {
  const auth = await credentials();
  const response = await fetch('https://api.openai.com/v1/models', {
    headers: {Authorization: 'Bearer ' + auth.access_token},
    redirect: 'error', signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error(`Model admission rejected (HTTP ${response.status})`);
  const data = await response.json();
  return (data.models || []).filter(model => model.visibility === 'list')
    .map(({slug, display_name}) => ({slug, display_name}));
}

export async function consumeStream(body) {
  const decoder = new TextDecoder();
  let pending = '', completed, total = 0;
  const doneItems = new Map();
  for await (const chunk of body) {
    total += chunk.length;
    if (total > 8 * 1024 * 1024) throw new Error('Response size limit exceeded');
    pending += decoder.decode(chunk, {stream: true}).replace(/\r\n/g, '\n');
    let boundary;
    while ((boundary = pending.indexOf('\n\n')) !== -1) {
      const block = pending.slice(0, boundary);
      pending = pending.slice(boundary + 2);
      const data = block.split('\n').filter(line => line.startsWith('data:'))
        .map(line => line.slice(5).trimStart()).join('\n');
      if (!data || data === '[DONE]') continue;
      const event = JSON.parse(data);
      if (event.type === 'response.output_item.done' && event.item) {
        doneItems.set(event.output_index ?? doneItems.size, event.item);
      }
      if (['response.failed', 'response.incomplete', 'error'].includes(event.type)) {
        const code = event.response?.error?.code || event.code || event.type;
        throw new Error('Inference stopped: ' + String(code).replace(/[^a-z0-9_.-]/gi, '').slice(0, 100));
      }
      if (event.type === 'response.completed') completed = event.response;
    }
  }
  if (!completed) throw new Error('Stream ended without response.completed');
  // Some eligible streaming routes send final items only in output_item.done.
  if (!completed.output?.length && doneItems.size) {
    completed.output = [...doneItems.entries()].sort((a, b) => a[0] - b[0]).map(([, item]) => item);
  }
  return completed;
}

export async function respond({model, input, instructions, webSearch = false}) {
  if (!Array.isArray(input) || !model) throw new Error('model and input array are required');
  const auth = await credentials();
  const request = {model, input, instructions, store: false, stream: true};
  if (webSearch) request.tools = [{type: 'web_search'}];
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(180000),
    headers: {Authorization: 'Bearer ' + auth.access_token, 'Content-Type': 'application/json'},
    body: JSON.stringify(request),
  });
  if (!response.ok) throw new Error(`Inference admission rejected (HTTP ${response.status}); no paid fallback`);
  const completed = await consumeStream(response.body);
  return {id: completed.id, output: completed.output,
    text: (completed.output || []).flatMap(item => item.content || [])
      .filter(item => item.type === 'output_text').map(item => item.text).join('')};
}
