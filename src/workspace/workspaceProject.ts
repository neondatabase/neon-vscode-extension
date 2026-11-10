import * as vscode from 'vscode';
import type { ProjectListItem } from '@neon/sdk';
import type { Neon } from '../api/neonApi';

export interface ProjectLink {
  projectId: string;
  name: string;
  orgId?: string;
}

type State =
  | { source: 'manual'; project?: ProjectLink; accountId?: string }
  | {
      source: 'env';
      accountId?: string;
      project: ProjectLink;
      endpointId: string;
      envFile: string;
    };

const STATE_KEY = 'neon.workspaceProject';
const ENV_GLOB = '**/.env*';
const ENV_EXCLUDE = '**/node_modules/**';
const MAX_ENV_FILES = 50;
const LOOKUP_CONCURRENCY = 8;

export function detectFromEnvEnabled(): boolean {
  return vscode.workspace
    .getConfiguration('neon')
    .get<boolean>('workspaceProject.detectFromEnv', true);
}

export class WorkspaceProject implements vscode.Disposable {
  private readonly events = new vscode.EventEmitter<void>();
  readonly onDidChange = this.events.event;
  private readonly disposables: vscode.Disposable[] = [this.events];
  private generation = 0;
  private debounce: NodeJS.Timeout | undefined;

  constructor(
    private readonly memento: vscode.Memento,
    private readonly neon: Neon,
    private readonly accountId: () => string | undefined,
  ) {
    const watcher = vscode.workspace.createFileSystemWatcher(ENV_GLOB);
    const scheduleDetect = () => {
      clearTimeout(this.debounce);
      this.debounce = setTimeout(() => void this.detect(), 500);
    };
    this.disposables.push(
      watcher,
      watcher.onDidCreate(scheduleDetect),
      watcher.onDidChange(scheduleDetect),
      watcher.onDidDelete(scheduleDetect),
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        this.events.fire();
        scheduleDetect();
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('neon.workspaceProject.detectFromEnv'))
          void this.detect();
      }),
    );
  }

  get available(): boolean {
    return !!vscode.workspace.workspaceFolders?.length;
  }

  get project(): ProjectLink | undefined {
    return this.available ? this.state?.project : undefined;
  }

  get detectedFrom(): string | undefined {
    const state = this.state;
    return state?.source === 'env' ? state.envFile : undefined;
  }

  get detectionOverridden(): boolean {
    return this.state?.source === 'manual';
  }

  async link(project: ProjectListItem): Promise<void> {
    await this.save({ source: 'manual', project: toLink(project) });
  }

  async unlink(): Promise<void> {
    await this.save({ source: 'manual' });
  }

  async useDetection(): Promise<void> {
    await this.save(undefined);
    await this.detect();
  }

  async renamed(projectId: string, name: string): Promise<void> {
    const state = this.state;
    if (state?.project?.projectId !== projectId) return;
    await this.save({ ...state, project: { ...state.project, name } });
  }

  async deleted(projectId: string): Promise<boolean> {
    if (this.state?.project?.projectId !== projectId) return false;
    await this.save(undefined);
    await this.detect();
    return true;
  }

  async detect(): Promise<void> {
    const generation = ++this.generation;
    const state = this.state;
    if (state?.source === 'manual') return;
    if (!detectFromEnvEnabled() || !this.available) {
      if (state) await this.save(undefined);
      return;
    }
    if (!this.accountId()) return;
    try {
      const found = await findEndpoints();
      if (generation !== this.generation) return;
      const preferred = found[0];
      if (state && preferred?.endpointId === state.endpointId) {
        if (preferred.envFile !== state.envFile)
          await this.save({ ...state, envFile: preferred.envFile });
        return;
      }
      const match = found.length ? await this.resolve(found) : undefined;
      if (generation !== this.generation || this.state?.source === 'manual')
        return;
      if (match)
        await this.save({
          source: 'env',
          project: toLink(match.project),
          endpointId: match.endpointId,
          envFile: match.envFile,
        });
      else if (state) await this.save(undefined);
    } catch {}
  }

  private async resolve(
    found: FoundEndpoint[],
  ): Promise<(FoundEndpoint & { project: ProjectListItem }) | undefined> {
    const orgs = await this.neon.user.organizations();
    const projects = (
      await Promise.all(
        orgs.map((org) => this.neon.projects.list({ org_id: org.id }).all()),
      )
    ).flat();
    const owners = new Map<string, ProjectListItem>();
    const checked = new Set<string>();
    let failed = false;
    for (const endpoint of found) {
      const inRegion = (p: ProjectListItem) =>
        Number(p.region_id === endpoint.regionId);
      const candidates = projects
        .filter((p) => !checked.has(p.id))
        .sort((a, b) => inRegion(b) - inRegion(a));
      for (let i = 0; !owners.has(endpoint.endpointId);) {
        const batch = candidates.slice(i, (i += LOOKUP_CONCURRENCY));
        if (!batch.length) break;
        await Promise.all(
          batch.map(async (project) => {
            checked.add(project.id);
            const endpoints = await this.neon.postgres.endpoints
              .list({ projectId: project.id })
              .catch(() => {
                failed = true;
                return [];
              });
            for (const e of endpoints) owners.set(e.id, project);
          }),
        );
      }
      const project = owners.get(endpoint.endpointId);
      if (project) return { ...endpoint, project };
    }
    if (failed) throw new Error('Some projects could not be checked');
    return undefined;
  }

  private get state(): State | undefined {
    const state = this.memento.get<State>(STATE_KEY);
    const accountId = this.accountId();
    if (state?.accountId && accountId && state.accountId !== accountId)
      return undefined;
    return state;
  }

  private async save(state: State | undefined): Promise<void> {
    this.generation++;
    await this.memento.update(
      STATE_KEY,
      state && { ...state, accountId: this.accountId() },
    );
    this.events.fire();
  }

  dispose(): void {
    clearTimeout(this.debounce);
    for (const disposable of this.disposables) disposable.dispose();
  }
}

function toLink(project: ProjectListItem): ProjectLink {
  return { projectId: project.id, name: project.name, orgId: project.org_id };
}

interface FoundEndpoint {
  endpointId: string;
  regionId?: string;
  envFile: string;
}

async function findEndpoints(): Promise<FoundEndpoint[]> {
  const uris = await vscode.workspace.findFiles(
    ENV_GLOB,
    ENV_EXCLUDE,
    MAX_ENV_FILES,
  );
  const files = uris
    .map((uri) => ({ uri, path: vscode.workspace.asRelativePath(uri) }))
    .sort((a, b) => envFileRank(a.path) - envFileRank(b.path));
  const found: FoundEndpoint[] = [];
  for (const { uri, path } of files) {
    let text: string;
    try {
      text = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
    } catch {
      continue;
    }
    for (const endpoint of parseNeonHosts(text))
      if (!found.some((f) => f.endpointId === endpoint.endpointId))
        found.push({ ...endpoint, envFile: path });
  }
  return found;
}

function envFileRank(path: string): number {
  const segments = path.split('/');
  const name = segments.at(-1) ?? '';
  const order = [
    '.env.local',
    '.env',
    '.env.development.local',
    '.env.development',
  ];
  const known = order.indexOf(name);
  const template = /\.(example|sample|template|dist)$/.test(name);
  const rank = known >= 0 ? known : 10;
  return (template ? 1_000_000 : 0) + (segments.length - 1) * 100 + rank;
}

export function parseNeonHosts(
  text: string,
): { endpointId: string; regionId?: string }[] {
  const found: { endpointId: string; regionId?: string }[] = [];
  const host =
    /\b(ep-[a-z0-9-]+?)(?:-pooler)?\.((?:[a-z0-9-]+\.)*)neon\.tech(?![\w-]|\.[\w-])/gi;
  for (const line of text.split(/\r?\n/)) {
    if (line.trimStart().startsWith('#')) continue;
    const value = line.replace(/\s#.*$/, '');
    for (const [, endpointId = '', domain = ''] of value.matchAll(host)) {
      const labels = domain.split('.').filter(Boolean);
      const provider = labels.at(-1);
      const region = labels.at(-2);
      found.push({
        endpointId: endpointId.toLowerCase(),
        regionId:
          provider && region
            ? `${provider}-${region}`.toLowerCase()
            : undefined,
      });
    }
  }
  return found;
}
