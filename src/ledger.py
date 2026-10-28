"""Private SQLite history and atomic first-contact reservations. No email transport."""
import datetime
import hashlib
import json
import os
import pathlib
import sqlite3
import sys
import unicodedata
import urllib.parse

def normalized_name(value):
    text = unicodedata.normalize('NFKD', str(value)).casefold()
    return ''.join(char for char in text if char.isalnum() and not unicodedata.combining(char))

def keys(prospect):
    host = urllib.parse.urlsplit(prospect.get('company_website', '')).hostname or ''
    host = host.casefold().removeprefix('www.')
    result = {'name:' + normalized_name(prospect.get('company_name', ''))}
    if host:
        result.add('domain:' + host)
    email = str(prospect.get('recipient_email') or '').strip().casefold()
    if email:
        result.add('email:' + email)
    return sorted(key for key in result if not key.endswith(':'))

def connect():
    root = pathlib.Path(os.environ['SEFODE_DATA_DIR'])
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(root, 0o700)
    db = sqlite3.connect(root / 'ledger.sqlite', timeout=15)
    os.chmod(root / 'ledger.sqlite', 0o600)
    db.row_factory = sqlite3.Row
    db.executescript('''
      PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS prospects (
        id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS aliases (alias TEXT PRIMARY KEY, prospect_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY, prospect_id TEXT, kind TEXT NOT NULL, created_at TEXT NOT NULL, data TEXT);
      CREATE TABLE IF NOT EXISTS contact_keys (
        alias TEXT PRIMARY KEY, prospect_id TEXT NOT NULL, state TEXT NOT NULL,
        day TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runs (day TEXT PRIMARY KEY, report TEXT NOT NULL);
    ''')
    return db

def timestamp():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()

def save_batch(db, body):
    results = []
    with db:
        for prospect in body.get('prospects', []):
            aliases = keys(prospect)
            if not aliases:
                continue
            marks = ','.join('?' for _ in aliases)
            matches = db.execute(f'SELECT DISTINCT prospect_id FROM aliases WHERE alias IN ({marks})', aliases).fetchall()
            identifier = matches[0][0] if matches else hashlib.sha256(aliases[0].encode()).hexdigest()[:24]
            blocked = db.execute(f'SELECT state FROM contact_keys WHERE alias IN ({marks})', aliases).fetchall()
            prospect['id'] = identifier
            prospect['should_send'] = False
            if matches:
                prospect['previously_analyzed'] = True
            if blocked:
                prospect['status'] = 'CONTACT_BLOCKED'
                prospect['reason'] = 'Historique de contact, refus ou réservation existante'
            if len(matches) > 1:
                prospect['status'] = 'TO_VERIFY'
                prospect['reason'] = 'Identités ambiguës : rapprochement manuel requis'
            db.execute('INSERT INTO prospects VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,updated_at=excluded.updated_at',
                       (identifier, json.dumps(prospect, ensure_ascii=False), timestamp()))
            for alias in aliases:
                db.execute('INSERT OR IGNORE INTO aliases VALUES (?,?)', (alias, identifier))
            db.execute('INSERT INTO events(prospect_id,kind,created_at,data) VALUES (?,?,?,?)',
                       (identifier, 'ANALYZED', timestamp(), json.dumps({'score': prospect.get('qualification_score')})))
            results.append(prospect)
        body['prospects'] = results
        db.execute('INSERT OR REPLACE INTO runs VALUES (?,?)', (body['day'], json.dumps(body, ensure_ascii=False)))
    return body

def reserve_first_contact(db, body):
    """Input controls must come from verified workflow state, never model output."""
    prospect = body['prospect']
    required = ['qualification_valid', 'service_authorized', 'facts_verified', 'contact_allowed',
                'channel_authorized', 'message_valid', 'identity_and_unsubscribe_valid',
                'sheet_read_success', 'no_reply', 'no_refusal', 'no_previous_initial_contact']
    controls = body.get('controls', {})
    if not all(controls.get(key) is True for key in required):
        return {'allowed': False, 'reason': 'Missing independent prerequisite'}
    if prospect.get('qualification_score', 0) < 85:
        return {'allowed': False, 'reason': 'Score below 85'}
    checked = controls.get('sheet_checked_at', 0)
    if not isinstance(checked, (int, float)) or abs(datetime.datetime.now().timestamp() - checked) > 60:
        return {'allowed': False, 'reason': 'Fresh Sheet read required before each send'}
    aliases = keys(prospect)
    if len(aliases) < 2:
        return {'allowed': False, 'reason': 'Insufficient company identity'}
    db.execute('BEGIN IMMEDIATE')
    try:
        marks = ','.join('?' for _ in aliases)
        # Any shared alias permanently prevents a second automatic initial contact.
        if db.execute(f'SELECT 1 FROM contact_keys WHERE alias IN ({marks}) LIMIT 1', aliases).fetchone():
            db.rollback()
            return {'allowed': False, 'reason': 'Already contacted, refused or reserved'}
        if db.execute('SELECT COUNT(DISTINCT prospect_id) FROM contact_keys WHERE day=? AND state IN (?,?,?)',
                      (body['day'], 'RESERVED', 'SENT', 'UNCERTAIN')).fetchone()[0] >= 5:
            db.rollback()
            return {'allowed': False, 'reason': 'Daily limit reached'}
        identifier = prospect['id']
        for alias in aliases:
            db.execute('INSERT INTO contact_keys VALUES (?,?,?,?,?)', (alias, identifier, 'RESERVED', body['day'], timestamp()))
        db.execute('INSERT INTO events(prospect_id,kind,created_at) VALUES (?,?,?)', (identifier, 'RESERVED', timestamp()))
        db.commit()
        return {'allowed': True, 'id': identifier, 'state': 'RESERVED'}
    except Exception:
        db.rollback()
        raise

def import_sheet(db, body):
    imported = 0
    with db:
        for row in body.get('history', []):
            blocked = (row.get('first_contact') or row.get('permission') == 'DENIED'
                       or row.get('reply_status') in ('REPLIED', 'REFUSED', 'UNSUBSCRIBED')
                       or row.get('status') in ('SENT', 'RESERVED', 'UNCERTAIN', 'CONTACT_BLOCKED',
                                                'REFUSED', 'REPLIED', 'CONTACTED', 'ENVOYE', 'ENVOYÉ'))
            if not blocked:
                continue
            aliases = keys(row)
            if not aliases:
                continue
            identifier = row.get('id') or hashlib.sha256(aliases[0].encode()).hexdigest()[:24]
            state = 'DENIED' if row.get('permission') == 'DENIED' else row.get('status') or 'CONTACT_BLOCKED'
            day = str(row.get('first_contact') or 'legacy')[:10]
            for alias in aliases:
                db.execute('INSERT OR IGNORE INTO aliases VALUES (?,?)', (alias, identifier))
                db.execute('INSERT OR IGNORE INTO contact_keys VALUES (?,?,?,?,?)',
                           (alias, identifier, state, day, timestamp()))
            imported += 1
    return {'imported_blocks': imported}

def main():
    body = json.load(sys.stdin)
    db = connect()
    operation = sys.argv[1]
    if operation == 'save':
        result = save_batch(db, body)
    elif operation == 'read':
        rows = db.execute('SELECT report FROM runs WHERE day=?', (body['day'],)).fetchone()
        result = json.loads(rows[0]) if rows else None
    elif operation == 'all':
        result = {'prospects': [json.loads(row[0]) for row in db.execute('SELECT data FROM prospects ORDER BY updated_at DESC')],
                  'reports': [json.loads(row[0]) for row in db.execute('SELECT report FROM runs ORDER BY day')]}
    elif operation == 'reserve':
        result = reserve_first_contact(db, body)
    elif operation == 'import_sheet':
        result = import_sheet(db, body)
    else:
        raise ValueError('Unsupported operation')
    print(json.dumps(result, ensure_ascii=False))

if __name__ == '__main__':
    main()
