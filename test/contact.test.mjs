// app.contactForm on the built package (npm test builds first), with a small fake page: the challenge frame's
// postMessage checks (exact origin, this iframe's window, the v1 shape, this App and form, this mount's nonce), the
// widget on *.workstudio.run, the contact request it sends, a token used once, and unmount.
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { AppError, APP_CONTACT_SITE_KEY, CHALLENGE_ORIGIN, ContactCheck, ContactForm, createApp } from '../dist/app.js';

const API = 'https://api.example.test';
const APP = 'c7a7a000-0000-4000-8000-000000000042';
const TOKEN = '0.ZXhhbXBsZS10dXJuc3RpbGUtdG9rZW4';
const MESSAGE = { email: ' ana@example.com ', subject: 'Hello', message: 'Is the shop open on Sundays?' };
const RECEIPT = { id: '019f0000-0000-7000-8000-000000000001', ticketNumber: 'TKT-261029-1001', message: 'Sent' };

// --- a fake page -------------------------------------------------------------------------------------------------

class FakeWindow {
  constructor() {
    this.listeners = new Set();
    this.posted = [];
  }
  addEventListener(type, l) {
    if (type === 'message') this.listeners.add(l);
  }
  removeEventListener(type, l) {
    if (type === 'message') this.listeners.delete(l);
  }
  postMessage(data, targetOrigin) {
    this.posted.push({ data, targetOrigin });
  }
  dispatch(event) {
    for (const l of [...this.listeners]) l(event);
  }
}

class FakeElement {
  constructor(tag) {
    this.tag = tag;
    this.children = [];
    this.parent = null;
    this.attrs = {};
    if (tag === 'iframe') this.contentWindow = new FakeWindow();
  }
  setAttribute(k, v) {
    this.attrs[k] = v;
  }
  appendChild(c) {
    c.parent = this;
    this.children.push(c);
    return c;
  }
  remove() {
    if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this);
    this.parent = null;
  }
}

let page;

function installPage(href) {
  const u = new URL(href);
  const win = new FakeWindow();
  const head = new FakeElement('head');
  const doc = { head, createElement: (tag) => new FakeElement(tag) };
  globalThis.window = win;
  globalThis.document = doc;
  Object.defineProperty(globalThis, 'location', {
    configurable: true,
    value: { href: u.href, origin: u.origin, hostname: u.hostname, host: u.host, pathname: u.pathname },
  });
  page = { win, doc, head };
  return page;
}

function removePage() {
  delete globalThis.window;
  delete globalThis.document;
  delete globalThis.location;
  page = undefined;
}

function client(replies = [], config = {}) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body === undefined ? undefined : JSON.parse(init.body) });
    const r = replies.shift() ?? { status: 202, body: RECEIPT };
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status ?? 200, headers: { 'Content-Type': 'application/json' } });
  };
  const app = createApp({ apiUrl: API, appId: APP, signInIssuer: 'https://auth.example.test/realms/apps', clientId: 'web', fetch, ...config });
  return { app, calls };
}

/** The iframe a frame-mode mount put in the container, and the nonce it sent. */
function frameOf(container) {
  const iframe = container.children.find((c) => c.tag === 'iframe');
  assert.ok(iframe, 'an iframe is mounted');
  const url = new URL(iframe.src);
  return { iframe, url, nonce: url.searchParams.get('nonce') };
}

function frameEvent(iframe, nonce, data, overrides = {}) {
  return {
    origin: CHALLENGE_ORIGIN,
    source: iframe.contentWindow,
    data: { type: 'workstudio:turnstile', v: 1, appId: APP, action: 'app-contact', nonce, ...data },
    ...overrides,
  };
}

// --- tests -------------------------------------------------------------------------------------------------------

describe('app.contactForm', () => {
  afterEach(() => removePage());

  it('is on the client', () => {
    assert.ok(client().app.contactForm instanceof ContactForm);
  });

  it('picks the widget on workstudio.run hosts and the frame anywhere else', () => {
    const { app } = client();
    assert.equal(app.contactForm.modeFor('shop.workstudio.run'), 'widget');
    assert.equal(app.contactForm.modeFor('SHOP.WorkStudio.Run.'), 'widget');
    assert.equal(app.contactForm.modeFor('workstudio.run'), 'widget');
    assert.equal(app.contactForm.modeFor('app.acme.com'), 'frame');
    assert.equal(app.contactForm.modeFor('workstudio.run.evil.com'), 'frame');
    assert.equal(app.contactForm.modeFor('notworkstudio.run'), 'frame');
  });

  it('mount needs the App id, a page, and https on a custom domain', () => {
    assert.throws(() => client().app.contactForm.mount({}), (e) => e instanceof AppError && e.code === 'CHECK_NEEDS_BROWSER');
    installPage('http://app.acme.com/contact');
    assert.throws(() => client([], { appId: undefined }).app.contactForm.mount(new FakeElement('div')),
      (e) => e instanceof AppError && e.code === 'NO_APP_ID');
    assert.throws(() => client().app.contactForm.mount(new FakeElement('div')),
      (e) => e instanceof AppError && e.code === 'CHECK_NEEDS_HTTPS');
    installPage('https://app.acme.com/contact');
    assert.throws(() => client().app.contactForm.mount(new FakeElement('div'), { theme: 'neon' }),
      (e) => e instanceof AppError && e.code === 'BAD_OPTION');
    assert.throws(() => client().app.contactForm.mount(new FakeElement('div'), { size: 'huge' }),
      (e) => e instanceof AppError && e.code === 'BAD_OPTION');
    assert.throws(() => client().app.contactForm.mount(null), (e) => e instanceof AppError && e.code === 'BAD_OPTION');
  });
});

describe('app.contactForm on a custom domain (challenge frame)', () => {
  beforeEach(() => installPage('https://app.acme.com/contact?code=secret#top'));
  afterEach(() => removePage());

  it('mounts the frame with the App, this origin, the form action and a per-mount nonce', () => {
    const { app } = client();
    const container = new FakeElement('div');
    const a = app.contactForm.mount(container, { theme: 'dark', size: 'compact' });
    assert.ok(a instanceof ContactCheck);
    assert.equal(a.mode, 'frame');
    const { iframe, url, nonce } = frameOf(container);
    assert.equal(url.origin, CHALLENGE_ORIGIN);
    assert.equal(url.pathname, '/turnstile');
    assert.equal(url.searchParams.get('app'), APP);
    assert.equal(url.searchParams.get('origin'), 'https://app.acme.com');
    assert.equal(url.searchParams.get('action'), 'app-contact');
    assert.equal(url.searchParams.get('theme'), 'dark');
    assert.equal(url.searchParams.get('size'), 'compact');
    assert.match(nonce, /^[A-Za-z0-9_-]{22}$/);
    assert.equal(iframe.title, 'Verification');
    a.unmount();
  });

  it('two mounts get different nonces', () => {
    const { app } = client();
    const c1 = new FakeElement('div');
    const c2 = new FakeElement('div');
    const a = app.contactForm.mount(c1);
    const b = app.contactForm.mount(c2);
    assert.notEqual(frameOf(c1).nonce, frameOf(c2).nonce);
    a.unmount();
    b.unmount();
  });

  it('takes the token from its own frame with the exact origin, shape, App, action and nonce', async () => {
    const { app } = client();
    const container = new FakeElement('div');
    const tokens = [];
    const check = app.contactForm.mount(container, { onToken: (t) => tokens.push(t) });
    const { iframe, nonce } = frameOf(container);
    page.win.dispatch(frameEvent(iframe, nonce, { event: 'ready' }));
    await check.ready;
    assert.equal(check.token, null);
    page.win.dispatch(frameEvent(iframe, nonce, { event: 'token', token: TOKEN }));
    assert.equal(check.token, TOKEN);
    assert.deepEqual(tokens, [TOKEN]);
    assert.equal(await check.waitForToken(10), TOKEN);
    check.unmount();
  });

  it('ignores every message that is not exactly from its frame', () => {
    const { app } = client();
    const container = new FakeElement('div');
    const check = app.contactForm.mount(container, { readyTimeoutMs: 50 });
    const { iframe, nonce } = frameOf(container);
    const forged = [
      // Another origin: look-alikes, the custom domain itself, http, a trailing slash.
      frameEvent(iframe, nonce, { event: 'token', token: 'a' }, { origin: 'https://evil.example' }),
      frameEvent(iframe, nonce, { event: 'token', token: 'b' }, { origin: 'https://challenge.workstudio.run.evil.example' }),
      frameEvent(iframe, nonce, { event: 'token', token: 'c' }, { origin: 'http://challenge.workstudio.run' }),
      frameEvent(iframe, nonce, { event: 'token', token: 'd' }, { origin: 'https://challenge.workstudio.run/' }),
      frameEvent(iframe, nonce, { event: 'token', token: 'e' }, { origin: 'https://app.acme.com' }),
      frameEvent(iframe, nonce, { event: 'token', token: 'f' }, { origin: 'https://other.workstudio.run' }),
      // The right origin, but another window (another frame of the challenge host on the page).
      frameEvent(iframe, nonce, { event: 'token', token: 'g' }, { source: new FakeWindow() }),
      frameEvent(iframe, nonce, { event: 'token', token: 'h' }, { source: null }),
      // A wrong, missing or stale nonce.
      frameEvent(iframe, 'AAAAAAAAAAAAAAAAAAAAAA', { event: 'token', token: 'i' }),
      frameEvent(iframe, undefined, { event: 'token', token: 'j' }),
      frameEvent(iframe, nonce.toUpperCase() === nonce ? nonce.toLowerCase() : nonce.toUpperCase(), { event: 'token', token: 'k' }),
      // Another App, another form, another version or type, a missing or oversized token, not an object.
      frameEvent(iframe, nonce, { event: 'token', token: 'l', appId: 'c7a7a000-0000-4000-8000-000000000099' }),
      frameEvent(iframe, nonce, { event: 'token', token: 'm', action: 'signup' }),
      frameEvent(iframe, nonce, { event: 'token', token: 'n', v: 2 }),
      frameEvent(iframe, nonce, { event: 'token', token: 'o', v: '1' }),
      frameEvent(iframe, nonce, { event: 'token', token: 'p', type: 'workstudio:other' }),
      frameEvent(iframe, nonce, { event: 'token' }),
      frameEvent(iframe, nonce, { event: 'token', token: '' }),
      frameEvent(iframe, nonce, { event: 'token', token: 'x'.repeat(2049) }),
      frameEvent(iframe, nonce, { event: 'token', token: 42 }),
      frameEvent(iframe, nonce, { event: 'surprise', token: 'q' }),
      { origin: CHALLENGE_ORIGIN, source: iframe.contentWindow, data: 'workstudio:turnstile token r' },
      { origin: CHALLENGE_ORIGIN, source: iframe.contentWindow, data: [{ type: 'workstudio:turnstile' }] },
      { origin: CHALLENGE_ORIGIN, source: iframe.contentWindow, data: null },
    ];
    for (const e of forged) page.win.dispatch(e);
    assert.equal(check.token, null);
    // Nor did any of them count as the frame being ready.
    page.win.dispatch(frameEvent(iframe, 'wrong-nonce-wrong-nonc', { event: 'ready' }));
    page.win.dispatch(frameEvent(iframe, nonce, { event: 'ready' }, { origin: 'https://evil.example' }));
    check.unmount();
  });

  it('send posts the message with the token to the public contact endpoint, then runs the check again', async () => {
    const { app, calls } = client([{ status: 202, body: RECEIPT }]);
    const container = new FakeElement('div');
    const check = app.contactForm.mount(container);
    const { iframe, nonce } = frameOf(container);
    page.win.dispatch(frameEvent(iframe, nonce, { event: 'ready' }));
    page.win.dispatch(frameEvent(iframe, nonce, { event: 'token', token: TOKEN }));

    const receipt = await check.send({ ...MESSAGE, name: 'Ana', category: 'question' });
    assert.deepEqual(receipt, RECEIPT);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, 'POST');
    assert.equal(calls[0].url, `${API}/api/v1/public/apps/${APP}/contact`);
    assert.equal(calls[0].headers.Authorization, undefined);
    assert.equal(calls[0].headers['Content-Type'], 'application/json');
    assert.deepEqual(calls[0].body, {
      email: 'ana@example.com',
      subject: 'Hello',
      message: 'Is the shop open on Sundays?',
      name: 'Ana',
      category: 'question',
      // The page's origin and path only: never its query or hash.
      context: { page: 'https://app.acme.com/contact', userAgent: navigator.userAgent },
      turnstileToken: TOKEN,
    });

    // The token was used once: dropped, and the frame told to run the check again (to its origin only).
    assert.equal(check.token, null);
    assert.deepEqual(iframe.contentWindow.posted, [
      { data: { type: 'workstudio:turnstile', v: 1, event: 'reset', nonce }, targetOrigin: CHALLENGE_ORIGIN },
    ]);
    check.unmount();
  });

  it('send waits for the token, and the token is reset even when the platform refuses the message', async () => {
    const { app, calls } = client([{ status: 400, body: { error: 'CAPTCHA_FAILED', message: 'Please confirm you\'re not a robot, then send again.' } }]);
    const container = new FakeElement('div');
    const check = app.contactForm.mount(container);
    const { iframe, nonce } = frameOf(container);
    const sending = check.send({ ...MESSAGE, context: null });
    setTimeout(() => page.win.dispatch(frameEvent(iframe, nonce, { event: 'token', token: TOKEN })), 5);
    await assert.rejects(sending, (e) => e instanceof AppError && e.status === 400 && e.code === 'CAPTCHA_FAILED');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].body.context, undefined);
    assert.equal(calls[0].body.turnstileToken, TOKEN);
    assert.equal(check.token, null);
    assert.equal(iframe.contentWindow.posted.length, 1);
    check.unmount();
  });

  it('send without a token in time is CHECK_TIMEOUT and sends nothing', async () => {
    const { app, calls } = client();
    const container = new FakeElement('div');
    const check = app.contactForm.mount(container);
    await assert.rejects(check.send(MESSAGE, { waitMs: 10 }), (e) => e instanceof AppError && e.code === 'CHECK_TIMEOUT');
    assert.equal(calls.length, 0);
    check.unmount();
  });

  it('a message that breaks the caps never leaves', async () => {
    const { app, calls } = client();
    const container = new FakeElement('div');
    const check = app.contactForm.mount(container);
    await assert.rejects(check.send({ ...MESSAGE, email: ' ' }), (e) => e.code === 'INVALID_MESSAGE' && e.details.field === 'email');
    await assert.rejects(check.send({ ...MESSAGE, subject: 'x'.repeat(201) }), (e) => e.code === 'INVALID_MESSAGE' && e.details.field === 'subject');
    await assert.rejects(check.send({ ...MESSAGE, message: 'x'.repeat(5001) }), (e) => e.code === 'INVALID_MESSAGE' && e.details.field === 'message');
    await assert.rejects(check.send({ ...MESSAGE, name: 'x'.repeat(121) }), (e) => e.code === 'INVALID_MESSAGE' && e.details.field === 'name');
    assert.equal(calls.length, 0);
    check.unmount();
  });

  it('an expired token is dropped; a timed-out challenge is reset; an error fails the wait with CHECK_ERROR', async () => {
    const { app } = client();
    const container = new FakeElement('div');
    const seen = [];
    const check = app.contactForm.mount(container, { onExpired: () => seen.push('expired'), onError: (e) => seen.push(e.code) });
    const { iframe, nonce } = frameOf(container);
    page.win.dispatch(frameEvent(iframe, nonce, { event: 'token', token: TOKEN }));
    page.win.dispatch(frameEvent(iframe, nonce, { event: 'expired' }));
    assert.equal(check.token, null);
    assert.equal(iframe.contentWindow.posted.length, 0);
    page.win.dispatch(frameEvent(iframe, nonce, { event: 'timeout' }));
    assert.equal(iframe.contentWindow.posted.length, 1);
    const waiting = check.waitForToken(1000);
    page.win.dispatch(frameEvent(iframe, nonce, { event: 'error', code: '110200' }));
    await assert.rejects(waiting, (e) => e instanceof AppError && e.code === 'CHECK_ERROR' && e.details.turnstileCode === '110200');
    assert.deepEqual(seen, ['expired', 'expired', 'CHECK_ERROR']);
    check.unmount();
  });

  it('a frame that never answers fails ready with CHECK_UNAVAILABLE, and so do waits', async () => {
    const { app } = client();
    const container = new FakeElement('div');
    const check = app.contactForm.mount(container, { readyTimeoutMs: 10 });
    const waiting = check.waitForToken(1000);
    await assert.rejects(check.ready, (e) => e instanceof AppError && e.code === 'CHECK_UNAVAILABLE');
    await assert.rejects(waiting, (e) => e.code === 'CHECK_UNAVAILABLE');
    await assert.rejects(check.waitForToken(1000), (e) => e.code === 'CHECK_UNAVAILABLE');
    check.unmount();
  });

  it('unmount removes the frame and its listener, fails pending waits, and ignores the frame afterwards', async () => {
    const { app } = client();
    const container = new FakeElement('div');
    const check = app.contactForm.mount(container);
    const { iframe, nonce } = frameOf(container);
    assert.equal(page.win.listeners.size, 1);
    const waiting = check.waitForToken(1000);
    check.unmount();
    await assert.rejects(waiting, (e) => e instanceof AppError && e.code === 'CHECK_UNMOUNTED');
    await assert.rejects(check.ready, (e) => e.code === 'CHECK_UNMOUNTED');
    assert.equal(check.mounted, false);
    assert.equal(container.children.length, 0);
    assert.equal(page.win.listeners.size, 0);
    // Even a message delivered to a listener kept elsewhere would not count now.
    page.win.dispatch(frameEvent(iframe, nonce, { event: 'token', token: TOKEN }));
    assert.equal(check.token, null);
    await assert.rejects(check.waitForToken(10), (e) => e.code === 'CHECK_UNMOUNTED');
    check.unmount(); // twice is fine
  });
});

describe('app.contactForm on workstudio.run (the widget on the page)', () => {
  beforeEach(() => installPage('https://shop.workstudio.run/contact'));
  afterEach(() => removePage());

  function fakeTurnstile() {
    const t = {
      rendered: [],
      resets: [],
      removed: [],
      render(el, options) {
        this.rendered.push({ el, options });
        return `w${this.rendered.length}`;
      },
      reset(id) {
        this.resets.push(id);
      },
      remove(id) {
        this.removed.push(id);
      },
    };
    return t;
  }

  it('renders the platform widget with the form action and the App as cdata, sends, resets, and removes it', async () => {
    const turnstile = fakeTurnstile();
    globalThis.window.turnstile = turnstile;
    const { app, calls } = client([{ status: 202, body: RECEIPT }]);
    const container = new FakeElement('div');
    const check = app.contactForm.mount(container, { theme: 'light' });
    assert.equal(check.mode, 'widget');
    await check.ready;
    assert.equal(container.children.length, 1);
    const { el, options } = turnstile.rendered[0];
    assert.equal(el, container.children[0]);
    assert.equal(options.sitekey, APP_CONTACT_SITE_KEY);
    assert.equal(options.action, 'app-contact');
    assert.equal(options.cdata, APP);
    assert.equal(options.theme, 'light');
    // No frame on a platform host: the challenge frame refuses them.
    assert.equal(container.children.some((c) => c.tag === 'iframe'), false);

    options.callback(TOKEN);
    const receipt = await check.send(MESSAGE);
    assert.deepEqual(receipt, RECEIPT);
    assert.equal(calls[0].url, `${API}/api/v1/public/apps/${APP}/contact`);
    assert.equal(calls[0].body.turnstileToken, TOKEN);
    assert.deepEqual(turnstile.resets, ['w1']);
    assert.equal(options['error-callback']('300030'), true);

    check.unmount();
    assert.deepEqual(turnstile.removed, ['w1']);
    assert.equal(container.children.length, 0);
  });

  it('loads Cloudflare\'s script when the page has not, and a failed load is CHECK_UNAVAILABLE', async () => {
    const { app } = client();
    const failing = app.contactForm.mount(new FakeElement('div'));
    const script = page.head.children.find((c) => c.tag === 'script');
    assert.equal(script.src, 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit');
    script.onerror();
    await assert.rejects(failing.ready, (e) => e instanceof AppError && e.code === 'CHECK_UNAVAILABLE');
    failing.unmount();

    const check = app.contactForm.mount(new FakeElement('div'), { siteKey: '1x00000000000000000000AA' });
    const again = page.head.children.filter((c) => c.tag === 'script');
    assert.equal(again.length, 2, 'tried again after the failed load');
    const turnstile = fakeTurnstile();
    globalThis.window.turnstile = turnstile;
    again[1].onload();
    await check.ready;
    assert.equal(turnstile.rendered[0].options.sitekey, '1x00000000000000000000AA');
    check.unmount();
  });
});

describe('app.contactForm.send with a token of your own', () => {
  it('posts it as is, and refuses an empty one before sending', async () => {
    const { app, calls } = client([{ status: 403, body: { error: 'FORBIDDEN_ORIGIN', message: 'Send this from the App\'s own site.' } }]);
    await assert.rejects(app.contactForm.send(MESSAGE, ''), (e) => e instanceof AppError && e.code === 'CHECK_NOT_DONE');
    assert.equal(calls.length, 0);
    await assert.rejects(app.contactForm.send({ ...MESSAGE, context: { page: 'p'.repeat(600) } }, TOKEN),
      (e) => e instanceof AppError && e.status === 403 && e.code === 'FORBIDDEN_ORIGIN');
    assert.equal(calls[0].body.turnstileToken, TOKEN);
    assert.equal(calls[0].body.context.page.length, 500);
  });

  it('needs the App id', async () => {
    const { app } = client([], { appId: undefined });
    await assert.rejects(app.contactForm.send(MESSAGE, TOKEN), (e) => e instanceof AppError && e.code === 'NO_APP_ID');
  });
});
