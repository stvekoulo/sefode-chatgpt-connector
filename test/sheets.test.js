import test from 'node:test';
import assert from 'node:assert/strict';
import {blockedBySheet, identityKeys} from '../src/sheets.js';

const company = {company_name:'Société Exemple',company_website:'https://www.example.com',recipient_email:'contact@example.com'};
test('Sheet domain matching ignores www and casing', () => {
  assert.deepEqual(identityKeys(company).slice(0,2),['domain:example.com','name:societeexemple']);
  assert.equal(blockedBySheet(company,[{...company,company_name:'Another name',company_website:'https://EXAMPLE.com',status:'SENT'}]).blocked,true);
});
test('a matching email blocks a changed company name and site', () => {
  assert.equal(blockedBySheet(company,[{...company,company_name:'Different',company_website:'https://other.example',status:'RESERVED'}]).blocked,true);
});
test('refusal, unsubscribe, reply and uncertain send each block contact', () => {
  for (const patch of [{permission:'DENIED'},{reply_status:'REFUSED'},{reply_status:'REPLIED'},
    {reply_status:'UNSUBSCRIBED'},{status:'UNCERTAIN'},{first_contact:'2026-10-01'}]) {
    assert.equal(blockedBySheet(company,[{...company,...patch}]).blocked,true);
  }
});
test('approval without verification evidence is not permission', () => {
  assert.equal(blockedBySheet(company,[{...company,permission:'APPROVED',channel:'EMAIL_ALLOWED'}]).permission,false);
  assert.equal(blockedBySheet(company,[{...company,permission:'APPROVED',channel:'EMAIL_ALLOWED',
    permission_evidence:'Reviewed contact basis',verified_by:'Owner',verified_at:'2026-10-28'}]).permission,true);
});
test('duplicate rows require reconciliation rather than a send', () => {
  assert.equal(blockedBySheet(company,[company,company]).blocked,true);
});
test('a new company without permission remains unapproved', () => {
  assert.equal(blockedBySheet(company,[]).permission,false);
});
