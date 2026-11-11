import { createNeonClient, type NeonClient } from '@neon/sdk';
import { NeonError } from '../core/errors';

export type Neon = NeonClient<true>;

const REQUEST_TIMEOUT_MS = 30_000;

export interface Profile {
  id: string;
  name: string;
  email: string;
  username: string;
}

export function parseProfile(value: unknown): Profile {
  if (!value || typeof value !== 'object') {
    throw new NeonError('Neon returned an invalid profile. Try refreshing it.');
  }
  const user = value as Record<string, unknown>;
  if (typeof user.id !== 'string' || !user.id) {
    throw new NeonError('Neon returned an invalid profile. Try refreshing it.');
  }
  const text = (key: string) =>
    typeof user[key] === 'string' ? user[key].trim() : '';
  const email = text('email') || text('login');
  return {
    id: user.id,
    name:
      [text('name'), text('last_name')].filter(Boolean).join(' ') ||
      email ||
      user.id,
    email,
    username: text('login') || email || user.id,
  };
}

export interface ProfileApi {
  getCurrentUser(accessToken: string): Promise<Profile>;
}

export const profileApi: ProfileApi = {
  async getCurrentUser(accessToken) {
    const neon = createNeonClient({
      apiKey: accessToken,
      throwOnError: true,
      requestTimeoutMs: REQUEST_TIMEOUT_MS,
    });
    return parseProfile(await neon.user.me());
  },
};

export function createApi(
  accessToken: (forceRefresh?: boolean) => Promise<string>,
): Neon {
  const authorizedFetch: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const retry = request.clone();
    const response = await fetch(request);
    if (response.status !== 401) return response;
    retry.headers.set('Authorization', `Bearer ${await accessToken(true)}`);
    return fetch(retry);
  };
  return createNeonClient({
    apiKey: () => accessToken(),
    throwOnError: true,
    requestTimeoutMs: REQUEST_TIMEOUT_MS,
    fetch: authorizedFetch,
  });
}
