/** A request the platform refused or could not complete. `message` is fit to show the person. */
export class AppError extends Error {
  /** HTTP status, or 0 when the request never got an answer. */
  readonly status: number;
  /** A machine-readable reason, when the platform gave one. */
  readonly code?: string;

  constructor(status: number, message: string, code?: string) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    Object.setPrototypeOf(this, AppError.prototype);
  }
}

/** Nobody is signed in, or their sign-in has lapsed: call `auth.signIn()`. */
export class SignInRequired extends AppError {
  constructor(message = 'Please sign in.') {
    super(401, message, 'SIGN_IN_REQUIRED');
    this.name = 'SignInRequired';
    Object.setPrototypeOf(this, SignInRequired.prototype);
  }
}

/** The person has used this month's AI allowance the App gives them; it resets on the 1st (UTC). */
export class AllowanceUsed extends AppError {
  constructor(message = 'This month’s AI allowance is used up.') {
    super(429, message, 'ALLOWANCE_USED');
    this.name = 'AllowanceUsed';
    Object.setPrototypeOf(this, AllowanceUsed.prototype);
  }
}
