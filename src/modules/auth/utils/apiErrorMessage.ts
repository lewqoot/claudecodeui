/** The structured `error` object the shared Express error middleware answers with. */
export type ApiErrorObject = {
  code?: string;
  message?: string;
  details?: unknown;
};

/**
 * The `error` field of an API envelope. Handlers answer with a plain string, the shared error
 * middleware with `{ code, message, details }` — both shapes have to be accepted here.
 */
export type ApiErrorPayload = {
  error?: string | ApiErrorObject;
  message?: string;
};

/** Translation like the one `useTranslation()` returns on the auth screens. */
export type ApiErrorTranslator = (key: string) => string;

/** Server codes that already have a dedicated message in the auth locales. */
const AUTH_ERROR_CODE_KEYS: Record<string, string> = {
  AUTH_INVALID_CREDENTIALS: 'login.errors.invalidCredentials',
  AUTH_CREDENTIALS_REQUIRED: 'login.errors.requiredFields',
};

/**
 * Flattens an auth API error envelope into one line of text.
 *
 * The login handler answers `{ error: { code, message } }` through the shared error middleware while
 * the other handlers answer `{ error: 'text' }`. The login screen rendered that object directly and
 * crashed with React error #31 — a white screen on every failed sign-in — so the object is never
 * returned as-is. Codes with a localised message use it, otherwise the server text is kept.
 */
export function resolveApiErrorMessage(
  payload: ApiErrorPayload | null,
  fallback: string,
  translate: ApiErrorTranslator,
): string {
  const error = payload?.error;

  if (typeof error === 'string' && error.trim()) {
    return error;
  }

  if (error && typeof error === 'object') {
    const key = typeof error.code === 'string' ? AUTH_ERROR_CODE_KEYS[error.code] : undefined;
    if (key) {
      return translate(key);
    }
    if (typeof error.message === 'string' && error.message.trim()) {
      return error.message;
    }
  }

  const message = payload?.message;
  if (typeof message === 'string' && message.trim()) {
    return message;
  }

  return fallback;
}
