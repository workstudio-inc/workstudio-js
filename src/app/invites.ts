import type { Auth } from './auth';
import type { Plan, PlanGrant } from './billing';
import { AppError } from './errors';
import type { Http } from './http';

/**
 * What an invite link gives, before anyone signs in - and nothing about anyone: never the address it was sent to,
 * who used it or when.
 *
 * `status`: `ok` (it can be used), `used`, `expired`, `revoked` (the publisher cancelled it), or `unavailable`
 * (the App turned invites off, or the plan is no longer one invites may give).
 */
export interface InvitePreview {
  app: { id: string; name: string | null };
  plan: { id: string; name: string | null };
  /** How long the plan is given for. */
  months: number;
  status: 'ok' | 'used' | 'expired' | 'revoked' | 'unavailable';
  /** When an unused invite stops working (ISO time). */
  expiresAt: string | null;
  /** Only the address it was sent to can use it (the address itself is never shown): say "sign in with the email this was sent to". */
  emailLocked: boolean;
}

/** A redeemed invite: the grant it gave, and the person's plan now. */
export interface InviteRedemption {
  grant: PlanGrant;
  plan: Plan;
}

/**
 * Why a redeem was refused - each an {@link AppError} with this `code` and a `message` fit to show the person:
 * `NO_SUCH_INVITE` (404), `INVITE_USED` (409), `INVITE_EXPIRED` (410), `INVITE_REVOKED` (410),
 * `INVITE_EMAIL_MISMATCH` (403: sign in with the address it was sent to), `INVITE_ALREADY_HAD` (409: one per person
 * per App), `PLAN_NOT_INVITABLE` (409), `SLOW_DOWN` (429), `UNAVAILABLE` (503), `NOT_AN_END_USER` (403).
 */
export type InviteRefusal =
  | 'NO_SUCH_INVITE' | 'INVITE_USED' | 'INVITE_EXPIRED' | 'INVITE_REVOKED' | 'INVITE_EMAIL_MISMATCH' | 'INVITE_ALREADY_HAD'
  | 'PLAN_NOT_INVITABLE' | 'SLOW_DOWN' | 'UNAVAILABLE' | 'NOT_AN_END_USER';

/** The shape of a token: what the platform makes (base64url, 24 characters). Anything else is not one. */
const TOKEN = /^[A-Za-z0-9_-]{16,64}$/;

/**
 * Invites: a single-use link from the App's publisher (`<the App's site>/i/<token>`) that gives one of the App's
 * paid plans for some months - no payment, no card. The App's invite page reads the token from the address
 * ({@link tokenFromUrl}), shows what it gives ({@link preview}, before anyone signs in), has the person sign up or
 * sign in, then {@link redeem}s it: the plan is theirs at once.
 *
 * While the grant runs, `billing.plan()` says `source: 'grant'`, `paid: false` and `endsAt` (when it ends, and the
 * person is on the App's free plan again, keeping everything). A paid plan bought meanwhile takes over.
 */
export class Invites {
  constructor(private readonly http: Http, private readonly auth: Auth) {}

  /**
   * What the invite gives and whether it can still be used - nobody needs to be signed in. Needs the App's `appId`
   * in the config. A token that is unknown, malformed or another App's is `AppError` 404 `NO_SUCH_INVITE`; too many
   * looks from one place in a short while, 429 `SLOW_DOWN`.
   */
  preview(token: string): Promise<InvitePreview> {
    const appId = this.http.config.appId;
    if (!appId) throw new AppError(0, 'Invites need the App id (appId) in the config.', 'NO_APP_ID');
    // A POST with the token in its body: never in an address that gets logged, and never fetched by a link previewer.
    return this.http.anonymous(`${this.http.config.apiUrl}/api/v1/public/apps/${encodeURIComponent(appId)}/invites/preview`, 'POST',
      { token: clean(token) });
  }

  /**
   * Use the invite as the signed-in person: the plan is theirs now, for the invite's months. Then a fresh platform
   * token is fetched, which carries the plan's allowance (the redeem stands whether or not that works). Redeeming the
   * same invite again as the same person answers the same grant. Refusals: see {@link InviteRefusal}.
   */
  async redeem(token: string): Promise<InviteRedemption> {
    const result = await this.http.request<InviteRedemption>('POST', this.http.api('/connection/end-users/me/invites/redeem'),
      { token: clean(token) });
    try {
      await this.auth.renew();
    } catch {
      // The next token refresh brings it.
    }
    return result;
  }

  /**
   * The token in an invite link: `https://crava.me/i/AbC...` (or just `/i/AbC...`, or a hash route `#/i/AbC...`)
   * gives `AbC...`. Defaults to this page's address and the path `/i`. Null when the address is not an invite link.
   */
  tokenFromUrl(url?: string, path = '/i'): string | null {
    const href = url ?? (typeof location !== 'undefined' ? location.href : '');
    if (!href) return null;
    const base = `/${path.replace(/^\/+|\/+$/g, '')}/`;
    let candidates: string[];
    try {
      const u = new URL(href, 'https://invite.invalid');
      candidates = [u.pathname, u.hash.replace(/^#/, '')];
    } catch {
      return null;
    }
    for (const c of candidates) {
      const at = c.indexOf(base);
      if (at < 0) continue;
      const token = decodeURIComponent(c.slice(at + base.length).split(/[/?#]/)[0] ?? '');
      if (TOKEN.test(token)) return token;
    }
    return null;
  }
}

function clean(token: string): string {
  const t = String(token ?? '').trim();
  if (!t) throw new AppError(404, 'This invite link is not complete. Open the link you were sent again.', 'NO_SUCH_INVITE');
  return t;
}
