import * as vscode from 'vscode';
import { AUTH_SCOPES } from './oauthClient';
import { SessionManager } from './sessionManager';
import { SignInCancelledError } from '../core/errors';

export class NeonAuthenticationProvider
  implements vscode.AuthenticationProvider, vscode.Disposable
{
  private readonly events =
    new vscode.EventEmitter<vscode.AuthenticationProviderAuthenticationSessionsChangeEvent>();
  readonly onDidChangeSessions = this.events.event;
  private previous?: vscode.AuthenticationSession;
  private readonly subscription: { dispose(): void };

  constructor(private readonly sessions: SessionManager) {
    this.subscription = sessions.subscribe(() => {
      void this.notify();
    });
  }

  private async readSession(): Promise<
    vscode.AuthenticationSession | undefined
  > {
    const account = this.sessions.account;
    if (!account) return undefined;
    const accessToken = await this.sessions.accessToken();
    if (this.sessions.account?.id !== account.id) return undefined;
    return {
      id: account.id,
      account: { id: account.profile.id, label: account.profile.name },
      accessToken,
      scopes: [...AUTH_SCOPES],
    };
  }

  private async notify(): Promise<void> {
    try {
      const current = await this.readSession();
      const previous = this.previous;
      this.previous = current;
      const same = !!current && current.id === previous?.id;
      this.events.fire({
        added: current && !same ? [current] : [],
        removed: previous && !same ? [previous] : [],
        changed: current && same ? [current] : [],
      });
    } catch {}
  }

  async getSessions(
    scopes?: readonly string[],
  ): Promise<vscode.AuthenticationSession[]> {
    if (
      scopes?.some(
        (scope) => !AUTH_SCOPES.includes(scope as (typeof AUTH_SCOPES)[number]),
      )
    )
      return [];
    const session = await this.readSession();
    if (session) this.previous = session;
    return session ? [session] : [];
  }

  async createSession(
    scopes: readonly string[],
  ): Promise<vscode.AuthenticationSession> {
    if (
      scopes.some(
        (scope) => !AUTH_SCOPES.includes(scope as (typeof AUTH_SCOPES)[number]),
      )
    ) {
      throw new Error(
        'The Neon extension does not support the requested scopes.',
      );
    }
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Signing in to Neon in your browser…',
        cancellable: true,
      },
      async (_, cancellation) => {
        const abort = new AbortController();
        const subscription = cancellation.onCancellationRequested(() =>
          abort.abort(),
        );
        try {
          if (cancellation.isCancellationRequested) abort.abort();
          await this.sessions.signIn(abort.signal);
        } finally {
          subscription.dispose();
        }
      },
    );
    const session = await this.readSession();
    if (!session) throw new SignInCancelledError();
    return session;
  }

  async removeSession(id: string): Promise<void> {
    if (this.sessions.account?.id === id) await this.sessions.signOut();
  }

  dispose(): void {
    this.subscription.dispose();
    this.events.dispose();
  }
}
