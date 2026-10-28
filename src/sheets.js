import fs from 'node:fs';
import path from 'node:path';
import {importPKCS8, SignJWT} from 'jose';
import {readPrivate} from './storage.js';

let cachedToken, tokenPending;
const config = () => JSON.parse(fs.readFileSync(path.join(process.env.SEFODE_CONFIG_DIR, 'configuration.json'),'utf8'));
const tokenEndpoint = 'https://oauth2.googleapis.com/token';
async function token() {
  if (cachedToken?.expires > Date.now() + 60000) return cachedToken.value;
  if (tokenPending) return tokenPending;
  tokenPending = (async () => {
    const key = readPrivate('google.private.json');
    if (key.type !== 'service_account' || !/^[a-z0-9-]+@[a-z0-9-]+\.iam\.gserviceaccount\.com$/.test(key.client_email)) {
      throw new Error('Invalid dedicated Google service account');
    }
    const privateKey = await importPKCS8(key.private_key, 'RS256');
    const assertion = await new SignJWT({scope:'https://www.googleapis.com/auth/spreadsheets'})
      .setProtectedHeader({alg:'RS256',kid:key.private_key_id}).setIssuer(key.client_email)
      .setAudience(tokenEndpoint).setIssuedAt().setExpirationTime('55m').sign(privateKey);
    const response = await fetch(tokenEndpoint, {method:'POST', redirect:'error',
      headers:{'Content-Type':'application/x-www-form-urlencoded'}, signal:AbortSignal.timeout(20000),
      body:new URLSearchParams({grant_type:'urn:ietf:params:oauth:grant-type:jwt-bearer',assertion})});
    if (!response.ok) throw new Error(`Google authorization unavailable (HTTP ${response.status})`);
    const result = await response.json();
    if (!result.access_token) throw new Error('Google access token missing');
    cachedToken = {value:result.access_token, expires:Date.now() + Number(result.expires_in || 300)*1000};
    return cachedToken.value;
  })().finally(() => { tokenPending = undefined; });
  return tokenPending;
}

async function request(route, method='GET', body) {
  const identifier = config().spreadsheet_id;
  if (!/^[a-zA-Z0-9_-]{20,100}$/.test(identifier)) throw new Error('Explicit spreadsheet ID required');
  // No request body or remote page may choose a different spreadsheet.
  const response = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${identifier}${route}`, {
    method, redirect:'error', signal:AbortSignal.timeout(20000),
    headers:{Authorization:'Bearer ' + await token(),'Content-Type':'application/json'},
    body:body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`Sheet unavailable (HTTP ${response.status}); sending remains blocked`);
  return response.json();
}
const values = range => '/values/' + encodeURIComponent(range);

export function identityKeys(p) {
  let domain = '';
  try {domain = new URL(p.company_website).hostname.toLowerCase().replace(/^www\./,'');} catch {}
  const name = String(p.company_name || '').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^\p{L}\p{N}]/gu,'');
  const email = String(p.recipient_email || '').trim().toLowerCase();
  return [domain && 'domain:'+domain, name && 'name:'+name, email && 'email:'+email].filter(Boolean);
}

export async function readHistory() {
  const data = await request(values("'Prospects'!A1:X5001") + '?valueRenderOption=UNFORMATTED_VALUE');
  const [headers=[],...rows] = data.values || [];
  if (headers[0] !== 'Identifiant' || headers[10] !== 'Statut' || headers[18] !== 'Autorisation de contact') {
    throw new Error('Unexpected Sheet structure; automatic contact blocked');
  }
  return rows.filter(row => row[0] || row[1]).map((row,index) => ({
    id:String(row[0] || ''), company_name:String(row[1] || ''), company_website:String(row[4] || ''),
    recipient_email:String(row[9] || ''), status:String(row[10] || '').toUpperCase(),
    first_contact:row[16] || null, permission:String(row[18] || 'UNKNOWN').toUpperCase(),
    permission_evidence:String(row[19] || ''), verified_by:String(row[20] || ''), verified_at:row[21] || null,
    channel:String(row[22] || 'UNKNOWN').toUpperCase(), reply_status:String(row[23] || 'NONE').toUpperCase(),
    sheet_row:index+2,
  }));
}

export function blockedBySheet(prospect, history) {
  const wanted = new Set(identityKeys(prospect));
  const matches = history.filter(row => identityKeys(row).some(key => wanted.has(key)));
  if (matches.length > 1) return {blocked:true,reason:'Ambiguous duplicate rows in Sheet'};
  const row = matches[0];
  if (!row) return {blocked:false,permission:false};
  if (row.first_contact || ['SENT','RESERVED','UNCERTAIN','CONTACT_BLOCKED','REFUSED','REPLIED','CONTACTED','ENVOYE','ENVOYÉ'].includes(row.status)
      || row.permission === 'DENIED' || ['REPLIED','REFUSED','UNSUBSCRIBED'].includes(row.reply_status)) {
    return {blocked:true,reason:'Previous contact, refusal, reply or unresolved send in Sheet'};
  }
  return {blocked:false,permission:row.permission === 'APPROVED' && row.channel === 'EMAIL_ALLOWED'
    && Boolean(row.permission_evidence && row.verified_by && row.verified_at), row};
}

export async function syncDashboard(snapshot) {
  const history = await readHistory();
  const existingIds = new Set(history.map(row => row.id));
  const newRows = snapshot.prospects.filter(p => !existingIds.has(p.id)
    && !history.some(row => identityKeys(row).some(key => identityKeys(p).includes(key))));
  if (newRows.length) {
    const rows = newRows.map(p => [p.id,p.company_name,p.country,p.industry,p.company_website,
      p.business_opportunity,p.proposed_solution,p.expected_business_value,p.qualification_score,
      p.recipient_email || '',p.status,p.reason,p.email_subject,p.email_body,
      (p.source_urls || []).join('\n'),JSON.stringify({verified_facts:p.verified_facts,hypotheses:p.hypotheses}),
      '',new Date().toISOString(),'UNKNOWN','','','','UNKNOWN','NONE']);
    await request(values("'Prospects'!A1:X5001") + ':append?valueInputOption=RAW&insertDataOption=INSERT_ROWS',
      'POST',{values:rows});
  }
  const reportData = await request(values("'Rapports'!A2:K1000") + '?valueRenderOption=UNFORMATTED_VALUE');
  const days = new Set((reportData.values || []).map(row => typeof row[0] === 'number'
    ? new Date((row[0]-25569)*86400000).toISOString().slice(0,10) : String(row[0])));
  for (const run of snapshot.reports.filter(run => !days.has(run.day))) {
    const r = run.report;
    const date = Date.parse(run.day+'T00:00:00Z')/86400000+25569;
    await request(values("'Rapports'!A1:K1000") + ':append?valueInputOption=RAW&insertDataOption=INSERT_ROWS','POST',
      {values:[[date,r.analyzed,r.excluded,r.qualified_for_review,r.messages_prepared,r.sent_confirmed,
        r.pending_validation,0,'DRAFT_ONLY','Brouillons préparés ; aucun envoi.',r.validation_errors]]});
  }
  await request('/values:batchUpdate','POST',{valueInputOption:'RAW',data:[
    {range:"'Tableau de bord'!B10:B11",values:[['Synchronisé le '+new Date().toISOString()],['Brouillons uniquement']]},
  ]});
  return {synced:true,added_prospects:newRows.length};
}
