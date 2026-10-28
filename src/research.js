import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {respond} from './client.js';
import {authDirectory} from './storage.js';
import {readHistory, syncDashboard} from './sheets.js';

const root = process.env.SEFODE_CONFIG_DIR;
const ledgerFile = fileURLToPath(new URL('./ledger.py', import.meta.url));
export function ledger(operation, body) {
  const result = spawnSync('/usr/bin/python3', [ledgerFile, operation], {
    input: JSON.stringify(body), encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
    timeout: 30000, env: process.env,
  });
  if (result.status !== 0) throw new Error('Private ledger operation failed');
  return JSON.parse(result.stdout);
}

export function today() {
  return new Intl.DateTimeFormat('en-CA', {timeZone:'Africa/Porto-Novo'}).format(new Date());
}

export async function research() {
  const day = today();
  const sheetConnected = fs.existsSync(path.join(authDirectory(), 'google.private.json'));
  let sheetHistory = [];
  if (sheetConnected) {
    sheetHistory = await readHistory();
    ledger('import_sheet', {history:sheetHistory});
  }
  const previous = ledger('read', {day});
  if (previous) {
    const sheet_sync = sheetConnected ? await syncDashboard(ledger('all', {})) : {synced:false,reason:'Google key not configured'};
    return {...previous, cached: true, sheet_sync};
  }
  const config = JSON.parse(fs.readFileSync(path.join(root, 'configuration.json'), 'utf8'));
  const instructions = fs.readFileSync(path.join(root, 'agent-instructions.md'), 'utf8');
  const known = [...ledger('all', {}).prospects.map(p => p.company_website),
    ...sheetHistory.map(p => p.company_website)].slice(-500);
  const prompt = `Date : ${day}. Recherche dans tous pays et tous secteurs, Afrique, Europe et ailleurs.
Analyse jusqu'à cinq entreprises pertinentes et nouvelles, sans quota à remplir.
Ouvre des sources officielles avec la recherche web. Ne contacte personne.
Prépare une seule proposition spécifique par entreprise, selon les instructions.
Tu peux renvoyer moins de cinq prospects, voire aucun si les preuves sont insuffisantes.
Ne devine aucun email. Les coordonnées doivent être publiées officiellement, sinon null.
Ne cite aucun fait sans URL et extrait. N'attribue aucune permission de contact.
Réponds uniquement en JSON {"prospects": [...]} selon le schéma des instructions.
Catalogue autorisé : ${JSON.stringify(config.catalog)}.
Entreprises déjà examinées à éviter : ${JSON.stringify(known)}.`;
  const result = await respond({model: config.model || 'gpt-6.1-sol', webSearch: true,
    instructions, input: [{role:'user',content:prompt}]});
  if (!result.text.trim()) throw new Error('Empty research result');
  if (!result.output.some(item => item.type === 'web_search_call' && item.status === 'completed')) {
    throw new Error('No completed web research; drafts not accepted');
  }
  const text = result.text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const parsed = JSON.parse(text);
  if (!Array.isArray(parsed.prospects) || parsed.prospects.length > 5) throw new Error('Invalid prospect batch');
  const qualification = fs.readFileSync(path.join(root, 'qualification.js'), 'utf8');
  const output = new Function('$input', qualification)({first: () => ({json: {...config, prospects: parsed.prospects}})})[0].json;
  output.day = day;
  output.response_id = result.id;
  output.research_verified = true;
  output.report_recipients = config.report_recipients;
  output.report.sent_confirmed = 0;
  const saved = ledger('save', output);
  saved.sheet_sync = sheetConnected ? await syncDashboard(ledger('all', {})) : {synced:false,reason:'Google key not configured'};
  return saved;
}
