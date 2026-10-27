// `npm test` builds first, then runs node's own test runner against the built package.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyWebhook, signWebhook, WebhookVerificationError, APP_WEBHOOK_EVENT_TYPES } from '../dist/webhooks.js';

const BODY = '{"id":"e1","type":"person.deleted"}';
const TS = 1761480000;
// The same vector the platform's signer is tested against (computed with Python's hmac module).
const NEW = 'sha256=95d5dc70eeb8d25e810f8e13f184fa54ee2413f721c46b28a8e1c2ea5111348e';
const OLD = 'sha256=504ba41a2ed8d5b6c83ceeb86c4c930856caa075c4950563c06337f94a75e9eb';
const at = (s) => ({ now: () => s });

async function refused(promise, code) {
  await assert.rejects(promise, (e) => e instanceof WebhookVerificationError && e.code === code);
}

test('verifies the platform recipe and returns the event', async () => {
  const event = await verifyWebhook(BODY, { 'X-Webhook-Timestamp': String(TS), 'X-Webhook-Signature': NEW }, 'whsec_test', at(TS + 10));
  assert.equal(event.type, 'person.deleted');
  assert.equal(event.id, 'e1');
});

test('reads Headers and Node-style header objects, any case', async () => {
  const h = new Headers({ 'x-webhook-timestamp': String(TS), 'x-webhook-signature': NEW });
  await verifyWebhook(BODY, h, 'whsec_test', at(TS));
  await verifyWebhook(new TextEncoder().encode(BODY), { 'x-webhook-timestamp': [String(TS)], 'x-webhook-signature': NEW }, 'whsec_test', at(TS));
});

test('during a rotation either signature verifies, with either secret', async () => {
  const headers = { 'X-Webhook-Timestamp': String(TS), 'X-Webhook-Signature': NEW + ',' + OLD };
  await verifyWebhook(BODY, headers, 'whsec_test', at(TS));
  await verifyWebhook(BODY, headers, 'whsec_old', at(TS));
  await verifyWebhook(BODY, { 'X-Webhook-Timestamp': String(TS), 'X-Webhook-Signature': OLD }, ['whsec_test', 'whsec_old'], at(TS));
});

test('a wrong secret, a changed body or a changed timestamp is refused', async () => {
  const headers = { 'X-Webhook-Timestamp': String(TS), 'X-Webhook-Signature': NEW };
  await refused(verifyWebhook(BODY, headers, 'whsec_other', at(TS)), 'BAD_SIGNATURE');
  await refused(verifyWebhook(BODY.replace('deleted', 'deleteD'), headers, 'whsec_test', at(TS)), 'BAD_SIGNATURE');
  await refused(verifyWebhook(BODY, { ...headers, 'X-Webhook-Timestamp': String(TS + 1) }, 'whsec_test', at(TS)), 'BAD_SIGNATURE');
});

test('an old request is a replay', async () => {
  const headers = { 'X-Webhook-Timestamp': String(TS), 'X-Webhook-Signature': NEW };
  await refused(verifyWebhook(BODY, headers, 'whsec_test', at(TS + 301)), 'STALE_TIMESTAMP');
  await refused(verifyWebhook(BODY, headers, 'whsec_test', at(TS - 301)), 'STALE_TIMESTAMP');
  await verifyWebhook(BODY, headers, 'whsec_test', { now: () => TS + 900, toleranceSeconds: 1000 });
});

test('missing or malformed headers, no secret, parsed bodies', async () => {
  await refused(verifyWebhook(BODY, {}, 'whsec_test', at(TS)), 'MISSING_HEADERS');
  await refused(verifyWebhook(BODY, { 'X-Webhook-Timestamp': 'yesterday', 'X-Webhook-Signature': NEW }, 'whsec_test', at(TS)), 'BAD_TIMESTAMP');
  await refused(verifyWebhook(BODY, { 'X-Webhook-Timestamp': String(TS), 'X-Webhook-Signature': NEW }, '', at(TS)), 'NO_SECRET');
  await refused(verifyWebhook({ id: 'e1' }, { 'X-Webhook-Timestamp': String(TS), 'X-Webhook-Signature': NEW }, 'whsec_test', at(TS)), 'BAD_BODY');
});

test('signWebhook makes what verifyWebhook accepts (for local testing)', async () => {
  const headers = await signWebhook(BODY, 'whsec_test', TS);
  assert.equal(headers['X-Webhook-Signature'], NEW);
  await verifyWebhook(BODY, headers, 'whsec_test', at(TS));
});

test('the event types are the catalogue', () => {
  assert.ok(APP_WEBHOOK_EVENT_TYPES.includes('person.signed_up'));
  assert.ok(APP_WEBHOOK_EVENT_TYPES.includes('record.updated'));
  assert.ok(!APP_WEBHOOK_EVENT_TYPES.includes('webhook.test'));
  assert.equal(APP_WEBHOOK_EVENT_TYPES.length, 15);
});
