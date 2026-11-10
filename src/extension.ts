import * as vscode from 'vscode';
import { createApi, profileApi } from './api/neonApi';
import { NeonOAuthClient, AUTH_SCOPES } from './auth/oauthClient';
import { SessionManager } from './auth/sessionManager';
import { NeonAuthenticationProvider } from './auth/authenticationProvider';
import { ProjectsTree } from './views/projectsTree';
import { WorkspaceProjectStatus } from './views/statusBar';
import { WorkspaceProject } from './workspace/workspaceProject';
import { projectCommands } from './commands';
import {
  isCancellation,
  isSessionExpired,
  SessionExpiredError,
  userMessage,
} from './core/errors';

export async function activate(
  context: vscode.ExtensionContext,
): Promise<void> {
  const setContext = (key: string, value: unknown) =>
    vscode.commands.executeCommand('setContext', key, value);
  await setContext('neon.ready', false);
  let restoring = true;
  let finishRestoring!: () => void;
  const restored = new Promise<void>((resolve) => (finishRestoring = resolve));
  const sessions = new SessionManager(
    context.secrets,
    new NeonOAuthClient(async (url) =>
      vscode.env.openExternal(vscode.Uri.parse(url)),
    ),
    profileApi,
    () =>
      vscode.workspace
        .getConfiguration('neon')
        .get<string>('oauth.clientId', 'neonctl'),
  );
  const neon = createApi((forceRefresh) => sessions.accessToken(forceRefresh));
  const provider = new NeonAuthenticationProvider(sessions);
  const signedIn = () => !!sessions.account;
  const workspace = new WorkspaceProject(
    context.workspaceState,
    neon,
    () => sessions.account?.profile.id,
  );
  const tree = new ProjectsTree(
    neon,
    signedIn,
    () => workspace.project,
    restored,
  );
  const view = vscode.window.createTreeView('neon.projects', {
    treeDataProvider: tree,
    showCollapseAll: true,
  });
  const status = new WorkspaceProjectStatus(workspace, signedIn);

  let pendingReveal: string | undefined;
  let revealedOrg: string | undefined;
  const revealLinked = () => {
    if (!pendingReveal || !view.visible) return;
    const project = tree.projectNode(pendingReveal);
    const org = project ? undefined : tree.orgNode(workspace.project?.orgId);
    const node = project ?? org;
    if (!node || (org && revealedOrg === pendingReveal)) return;
    if (org) revealedOrg = pendingReveal;
    else pendingReveal = revealedOrg = undefined;
    void Promise.resolve(
      view.reveal(node, { expand: true, select: false, focus: false }),
    ).catch(() => undefined);
  };
  let linkedId = workspace.project?.projectId;
  const onLinkChanged = async () => {
    const projectId = workspace.project?.projectId;
    await setContext('neon.workspaceProjectLinked', !!projectId);
    if (projectId === linkedId) return;
    linkedId = projectId;
    pendingReveal = projectId;
    revealedOrg = undefined;
    tree.refresh();
  };
  let accountId: string | undefined;
  let expiryPrompt: PromiseLike<unknown> | undefined;
  const promptExpired = () => {
    expiryPrompt ??= vscode.window
      .showWarningMessage(new SessionExpiredError().message, 'Sign In')
      .then((action) => {
        expiryPrompt = undefined;
        if (action) return vscode.commands.executeCommand('neon.signIn');
      });
  };
  const onAccountChanged = async () => {
    const account = sessions.account;
    view.description = account?.profile.email || undefined;
    status.update();
    const changed = account?.id !== accountId;
    accountId = account?.id;
    await setContext('neon.signedIn', !!account);
    if (changed) {
      linkedId = pendingReveal = workspace.project?.projectId;
      revealedOrg = undefined;
      void setContext('neon.workspaceProjectLinked', !!linkedId);
      if (!restoring) tree.refresh();
      void workspace.detect();
    }
  };
  context.subscriptions.push(
    sessions,
    provider,
    workspace,
    tree,
    view,
    status,
    workspace.onDidChange(() => void onLinkChanged()),
    view.onDidChangeVisibility(revealLinked),
    tree.onDidLoadProjects(revealLinked),
    sessions.subscribe((expired) => {
      if (expired) promptExpired();
      void onAccountChanged();
    }),
    vscode.authentication.registerAuthenticationProvider(
      'neon',
      'Neon',
      provider,
      { supportsMultipleAccounts: false },
    ),
  );

  const command = (
    id: string,
    action: (...args: never[]) => PromiseLike<unknown> | unknown,
  ) => {
    context.subscriptions.push(
      vscode.commands.registerCommand(id, async (...args: never[]) => {
        try {
          return await action(...args);
        } catch (error) {
          if (isSessionExpired(error)) promptExpired();
          else if (!isCancellation(error))
            void vscode.window.showErrorMessage(userMessage(error));
          return undefined;
        }
      }),
    );
  };

  command('neon.signIn', async () => {
    if (restoring) return;
    await vscode.authentication.getSession('neon', [...AUTH_SCOPES], {
      createIfNone: true,
    });
    await vscode.commands.executeCommand('neon.projects.focus');
  });
  command('neon.signOut', () => sessions.signOut());
  for (const [id, action] of Object.entries(
    projectCommands(neon, tree, workspace),
  ))
    command(id, action);

  try {
    await sessions.restore();
  } catch (error) {
    void vscode.window.showErrorMessage(userMessage(error));
  } finally {
    finishRestoring();
  }
  await onAccountChanged();
  await onLinkChanged();
  restoring = false;
  await setContext('neon.ready', true);
  if (sessions.account) void sessions.refreshProfile().catch(() => undefined);
}
