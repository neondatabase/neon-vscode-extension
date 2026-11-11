import * as vscode from 'vscode';
import type {
  Branch,
  Database,
  Organization,
  ProjectListItem,
} from '@neon/sdk';
import type { Neon } from './api/neonApi';
import { NeonError } from './core/errors';
import {
  detectFromEnvEnabled,
  type WorkspaceProject,
} from './workspace/workspaceProject';
import {
  byName,
  region,
  type BranchNode,
  type DatabaseNode,
  type EndpointNode,
  type Node,
  type OrgNode,
  type ProjectNode,
  type ProjectsTree,
} from './views/projectsTree';

const CONSOLE_URL = 'https://console.neon.tech/app/projects';

export function projectCommands(
  neon: Neon,
  tree: ProjectsTree,
  workspace: WorkspaceProject,
) {
  const pickOrg = async (): Promise<Organization | undefined> => {
    const orgs = await neon.user.organizations();
    if (!orgs.length)
      throw new NeonError(
        'Your Neon account has no organizations. Create one in Neon Console first.',
      );
    if (orgs.length === 1) return orgs[0];
    return (
      await vscode.window.showQuickPick(
        orgs.map((org) => ({ label: org.name, org })),
        { title: 'Select an organization' },
      )
    )?.org;
  };

  type ProjectItem = vscode.QuickPickItem & { project?: ProjectListItem };

  const projectItems = async (): Promise<ProjectItem[]> => {
    const linked = workspace.project?.projectId;
    const orgs = await neon.user.organizations();
    const groups = await Promise.all(
      orgs.map(async (org) => ({
        org,
        projects: byName(
          await neon.projects.list({ org_id: org.id }).all(),
          (p) => p.name,
        ),
      })),
    );
    const linkedProject = groups
      .flatMap((g) => g.projects)
      .find((p) => p.id === linked);
    const item = (project: ProjectListItem): ProjectItem => ({
      label: project.name,
      description: region(project.region_id),
      project,
    });
    return [
      ...(linkedProject
        ? [
            {
              label: 'Workspace project',
              kind: vscode.QuickPickItemKind.Separator,
            },
            { ...item(linkedProject), iconPath: new vscode.ThemeIcon('pin') },
          ]
        : []),
      ...groups.flatMap(({ org, projects }) => {
        const rest = projects.filter((p) => p.id !== linked);
        return [
          ...((orgs.length > 1 || linkedProject) && rest.length
            ? [{ label: org.name, kind: vscode.QuickPickItemKind.Separator }]
            : []),
          ...rest.map(item),
        ];
      }),
    ];
  };

  const pickProject = async (): Promise<ProjectListItem | undefined> =>
    (
      await vscode.window.showQuickPick(projectItems(), {
        title: 'Select a project',
        matchOnDescription: true,
      })
    )?.project;

  const pickBranch = async (
    project: BranchNode['project'],
  ): Promise<Branch | undefined> => {
    const branches = await neon.branches.list({ projectId: project.id }).all();
    if (branches.length === 1) return branches[0];
    return (
      await vscode.window.showQuickPick(
        branches
          .sort(
            (a, b) =>
              Number(b.default) - Number(a.default) ||
              a.name.localeCompare(b.name),
          )
          .map((branch) => ({
            label: branch.name,
            description: branch.default ? 'default' : undefined,
            branch,
          })),
        { title: `Select a branch in ${project.name}` },
      )
    )?.branch;
  };

  const copyConnectionString = async (
    node?: BranchNode | DatabaseNode,
  ): Promise<void> => {
    const project = node?.project ?? (await pickProject());
    if (!project) return;
    const branch = node?.branch ?? (await pickBranch(project));
    if (!branch) return;
    let database: Database | undefined;
    if (node?.kind === 'database') {
      database = node.database;
    } else {
      const databases = await neon.postgres.databases.list({
        projectId: project.id,
        branchId: branch.id,
      });
      if (!databases.length)
        throw new NeonError(`${branch.name} has no databases.`);
      database =
        databases.length === 1
          ? databases[0]
          : (
              await vscode.window.showQuickPick(
                byName(databases, (d) => d.name).map((d) => ({
                  label: d.name,
                  description: d.owner_name,
                  database: d,
                })),
                { title: `Select a database on ${branch.name}` },
              )
            )?.database;
      if (!database) return;
    }
    const pooled = vscode.workspace
      .getConfiguration('neon')
      .get<boolean>('connectionString.pooled', true);
    const uri = await neon.postgres.connectionString({
      projectId: project.id,
      branchId: branch.id,
      databaseName: database.name,
      roleName: database.owner_name,
      pooled,
    });
    await vscode.env.clipboard.writeText(uri);
    void vscode.window.showInformationMessage(
      `Copied the ${pooled ? 'pooled ' : ''}connection string for ${database.name} on ${branch.name}.`,
    );
  };

  const offerConnectionString = async (
    message: string,
    project: BranchNode['project'],
    branch: Branch,
  ) => {
    const action = await vscode.window.showInformationMessage(
      message,
      'Copy Connection String',
    );
    if (action)
      await copyConnectionString({
        kind: 'branch',
        project,
        branch,
        endpoints: [],
      });
  };

  return {
    'neon.refresh': (node?: Node) => tree.refresh(node, !node),

    'neon.createProject': async (node?: OrgNode) => {
      const org = node?.org ?? (await pickOrg());
      if (!org) return;
      const name = await vscode.window.showInputBox({
        title: 'Create Neon project',
        prompt: `Project name in ${org.name}`,
        placeHolder: 'Leave empty for a generated name',
      });
      if (name === undefined) return;
      const regions = neon.regions.list().then((list) =>
        list
          .sort((a, b) => Number(b.default) - Number(a.default))
          .map((r) => ({
            label: r.name,
            description: r.default ? `${r.region_id} · default` : r.region_id,
            regionId: r.region_id,
          })),
      );
      const picked = await vscode.window.showQuickPick(regions, {
        title: 'Select a region',
        placeHolder: 'Pick the region closest to your app',
        matchOnDescription: true,
      });
      if (!picked) return;
      const project = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Creating Neon project…',
        },
        () =>
          neon.projects.create({
            name: name.trim() || undefined,
            region_id: picked.regionId,
            org_id: org.id,
          }),
      );
      tree.refresh(node);
      const branch = await neon.branches.getDefault({ projectId: project.id });
      await offerConnectionString(
        `Created project ${project.name}.`,
        project,
        branch,
      );
    },

    'neon.renameProject': async ({ project }: ProjectNode) => {
      const name = await vscode.window.showInputBox({
        title: 'Rename project',
        value: project.name,
        validateInput: (value) =>
          value.trim() ? undefined : 'Enter a project name.',
      });
      if (!name?.trim() || name.trim() === project.name) return;
      await neon.projects.update({ projectId: project.id, name: name.trim() });
      await workspace.renamed(project.id, name.trim());
      tree.refresh();
    },

    'neon.deleteProject': async ({ project }: ProjectNode) => {
      const confirmed = await vscode.window.showWarningMessage(
        `Delete project “${project.name}”?`,
        {
          modal: true,
          detail:
            'All branches, databases, and computes in this project will be deleted.',
        },
        'Delete Project',
      );
      if (!confirmed) return;
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Deleting ${project.name}…`,
        },
        () => neon.projects.delete({ projectId: project.id }),
      );
      if (!(await workspace.deleted(project.id))) tree.refresh();
    },

    'neon.createBranch': async (node?: ProjectNode | BranchNode) => {
      const project = node?.project ?? (await pickProject());
      if (!project) return;
      const parent = node?.kind === 'branch' ? node.branch : undefined;
      const name = await vscode.window.showInputBox({
        title: `Create branch in ${project.name}`,
        prompt: parent
          ? `Branch from ${parent.name}`
          : 'Branch from the default branch',
        placeHolder: 'Leave empty for a generated name',
      });
      if (name === undefined) return;
      const branch = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Creating branch…',
        },
        () =>
          neon.branches.create({
            projectId: project.id,
            name: name.trim() || undefined,
            parent_id: parent?.id,
          }),
      );
      tree.refreshProject(project.id);
      await offerConnectionString(
        `Created branch ${branch.name}.`,
        project,
        branch,
      );
    },

    'neon.renameBranch': async ({ project, branch }: BranchNode) => {
      const name = await vscode.window.showInputBox({
        title: 'Rename branch',
        value: branch.name,
        validateInput: (value) =>
          value.trim() ? undefined : 'Enter a branch name.',
      });
      if (!name?.trim() || name.trim() === branch.name) return;
      await neon.branches.update({
        projectId: project.id,
        branchId: branch.id,
        name: name.trim(),
      });
      tree.refreshProject(project.id);
    },

    'neon.setDefaultBranch': async ({ project, branch }: BranchNode) => {
      await neon.branches.setDefault({
        projectId: project.id,
        branchId: branch.id,
      });
      tree.refreshProject(project.id);
    },

    'neon.deleteBranch': async (node: BranchNode) => {
      const { project, branch } = node;
      const confirmed = await vscode.window.showWarningMessage(
        `Delete branch “${branch.name}”?`,
        {
          modal: true,
          detail: `Its computes and data will be deleted from ${project.name}.`,
        },
        'Delete Branch',
      );
      if (!confirmed) return;
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Deleting ${branch.name}…`,
        },
        () =>
          neon.branches.delete({ projectId: project.id, branchId: branch.id }),
      );
      tree.remove(node);
    },

    'neon.copyConnectionString': copyConnectionString,

    'neon.selectWorkspaceProject': async () => {
      type Item = ProjectItem & { action?: 'unlink' | 'detect' };
      const linked = workspace.project;
      const actions: Item[] = [
        ...(workspace.detectionOverridden && detectFromEnvEnabled()
          ? [
              {
                label: '$(search) Detect from .env files',
                description: 'Follow the connection strings in this workspace',
                action: 'detect' as const,
              },
            ]
          : []),
        ...(linked
          ? [
              {
                label: '$(close) Unlink workspace',
                description: linked.name,
                action: 'unlink' as const,
              },
            ]
          : []),
      ];
      const picked = await vscode.window.showQuickPick<Item>(
        projectItems().then((items) => [...actions, ...items]),
        {
          title: 'Select the workspace project',
          placeHolder: 'The project this workspace works with',
          matchOnDescription: true,
        },
      );
      if (picked?.action === 'unlink') await workspace.unlink();
      else if (picked?.action === 'detect') {
        await workspace.useDetection();
        if (!workspace.project)
          void vscode.window.showInformationMessage(
            'No connection string in this workspace’s .env files points at one of your Neon projects.',
          );
      } else if (picked?.project) await workspace.link(picked.project);
    },

    'neon.setWorkspaceProject': ({ project }: ProjectNode) =>
      workspace.link(project),

    'neon.unlinkWorkspaceProject': () => workspace.unlink(),

    'neon.startCompute': (node: EndpointNode) =>
      tree.transition(node, 'starting', () =>
        vscode.window.withProgress(
          { location: { viewId: 'neon.projects' } },
          () =>
            neon.postgres.endpoints.start(
              { projectId: node.project.id, endpointId: node.endpoint.id },
              { waitForReadiness: true },
            ),
        ),
      ),

    'neon.suspendCompute': (node: EndpointNode) =>
      tree.transition(node, 'suspending', () =>
        vscode.window.withProgress(
          { location: { viewId: 'neon.projects' } },
          () =>
            neon.postgres.endpoints.suspend(
              { projectId: node.project.id, endpointId: node.endpoint.id },
              { waitForReadiness: true },
            ),
        ),
      ),

    'neon.openInConsole': async (node?: ProjectNode | BranchNode) => {
      const project = node?.project ?? (await pickProject());
      if (!project) return;
      const url =
        node?.kind === 'branch'
          ? `${CONSOLE_URL}/${project.id}/branches/${node.branch.id}`
          : `${CONSOLE_URL}/${project.id}`;
      await vscode.env.openExternal(vscode.Uri.parse(url));
    },

    'neon.copyId': async (
      node: OrgNode | ProjectNode | BranchNode | EndpointNode,
    ) => {
      const [label, id] =
        node.kind === 'org'
          ? ['organization', node.org.id]
          : node.kind === 'project'
            ? ['project', node.project.id]
            : node.kind === 'branch'
              ? ['branch', node.branch.id]
              : ['compute', node.endpoint.id];
      await vscode.env.clipboard.writeText(id);
      vscode.window.setStatusBarMessage(`$(check) Copied ${label} ID`, 3000);
    },
  } satisfies Record<string, (...args: never[]) => unknown>;
}
