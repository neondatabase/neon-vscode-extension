import { isNeonError } from '@neon/sdk';

export class NeonError extends Error {}

export class SignInCancelledError extends NeonError {
  constructor() {
    super('Sign-in was cancelled.');
  }
}

export class SessionExpiredError extends NeonError {
  constructor() {
    super('Your Neon session has expired. Please sign in again.');
  }
}

export function isUnauthorized(error: unknown): boolean {
  return isNeonError(error) && error.kind === 'auth' && error.status === 401;
}

export function isNotFound(error: unknown): boolean {
  return isNeonError(error) && error.kind === 'not_found';
}

function unwrap(error: unknown): unknown {
  return isNeonError(error) && error.cause instanceof NeonError
    ? error.cause
    : error;
}

export function isSessionExpired(error: unknown): boolean {
  return unwrap(error) instanceof SessionExpiredError;
}

export function isCancellation(error: unknown): boolean {
  error = unwrap(error);
  return (
    error instanceof SignInCancelledError ||
    (isNeonError(error) && error.kind === 'aborted') ||
    (error instanceof DOMException && error.name === 'AbortError')
  );
}

export function userMessage(error: unknown): string {
  error = unwrap(error);
  if (error instanceof NeonError) return error.message;
  if (!isNeonError(error))
    return 'Neon could not complete the request. Check your connection and try again.';
  switch (error.kind) {
    case 'auth':
      return error.status === 401
        ? 'Neon did not accept your session. Please sign in again.'
        : `You don't have permission to do that in Neon. ${error.message}`;
    case 'rate_limit':
      return 'Neon is rate limiting requests. Wait a moment and try again.';
    case 'network':
      return 'Could not reach Neon. Check your connection and try again.';
    case 'timeout':
      return error.source === 'wait'
        ? 'Neon is still working on this. Refresh in a moment to see the result.'
        : 'Neon took too long to respond. Try again.';
    default:
      return error.message;
  }
}
