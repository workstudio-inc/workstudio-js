// Contract tests for @workstudio-inc/sdk/app: each fixture is what the server's own DTO serialises to, cited by class
// (server repo, origin/main 2026-10-30). Runs on the built package (npm test builds first). Never calls a real server.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AllowanceUsed, AppError, Auth, createApp } from '../dist/app.js';

const API = 'https://api.example.test';
const RT = `${API}/api/v1/workflow/ai-runtime`;
const ME = `${API}/api/v1/workflow/connection/end-users/me`;

/** An App whose fetch answers by route: `route(url, init)` -> Response | [status, body] | body. Calls are recorded. */
function appWith(route) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : init.body;
    calls.push({ url, method: init.method ?? 'GET', headers: init.headers ?? {}, body });
    const answer = await route(url, init);
    if (answer instanceof Response) return answer;
    // [status, body] when the first element is a status; any other array is a bare JSON array body.
    const [status, json] = Array.isArray(answer) && answer.length === 2 && typeof answer[0] === 'number' ? answer : [200, answer];
    return new Response(status === 204 ? null : JSON.stringify(json), { status, headers: { 'Content-Type': 'application/json' } });
  };
  const app = createApp({ apiUrl: API, platformToken: () => 'person-token', fetch });
  return { app, calls };
}

/** An SSE answer written exactly as Spring's SseEmitter writes it: `event:<name>` then `data:<json>`, no space. */
function springSse(events) {
  const text = events.map(([name, data]) => `event:${name}\ndata:${JSON.stringify(data)}\n\n`).join('');
  return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(text)); c.close(); } }),
    { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

// ai-runtime src/main/java/com/svai/workflow/studio/runtime/ai/streaming/TurnOutcomes.java - record TurnOutcome
// (@JsonInclude NON_NULL). Sent bare as the `turn_outcome` event's data: it has no `type` field.
const TURN_OUTCOME = {
  turnId: '5b8f6a0e-3c1d-4e7a-9d55-0b6e2f1c9a11', sessionId: '0f2d5c3a-8b7e-4b1f-a6c2-91d3e4f5a6b7', status: 'completed',
  startedAt: 1793300000000, endedAt: 1793300012345, content: 'Here is your plan.', turnRef: 'c3a1e2d4-5f60-4a7b-8c9d-0e1f2a3b4c5d',
  chargedUsd: 0.0123, refunded: false, refundPending: false, notCharged: false,
};

// workflow-gateway src/main/java/com/svai/workflow/gateway/dto/CreateAISessionResponse.java
const STARTED = {
  success: true, errorMessage: null, sessionId: 's1', tenantId: 't1', envId: 'e1', agentId: 'a1', agentName: 'Designer',
  sessionToken: 'session-token', tokenExpiresAt: '2026-10-30T19:00:00Z', aiRuntimeUrl: API, aiRuntimeVpnUrl: null,
  aiRuntimeInternalUrl: null, connectionMode: 'PUBLIC', vpnRequired: false, vpnInstructions: null, modelProvider: 'anthropic',
  modelName: 'model', sessionTimeoutMinutes: 60, resumedTurnCount: 0,
};

describe('chat contract (ai-runtime + gateway)', () => {
  it('reconnect reads the outcome of an ended turn from a turn_outcome event named only by its event line', async () => {
    const { app, calls } = appWith(url => {
      // ai-runtime TurnOutcomes.reconnect: turn_outcome (bare record), then no_active_turn ({type}).
      if (url === `${RT}/sessions/mine/s1/stream/reconnect`) {
        return springSse([['turn_outcome', TURN_OUTCOME], ['no_active_turn', { type: 'no_active_turn' }]]);
      }
      return [404, {}];
    });
    const outcome = await app.chat.reconnect('s1');
    assert.ok(outcome, 'not null: the turn is on record');
    assert.equal(outcome.status, 'completed');
    assert.equal(outcome.text, 'Here is your plan.');
    assert.equal(outcome.turnRef, TURN_OUTCOME.turnRef);
    assert.equal(outcome.chargedUsd, 0.0123);
    assert.equal(calls.length, 1, 'answered from the stream, no extra read');
    assert.equal(calls[0].headers.Authorization, 'Bearer person-token');
  });

  it('reconnect to a turn the person stops reads back how it ended', async () => {
    const { app } = appWith(url => {
      if (url.endsWith('/stream/reconnect')) {
        // ai-runtime SessionStreamEventSender.sendCancelledEvent: the stream's last event.
        return springSse([
          ['reconnect', { type: 'reconnect', content: 'Half ' }],
          ['cancelled', { type: 'cancelled', code: 'CANCELLED', message: 'Stopped before it finished.', turnId: 't9', turnRef: 'r9', chargedUsd: 0.004, refunded: false, notCharged: false }],
        ]);
      }
      // GET sessions/mine/{id}/turn - EndUserConversationsController -> TurnOutcomes.TurnOutcome
      if (url.endsWith('/sessions/mine/s1/turn')) return { ...TURN_OUTCOME, turnId: 't9', status: 'cancelled', code: 'CANCELLED', content: undefined };
      return [404, {}];
    });
    const outcome = await app.chat.reconnect('s1', { maxWaitMs: 50 });
    assert.equal(outcome.status, 'cancelled');
    assert.equal(outcome.code, 'CANCELLED');
  });

  it('send resolves a stopped turn with the text so far and cancelled: true', async () => {
    const { app, calls } = appWith(url => {
      if (url === `${API}/api/v1/workflow/gateway/ai-sessions`) return STARTED;
      if (url === `${RT}/direct/sessions/s1/messages/stream`) {
        return springSse([
          ['token', { type: 'token', content: 'A walnut ' }],
          ['allowance', { type: 'allowance', turnRef: 'r9', chargedUsd: 0.004, notCharged: false, refunded: false, waivable: true }],
          ['cancelled', { type: 'cancelled', code: 'CANCELLED', message: 'Stopped before it finished.', turnId: 't9', turnRef: 'r9', chargedUsd: 0.004, refunded: false, notCharged: false }],
        ]);
      }
      return [404, {}];
    });
    const chat = await app.chat.start({ agentId: 'a1' });
    // gateway CreateAISessionRequest: agentId, projectId, contextRef, resumeFromSessionId
    assert.deepEqual(calls[0].body, { agentId: 'a1' });
    const reply = await chat.send('a table');
    assert.equal(reply.cancelled, true);
    assert.equal(reply.text, 'A walnut ');
    assert.equal(reply.turnRef, 'r9');
    assert.equal(calls[1].headers.Authorization, 'Bearer session-token');
  });

  it('send stopped before anything streamed resolves (no 502)', async () => {
    const { app } = appWith(url => {
      if (url.endsWith('/gateway/ai-sessions')) return STARTED;
      return springSse([['cancelled', { type: 'cancelled', code: 'CANCELLED', message: 'Stopped before it finished.', turnId: 't9', notCharged: true }]]);
    });
    const reply = await (await app.chat.start({ agentId: 'a1' })).send('hi');
    assert.equal(reply.cancelled, true);
    assert.equal(reply.text, '');
    assert.equal(reply.notCharged, true);
  });

  it('send refused for the day (429 DAILY_LIMIT) keeps the platform words and resetAt', async () => {
    // ai-runtime StreamingAgentController.dailyLimitBody
    const DAILY = { code: 'DAILY_LIMIT', message: "You've asked 20 questions today. Ask again tomorrow.",
      error: "You've asked 20 questions today. Ask again tomorrow.", reason: 'daily_limit', scope: 'day',
      resetAt: '2026-10-31T00:00:00Z', retryable: false, retryAfterSeconds: 41000 };
    const { app } = appWith(url => (url.endsWith('/gateway/ai-sessions') ? STARTED : [429, DAILY]));
    const chat = await app.chat.start({ agentId: 'a1' });
    await assert.rejects(chat.send('hi'), e => {
      assert.ok(e instanceof AppError);
      assert.equal(e.status, 429);
      assert.equal(e.code, 'DAILY_LIMIT');
      assert.equal(e.message, DAILY.message);
      assert.equal(e.details.resetAt, '2026-10-31T00:00:00Z');
      return true;
    });
  });

  it('history gives each AgentTurn the role the Turn type promises', async () => {
    // ai-runtime SessionController.SessionHistoryResponse / SessionHistoryData; turns are
    // base-ai-common src/main/java/com/svai/ai/agent/AgentTurn.java (type, content, toolCalls, toolResults, timestamp,
    // attachmentIds, promptTokens, completionTokens, durationMs) - no `role`.
    const HISTORY = {
      success: true, error: null, historyUrl: null,
      metadata: { sessionId: 's1', status: 'ACTIVE', assistantId: 'a1', messageCount: 3, totalInputTokens: 812, totalOutputTokens: 95, totalTokens: 907, estimatedCostUsd: null, sessionDurationMs: 42000 },
      history: { sessionId: 's1', assistantId: 'a1', turnCount: 3, historySummary: null, attachments: [], turns: [
        { type: 'USER_MESSAGE', content: 'Plan my week', toolCalls: null, toolResults: null, timestamp: 1793300000000, attachmentIds: null, promptTokens: null, completionTokens: null, durationMs: null },
        { type: 'TOOL_CALL', content: null, toolCalls: [{ id: 't1', name: 'calendar_list', arguments: '{}' }], toolResults: null, timestamp: 1793300001000, attachmentIds: null, promptTokens: null, completionTokens: null, durationMs: null },
        { type: 'ASSISTANT_MESSAGE', content: 'Here is your plan.', toolCalls: null, toolResults: null, timestamp: 1793300012000, attachmentIds: null, promptTokens: 812, completionTokens: 95, durationMs: 11000 },
      ] },
    };
    const { app, calls } = appWith(() => HISTORY);
    const turns = await app.chat.history('s1');
    assert.equal(calls[0].url, `${RT}/sessions/history/s1`);
    assert.deepEqual(turns.map(t => t.role), ['user', 'tool', 'assistant']);
    assert.deepEqual(turns.map(t => t.content), ['Plan my week', '', 'Here is your plan.']);
    assert.equal(turns[0].type, 'USER_MESSAGE', 'the platform fields are kept');
    // Not found is a 200 {success:false} (SessionHistoryResponse.notFound).
    const missing = appWith(() => ({ success: false, error: 'Session not found', metadata: { sessionId: 's2', status: 'NOT_FOUND' }, history: null, historyUrl: null }));
    await assert.rejects(missing.app.chat.history('s2'), e => e.status === 404);
  });

  it('list reads the bare Conversation array', async () => {
    // ai-runtime EndUserConversationsController.Conversation
    const ROW = { id: 's1', title: 'Kitchen redo', agentId: 'a1', contextRef: 'project:p1', status: 'ACTIVE', turnCount: 6,
      createdAt: '2026-10-29T14:02:11.123Z', lastMessageAt: '2026-10-30T09:15:40.456Z' };
    const { app, calls } = appWith(() => [ROW]);
    const rows = await app.chat.list({ projectId: 'p1' });
    assert.equal(calls[0].url, `${RT}/sessions/mine?contextRef=project%3Ap1&limit=20`);
    assert.deepEqual(rows, [ROW]);
  });
});

describe('account, credits and pictures contract (ai-runtime)', () => {
  it('allowance: a one-time allowance has resetsOn null and period once', async () => {
    // ai-runtime EndUserConversationsController.Allowance(usedUsd, monthlyBudgetUsd, resetsOn, period)
    const { app, calls } = appWith(() => ({ usedUsd: 0.5, monthlyBudgetUsd: 0.5, resetsOn: null, period: 'once' }));
    const a = await app.account.allowance();
    assert.equal(calls[0].url, `${RT}/sessions/mine/allowance`);
    assert.equal(a.resetsOn, null);
    assert.equal(a.period, 'once');
  });

  it('credits estimate for a design with no hint is credits: null', async () => {
    // ai-runtime EndUserCreditsController.estimate - a LinkedHashMap {action, credits, basis}
    const { app, calls } = appWith(() => ({ action: 'design', credits: null, basis: 'hint' }));
    const e = await app.credits.estimate('design');
    assert.match(calls[0].url, /\/sessions\/mine\/credits\/estimate\?action=design/);
    assert.equal(e.credits, null);
  });

  it('images: 402 NO_ALLOWANCE is not AllowanceUsed; 402 ALLOWANCE_USED is', async () => {
    // ai-runtime EndUserImagesController: Map.of("error", ..., "code", "NO_ALLOWANCE" | "ALLOWANCE_USED")
    const off = appWith(() => [402, { error: 'Pictures are not available in this app yet.', code: 'NO_ALLOWANCE' }]);
    await assert.rejects(off.app.images.make({ images: ['data:image/png;base64,AA=='], prompt: 'p' }), e => {
      assert.ok(!(e instanceof AllowanceUsed));
      assert.equal(e.code, 'NO_ALLOWANCE');
      assert.equal(e.status, 402);
      return true;
    });
    const used = appWith(() => [402, { error: 'This month’s AI allowance is used up.', code: 'ALLOWANCE_USED' }]);
    await assert.rejects(used.app.images.make({ images: ['data:image/png;base64,AA=='], prompt: 'p' }), e => e instanceof AllowanceUsed);
  });
});

describe('push contract (notification)', () => {
  // notification src/main/java/com/svai/workflow/notification/app/push/AppPushDevices.java - PreferencesView
  const PREFS = { enabled: true, categories: { requests: true }, quietStart: null, quietEnd: null, timezone: null,
    scopeHash: '3f9a0c7e2b1d4e6f8a9b0c1d2e3f4a5b' };

  it('preferences.set sends null as "" so quiet hours and the time zone really clear', async () => {
    const { app, calls } = appWith(() => PREFS);
    const p = await app.push.preferences.set({ quietStart: null, quietEnd: null, timezone: null, categories: { proposals: null } });
    assert.equal(calls[0].method, 'PUT');
    assert.equal(calls[0].url, `${API}/api/v1/workflow/notification/end-users/me/push/preferences`);
    // AppPushDevices.quiet(): both "" clears, null means unchanged; timezone(): "" clears; a null category is removed.
    assert.deepEqual(calls[0].body, { quietStart: '', quietEnd: '', timezone: '', categories: { proposals: null } });
    assert.deepEqual(p, PREFS);
  });

  it('preferences.set passes values through unchanged', async () => {
    const { app, calls } = appWith(() => PREFS);
    await app.push.preferences.set({ quietStart: '22:00', quietEnd: '07:00', timezone: 'America/New_York', enabled: false });
    assert.deepEqual(calls[0].body, { quietStart: '22:00', quietEnd: '07:00', timezone: 'America/New_York', enabled: false });
  });

  it('devices reads the bare DeviceView array', async () => {
    // AppPushDevices.DeviceView
    const DEVICE = { id: 'd1', platform: 'ios', transport: 'APNS', apnsEnvironment: 'production', deviceName: "Jane's iPhone",
      appVersion: '1.4.0', enabled: true, tokenEnd: 'a1b2c3', scopeHash: PREFS.scopeHash, createdAt: '2026-10-30T08:00:00Z',
      lastSeenAt: '2026-10-30T08:00:00Z', lastPushAt: null };
    const { app, calls } = appWith(() => [DEVICE]);
    assert.deepEqual(await app.push.devices(), [DEVICE]);
    assert.equal(calls[0].url, `${API}/api/v1/workflow/notification/end-users/me/push/devices`);
  });
});

describe('sign-in contract (connection token exchange)', () => {
  const ISSUER = 'https://auth.example.test/realms/apps';

  function store() {
    const m = new Map();
    return { m, getItem: k => m.get(k) ?? null, setItem: (k, v) => void m.set(k, String(v)), removeItem: k => void m.delete(k) };
  }

  async function signInAnswered(status, refusal) {
    const fetch = async (url) => {
      if (url === `${ISSUER}/protocol/openid-connect/token`) {
        return new Response(JSON.stringify({ access_token: 'realm-at', refresh_token: 'rt-1' }), { status: 200 });
      }
      if (url === `${API}/api/v1/workflow/connection/oauth/token`) return new Response(JSON.stringify(refusal), { status });
      return new Response(null, { status: 204 });
    };
    const auth = new Auth({ apiUrl: API, aiRuntimeUrl: API, dataUrl: API, signInIssuer: ISSUER, clientId: 'web', storageKey: 'ws.c',
      storage: store(), fetch, redirectUri: 'https://app.example.test/' });
    const state = new URL(await auth.signInUrl()).searchParams.get('state');
    return auth.completeSignIn(`https://app.example.test/?code=c1&state=${state}`);
  }

  it('NOT_A_MEMBER keeps its code and organization', async () => {
    // connection OAuthTokenExchangeController: 403 {error:"invalid_target", error_description, code:"NOT_A_MEMBER", organization}
    await assert.rejects(signInAnswered(403, { error: 'invalid_target', error_description: 'Only members of Acme Field Ops can use this app.',
      code: 'NOT_A_MEMBER', organization: 'Acme Field Ops' }), e => {
      assert.ok(e instanceof AppError);
      assert.equal(e.status, 403);
      assert.equal(e.code, 'NOT_A_MEMBER');
      assert.equal(e.details.organization, 'Acme Field Ops');
      assert.equal(e.details.error, 'invalid_target');
      return true;
    });
  });

  it('a refusal with no code keeps the RFC error as its code', async () => {
    await assert.rejects(signInAnswered(400, { error: 'invalid_grant', error_description: 'The sign-in has expired.' }),
      e => e.code === 'invalid_grant' && e.message === 'The sign-in has expired.');
  });
});

describe('content, files, data and projects contract', () => {
  it('a content page never asks for more than 60 items', async () => {
    // catalog ContentPages.page: limit outside 1..MAX_LIMIT (60) is a 400. Page record:
    const PAGE = { name: 'featured', displayName: 'Featured designs', description: null, version: 7, fields: [],
      items: [{ key: 'loft', data: { title: 'Loft' }, sortOrder: 1 }], nextCursor: null, total: 1 };
    const { app, calls } = appWith(() => PAGE);
    const page = await app.content.pack('featured').page({ limit: 100 });
    assert.match(calls[0].url, /\/api\/v1\/workflow\/catalog\/app-content\/featured\?limit=60(&|$)/);
    assert.equal(page.total, 1);
  });

  it('files.list reads MyFiles.files', async () => {
    // storage EndUserFilesController.MyFiles {files, total, page, size}
    const FILE = { id: 'f1', name: 'room.jpg', contentType: 'image/jpeg', size: 482113, createdAt: '2026-10-30T07:59:12Z' };
    const { app, calls } = appWith(() => ({ files: [FILE], total: 1, page: 0, size: 50 }));
    const files = await app.files.list();
    assert.match(calls[0].url, /\/api\/v1\/workflow\/storage\/my-files\?/);
    assert.deepEqual(files, [FILE]);
  });

  it('data find reads QueryResult.records and lifts authorship from source', async () => {
    // base-managed-data QueryResult {records, total} of ManagedRecord (datastore-service DatastoreResource)
    const REC = { id: 'r1', key: 'q-1001', projectId: null, scopeKey: 'app:x', data: { title: 'Quote' },
      source: { createdBy: 'enduser:a', createdByName: 'jane@acme.com', updatedBy: 'enduser:b', updatedByName: 'sam@acme.com' },
      createdAt: '2026-10-30T08:00:00Z', updatedAt: '2026-10-30T08:05:00Z' };
    const { app, calls } = appWith(() => ({ records: [REC], total: 1 }));
    const [row] = await app.data.collection('quotes').find({ limit: 5 });
    assert.equal(calls[0].url, `${API}/api/v1/workflow/data/collections/quotes/records?limit=5`);
    assert.equal(row.id, 'r1');
    assert.equal(row.data.title, 'Quote');
  });

  it('projects.list reads the Spring Page content', async () => {
    // studio-management TechProjectController.list -> Page<ProjectListItem> (Spring Page: {content, ...})
    const ITEM = { id: 'p1', name: 'Kitchen refresh', description: null, icon: 'home', color: '#4F7CFF', enabledAbilities: [],
      status: 'ACTIVE', createdAt: '2026-10-29T14:02:11.123Z', updatedAt: '2026-10-30T09:15:40.456Z', createdBy: 'enduser:a',
      groupTags: null, conversationCount: 0, version: 3 };
    const { app, calls } = appWith(() => ({ content: [ITEM], totalElements: 1, totalPages: 1, size: 50, number: 0, first: true, last: true, empty: false }));
    const list = await app.projects.list();
    assert.match(calls[0].url, /\/api\/v1\/workflow\/tech-projects\?/);
    assert.equal(list[0].id, 'p1');
  });
});

describe('connection end-user contract', () => {
  it('requests.list keeps the nulls a list item has', async () => {
    // connection AppRequests.RequestView (summaryView): blocked, payload, attachments, messages null; projectId
    const ROW = { id: 'r1', role: 'requester', kind: 'quote', ref: null, title: 'Shelf', status: 'open', endedBy: null,
      listing: { id: 'l1', kind: 'shop', displayName: 'Oak & Co', contact: null }, requester: { name: 'Asha', email: null, phone: null },
      blocked: null, payload: null, attachments: null, messages: null, createdAt: '2026-10-28T09:00:00Z', updatedAt: '2026-10-28T09:00:00Z',
      answeredAt: null, lastMessageAt: '2026-10-28T09:00:00Z', projectId: null };
    const { app, calls } = appWith(() => [ROW]);
    assert.deepEqual(await app.requests.list(), [ROW]);
    assert.equal(calls[0].url, `${ME}/requests`);
  });

  it('billing.plan reads PlanView, price included', async () => {
    // connection AppBillingService.PlanView (+ PriceOffer price)
    const PLAN = { enabled: true, plan: 'pro', name: 'Pro', monthlyBudgetUsd: 20.0, paid: true, status: 'active', renewsAt: '2026-11-30T00:00:00Z',
      endsAt: null, cancelAtPeriodEnd: false, canUpgrade: false, canManage: true, defaultPlan: 'free', plans: [], features: [],
      trialEndsAt: null, hasPaymentMethod: true, source: 'web', manage: { kind: 'stripe_portal', url: null }, otherPaying: [], paidTwice: false,
      paidTwiceNotice: null, next: null, canChange: true, price: { id: 'price_pro_m', interval: 'month', amountCents: 799, currency: 'usd' }, grant: null };
    const { app, calls } = appWith(() => PLAN);
    const plan = await app.billing.plan();
    assert.equal(calls[0].url, `${ME}/plan`);
    assert.equal(plan.price.amountCents, 799);
  });
});
