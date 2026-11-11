import * as oidc from 'openid-client';
import { NeonError, SessionExpiredError } from '../core/errors';
import { startLoopback } from './loopback';

export const AUTH_SCOPES = [
  'openid',
  'offline',
  'offline_access',
  'urn:neoncloud:projects:create',
  'urn:neoncloud:projects:read',
  'urn:neoncloud:projects:update',
  'urn:neoncloud:projects:delete',
  'urn:neoncloud:orgs:read',
] as const;

export interface Tokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
}

export interface OAuthClient {
  authorize(clientId: string, signal: AbortSignal): Promise<Tokens>;
  refresh(clientId: string, refreshToken: string): Promise<Tokens>;
  revoke(clientId: string, refreshToken: string): Promise<void>;
}

function normalize(tokens: oidc.TokenEndpointResponse): Tokens {
  if (!tokens.access_token || !tokens.expires_in || tokens.expires_in <= 0) {
    throw new NeonError(
      'Neon returned an invalid session. Please sign in again.',
    );
  }
  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresAt: Date.now() + tokens.expires_in * 1000,
  };
}

export class NeonOAuthClient implements OAuthClient {
  constructor(
    private readonly openBrowser: (url: string) => Promise<boolean>,
    private readonly request: oidc.CustomFetch = fetch as oidc.CustomFetch,
  ) {}

  private async configuration(
    clientId: string,
    signal?: AbortSignal,
  ): Promise<oidc.Configuration> {
    const config = await oidc.discovery(
      new URL('https://oauth2.neon.tech'),
      clientId,
      { token_endpoint_auth_method: 'none' },
      oidc.None(),
      {
        timeout: 15,
        [oidc.customFetch]: (input, init) =>
          this.request(input, {
            ...init,
            signal: signal
              ? AbortSignal.any([
                  signal,
                  ...(init?.signal ? [init.signal] : []),
                ])
              : init?.signal,
          }),
      },
    );
    config.timeout = 15;
    return config;
  }

  async authorize(clientId: string, signal: AbortSignal): Promise<Tokens> {
    const config = await this.configuration(clientId, signal);
    signal.throwIfAborted();
    const verifier = oidc.randomPKCECodeVerifier();
    const state = oidc.randomState();
    const callback = await startLoopback(state, signal);
    try {
      const url = oidc.buildAuthorizationUrl(config, {
        redirect_uri: callback.redirectUri,
        response_type: 'code',
        scope: AUTH_SCOPES.join(' '),
        state,
        code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
        code_challenge_method: 'S256',
      });
      signal.throwIfAborted();
      if (!(await this.openBrowser(url.href))) {
        throw new NeonError(
          'Could not open your browser. Check your default browser and try signing in again.',
        );
      }
      const response = await callback.response;
      signal.throwIfAborted();
      const tokens = await oidc.authorizationCodeGrant(config, response, {
        pkceCodeVerifier: verifier,
        expectedState: state,
      });
      signal.throwIfAborted();
      return normalize(tokens);
    } finally {
      callback.close();
    }
  }

  async refresh(clientId: string, refreshToken: string): Promise<Tokens> {
    try {
      return normalize(
        await oidc.refreshTokenGrant(
          await this.configuration(clientId),
          refreshToken,
        ),
      );
    } catch (error) {
      if (
        error instanceof oidc.ResponseBodyError &&
        error.error === 'invalid_grant'
      ) {
        throw new SessionExpiredError();
      }
      throw error;
    }
  }

  async revoke(clientId: string, refreshToken: string): Promise<void> {
    await oidc.tokenRevocation(
      await this.configuration(clientId),
      refreshToken,
      { token_type_hint: 'refresh_token' },
    );
  }
}
