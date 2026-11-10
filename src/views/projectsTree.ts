import * as vscode from 'vscode';
import type {
  Branch,
  Database,
  Endpoint,
  Organization,
  ProjectListItem,
  Role,
} from '@neon/sdk';
import type { Neon } from '../api/neonApi';
import { isCancellation, userMessage } from '../core/errors';
import type { ProjectLink } from '../workspace/workspaceProject';

export type OrgNode = { kind: 'org'; org: Organization };
export type ProjectNode = { kind: 'project'; project: ProjectListItem };
type ProjectRef = Pick<ProjectListItem, 'id' | 'name'>;
export type BranchNode = {
  kind: 'branch';
  project: ProjectRef;
  branch: Branch;
  endpoints: Endpoint[];
};
export type EndpointNode = {
  kind: 'endpoint';
  project: ProjectRef;
  endpoint: Endpoint;
};
export type DatabaseNode = {
  kind: 'database';
  project: ProjectRef;
  branch: Branch;
  database: Database;
};
type RoleNode = { kind: 'role'; branch: Branch; role: Role };
type GroupNode = {
  kind: 'group';
  id: string;
  label: string;
  icon: string;
  children: Node[];
};
type MessageNode = {
  kind: 'message';
  id: string;
  label: string;
  icon: vscode.ThemeIcon;
  command?: vscode.Command;
};

export type Node =
  | OrgNode
  | ProjectNode
  | BranchNode
  | EndpointNode
  | DatabaseNode
  | RoleNode
  | GroupNode
  | MessageNode;

export class ProjectsTree
  implements vscode.TreeDataProvider<Node>, vscode.Disposable
{
  private readonly events = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.events.event;
  private readonly loaded = new vscode.EventEmitter<void>();
  readonly onDidLoadProjects = this.loaded.event;
  private readonly projects = new Map<string, ProjectNode>();
  private readonly parents = new Map<string, OrgNode | undefined>();
  private readonly orgs = new Map<string, OrgNode>();
  private readonly transitions = new Map<string, ComputeStatus>();

  constructor(
    private readonly neon: Neon,
    private readonly signedIn: () => boolean,
    private readonly linked: () => ProjectLink | undefined,
    private readonly restored: PromiseLike<void>,
  ) {}

  refresh(node?: Node): void {
    this.events.fire(node);
  }

  refreshProject(projectId: string): void {
    this.refresh(this.projects.get(projectId));
  }

  projectNode(projectId: string): ProjectNode | undefined {
    return this.projects.get(projectId);
  }

  orgNode(orgId: string | undefined): OrgNode | undefined {
    return orgId ? this.orgs.get(orgId) : undefined;
  }

  async transition(
    node: EndpointNode,
    to: 'starting' | 'suspending',
    run: () => PromiseLike<unknown>,
  ): Promise<void> {
    const id = node.endpoint.id;
    if (this.transitions.has(id)) return;
    this.transitions.set(id, to);
    this.refresh(node);
    try {
      await run();
    } finally {
      this.transitions.delete(id);
      this.refreshProject(node.project.id);
    }
  }

  getParent(node: Node): Node | undefined {
    return node.kind === 'project'
      ? this.parents.get(node.project.id)
      : undefined;
  }

  async getChildren(node?: Node): Promise<Node[]> {
    await this.restored;
    if (!this.signedIn()) return [];
    try {
      return await this.load(node);
    } catch (error) {
      if (isCancellation(error) || !this.signedIn()) return [];
      return [
        {
          kind: 'message',
          id: `${node ? key(node) : 'root'}/error`,
          label: userMessage(error),
          icon: new vscode.ThemeIcon(
            'error',
            new vscode.ThemeColor('errorForeground'),
          ),
          command: {
            title: 'Retry',
            command: 'neon.refresh',
            arguments: [node],
          },
        },
      ];
    }
  }

  private async load(node?: Node): Promise<Node[]> {
    if (!node) {
      const orgs = await this.neon.user.organizations();
      this.orgs.clear();
      if (orgs.length > 1) {
        queueMicrotask(() => this.loaded.fire());
        return byName(orgs, (org) => org.name).map((org) => {
          const node: OrgNode = { kind: 'org', org };
          this.orgs.set(org.id, node);
          return node;
        });
      }
      const projects = orgs[0]
        ? await this.loadProjects(orgs[0], undefined)
        : [];
      return projects.length ? projects : [createProjectNode()];
    }
    switch (node.kind) {
      case 'org': {
        const projects = await this.loadProjects(node.org, node);
        return projects.length ? projects : [createProjectNode(node)];
      }
      case 'project': {
        const projectId = node.project.id;
        const [branches, endpoints] = await Promise.all([
          this.neon.branches.list({ projectId }).all(),
          this.neon.postgres.endpoints.list({ projectId }),
        ]);
        return branches
          .sort(
            (a, b) =>
              Number(b.default) - Number(a.default) ||
              a.name.localeCompare(b.name),
          )
          .map((branch) => ({
            kind: 'branch',
            project: node.project,
            branch,
            endpoints: endpoints.filter((e) => e.branch_id === branch.id),
          }));
      }
      case 'branch': {
        const params = { projectId: node.project.id, branchId: node.branch.id };
        const [databases, roles] = await Promise.all([
          this.neon.postgres.databases.list(params),
          this.neon.postgres.roles.list(params),
        ]);
        const { project, branch } = node;
        return [
          ...node.endpoints
            .sort((a, b) => primaryFirst(a) - primaryFirst(b))
            .map((endpoint): Node => ({ kind: 'endpoint', project, endpoint })),
          {
            kind: 'group',
            id: `${key(node)}/databases`,
            label: 'Databases',
            icon: 'database',
            children: byName(databases, (d) => d.name).map((database) => ({
              kind: 'database',
              project,
              branch,
              database,
            })),
          },
          {
            kind: 'group',
            id: `${key(node)}/roles`,
            label: 'Roles',
            icon: 'account',
            children: byName(roles, (r) => r.name).map((role) => ({
              kind: 'role',
              branch,
              role,
            })),
          },
        ];
      }
      case 'group':
        return node.children;
      default:
        return [];
    }
  }

  private async loadProjects(
    org: Organization,
    parent: OrgNode | undefined,
  ): Promise<Node[]> {
    const projects = await this.neon.projects.list({ org_id: org.id }).all();
    const linked = this.linked()?.projectId;
    const nodes = byName(projects, (p) => p.name)
      .sort((a, b) => Number(b.id === linked) - Number(a.id === linked))
      .map((project) => {
        const node: ProjectNode = this.projects.get(project.id) ?? {
          kind: 'project',
          project,
        };
        node.project = project;
        this.projects.set(project.id, node);
        this.parents.set(project.id, parent);
        return node;
      });
    queueMicrotask(() => this.loaded.fire());
    return nodes;
  }

  getTreeItem(node: Node): vscode.TreeItem {
    const linked = this.linked();
    const expanded =
      (node.kind === 'project' && node.project.id === linked?.projectId) ||
      (node.kind === 'org' && node.org.id === linked?.orgId);
    const item = new vscode.TreeItem(
      label(node),
      !collapsible(node)
        ? vscode.TreeItemCollapsibleState.None
        : expanded
          ? vscode.TreeItemCollapsibleState.Expanded
          : vscode.TreeItemCollapsibleState.Collapsed,
    );
    item.id = key(node);
    switch (node.kind) {
      case 'org':
        item.iconPath = new vscode.ThemeIcon('organization');
        item.contextValue = 'org';
        item.tooltip = tooltip(node.org.name, [['ID', node.org.id]]);
        break;
      case 'project': {
        const { project } = node;
        const isLinked = project.id === linked?.projectId;
        item.iconPath = new vscode.ThemeIcon(
          'project',
          isLinked ? new vscode.ThemeColor('charts.blue') : undefined,
        );
        item.description = [
          isLinked && 'workspace',
          region(project.region_id),
          `Postgres ${project.pg_version}`,
        ]
          .filter(Boolean)
          .join(' · ');
        item.contextValue = isLinked ? 'project.linked' : 'project';
        item.tooltip = tooltip(project.name, [
          ['ID', project.id],
          ['Region', project.region_id],
          ['Postgres', String(project.pg_version)],
          ['Organization', project.org_name],
          ['Created', date(project.created_at)],
        ]);
        break;
      }
      case 'branch': {
        const { branch } = node;
        const compute = node.endpoints.find((e) => e.type === 'read_write');
        const busy =
          branch.current_state === 'init' ||
          branch.current_state === 'resetting' ||
          !!branch.pending_state;
        item.iconPath = busy
          ? new vscode.ThemeIcon('loading~spin')
          : new vscode.ThemeIcon(
              'git-branch',
              compute?.current_state === 'active'
                ? new vscode.ThemeColor('charts.green')
                : undefined,
            );
        item.description = [
          branch.default && 'default',
          branch.protected && 'protected',
          branch.current_state !== 'ready' && branch.current_state,
        ]
          .filter(Boolean)
          .join(' · ');
        item.contextValue = branch.default ? 'branch.default' : 'branch';
        item.tooltip = tooltip(branch.name, [
          ['ID', branch.id],
          ['Compute', compute ? COMPUTE_LABEL[computeStatus(compute)] : 'None'],
          ['Data size', bytes(branch.logical_size)],
          ['Created', date(branch.created_at)],
          ['Created by', branch.created_by?.name],
          ['Expires', date(branch.expires_at)],
        ]);
        break;
      }
      case 'endpoint': {
        const { endpoint } = node;
        const status =
          this.transitions.get(endpoint.id) ?? computeStatus(endpoint);
        item.iconPath = new vscode.ThemeIcon(
          COMPUTE_ICON[status],
          status === 'active'
            ? new vscode.ThemeColor('charts.green')
            : undefined,
        );
        item.description = `${COMPUTE_LABEL[status]} · ${endpoint.autoscaling_limit_min_cu}–${endpoint.autoscaling_limit_max_cu} CU`;
        item.contextValue = `endpoint.${status}`;
        item.tooltip = tooltip(label(node), [
          ['ID', endpoint.id],
          ['Host', endpoint.host],
          ['State', COMPUTE_LABEL[status]],
          [
            'Autoscaling',
            `${endpoint.autoscaling_limit_min_cu}–${endpoint.autoscaling_limit_max_cu} CU`,
          ],
          ['Last active', date(endpoint.last_active)],
        ]);
        break;
      }
      case 'group':
        item.iconPath = new vscode.ThemeIcon(node.icon);
        item.description = String(node.children.length);
        break;
      case 'database':
        item.iconPath = new vscode.ThemeIcon('database');
        item.description = node.database.owner_name;
        item.contextValue = 'database';
        item.tooltip = tooltip(node.database.name, [
          ['Owner', node.database.owner_name],
          ['Created', date(node.database.created_at)],
        ]);
        break;
      case 'role':
        item.iconPath = new vscode.ThemeIcon('person');
        item.description = node.role.protected ? 'protected' : undefined;
        item.contextValue = 'role';
        break;
      case 'message':
        item.iconPath = node.icon;
        item.command = node.command;
        item.tooltip = node.label;
        break;
    }
    return item;
  }

  dispose(): void {
    this.events.dispose();
    this.loaded.dispose();
  }
}

function createProjectNode(org?: OrgNode): MessageNode {
  return {
    kind: 'message',
    id: `${org ? key(org) : 'root'}/empty`,
    label: org ? 'Create a project' : 'No projects yet. Create one',
    icon: new vscode.ThemeIcon('add'),
    command: {
      title: 'Create Project',
      command: 'neon.createProject',
      arguments: [org],
    },
  };
}

function key(node: Node): string {
  switch (node.kind) {
    case 'org':
      return `org/${node.org.id}`;
    case 'project':
      return `project/${node.project.id}`;
    case 'branch':
      return `branch/${node.branch.id}`;
    case 'endpoint':
      return `endpoint/${node.endpoint.id}`;
    case 'database':
      return `branch/${node.branch.id}/database/${node.database.name}`;
    case 'role':
      return `branch/${node.branch.id}/role/${node.role.name}`;
    case 'group':
    case 'message':
      return node.id;
  }
}

function label(node: Node): string {
  switch (node.kind) {
    case 'org':
      return node.org.name;
    case 'project':
      return node.project.name;
    case 'branch':
      return node.branch.name;
    case 'endpoint':
      return node.endpoint.type === 'read_write'
        ? 'Primary compute'
        : 'Read replica';
    case 'database':
      return node.database.name;
    case 'role':
      return node.role.name;
    case 'group':
    case 'message':
      return node.label;
  }
}

function collapsible(node: Node): boolean {
  return (
    node.kind === 'org' ||
    node.kind === 'project' ||
    node.kind === 'branch' ||
    (node.kind === 'group' && node.children.length > 0)
  );
}

export function byName<T>(items: T[], name: (item: T) => string): T[] {
  return items.sort((a, b) => name(a).localeCompare(name(b)));
}

function primaryFirst(endpoint: Endpoint): number {
  return endpoint.type === 'read_write' ? 0 : 1;
}

type ComputeStatus = 'starting' | 'suspending' | 'active' | 'idle';

const COMPUTE_LABEL: Record<ComputeStatus, string> = {
  starting: 'Starting',
  suspending: 'Suspending',
  active: 'Active',
  idle: 'Suspended',
};

const COMPUTE_ICON: Record<ComputeStatus, string> = {
  starting: 'loading~spin',
  suspending: 'loading~spin',
  active: 'vm-running',
  idle: 'vm-outline',
};

function computeStatus(endpoint: Endpoint): ComputeStatus {
  if (endpoint.pending_state === 'idle') return 'suspending';
  if (endpoint.pending_state || endpoint.current_state === 'init')
    return 'starting';
  return endpoint.current_state === 'idle' ? 'idle' : 'active';
}

export function region(regionId: string): string {
  const [provider = '', ...rest] = regionId.split('-');
  const name =
    provider === 'aws' ? 'AWS' : provider === 'azure' ? 'Azure' : provider;
  return rest.length ? `${name} ${rest.join('-')}` : regionId;
}

function date(value: string | undefined): string | undefined {
  return value ? new Date(value).toLocaleString() : undefined;
}

function bytes(value: number | undefined): string | undefined {
  if (value === undefined) return undefined;
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit++;
  }
  return `${size.toFixed(unit ? 1 : 0)} ${units[unit]}`;
}

function tooltip(
  title: string,
  rows: [string, string | undefined][],
): vscode.MarkdownString {
  const markdown = new vscode.MarkdownString(`**${escape(title)}**\n\n`);
  for (const [name, value] of rows) {
    if (value) markdown.appendMarkdown(`${name}: \`${value}\`  \n`);
  }
  return markdown;
}

function escape(text: string): string {
  return text.replace(/[\\`*_{}[\]()#+\-.!|<>]/g, '\\$&');
}
