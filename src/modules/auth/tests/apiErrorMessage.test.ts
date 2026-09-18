import { describe, expect, it } from 'vitest';

import { resolveApiErrorMessage } from '@/modules/auth/utils/apiErrorMessage';

const translate = (key: string): string => `translated:${key}`;
const fallback = 'Login failed';

describe('resolveApiErrorMessage', () => {
  it('keeps a plain string error from the handlers that answer with one', () => {
    expect(resolveApiErrorMessage({ error: 'Access denied' }, fallback, translate)).toBe('Access denied');
  });

  it('uses the localised message for a structured AUTH_INVALID_CREDENTIALS error', () => {
    const payload = {
      success: false,
      error: { code: 'AUTH_INVALID_CREDENTIALS', message: 'Invalid username or password' },
    };

    expect(resolveApiErrorMessage(payload, fallback, translate)).toBe(
      'translated:login.errors.invalidCredentials',
    );
  });

  it('uses the localised message for a structured AUTH_CREDENTIALS_REQUIRED error', () => {
    const payload = {
      error: { code: 'AUTH_CREDENTIALS_REQUIRED', message: 'Username and password are required' },
    };

    expect(resolveApiErrorMessage(payload, fallback, translate)).toBe(
      'translated:login.errors.requiredFields',
    );
  });

  it('falls back to the structured message for codes without a localised one', () => {
    const payload = { error: { code: 'SOMETHING_ELSE', message: 'Server said no' } };

    expect(resolveApiErrorMessage(payload, fallback, translate)).toBe('Server said no');
  });

  it('never returns the structured object itself', () => {
    const payload = { error: { code: 'NO_MESSAGE', details: { field: 'username' } } };

    const message = resolveApiErrorMessage(payload, fallback, translate);

    expect(typeof message).toBe('string');
    expect(message).toBe(fallback);
  });

  it('accepts a top-level message when there is no error field', () => {
    expect(resolveApiErrorMessage({ message: 'Registration is closed' }, fallback, translate)).toBe(
      'Registration is closed',
    );
  });

  it('ignores blank strings and returns the fallback', () => {
    expect(resolveApiErrorMessage({ error: '   ', message: '  ' }, fallback, translate)).toBe(fallback);
    expect(resolveApiErrorMessage(null, fallback, translate)).toBe(fallback);
  });
});
