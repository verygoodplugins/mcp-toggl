import type { Workspace } from './types.js';

export interface WorkspaceSummary {
  id: number;
  name: string;
}

export class WorkspaceResolutionError extends Error {
  readonly code = 'WORKSPACE_REQUIRED';
  readonly tip: string;
  readonly available_workspaces: WorkspaceSummary[];

  constructor(action: string, workspaces: WorkspaceSummary[]) {
    const workspaceList = workspaces
      .map((workspace) => `${workspace.id} (${workspace.name})`)
      .join(', ');
    super(
      workspaces.length > 0
        ? `Workspace ID required for ${action}. Set TOGGL_DEFAULT_WORKSPACE_ID or provide workspace_id. Available workspaces: ${workspaceList}`
        : `Workspace ID required for ${action}, but no Toggl workspaces were returned.`
    );
    this.name = 'WorkspaceResolutionError';
    this.available_workspaces = workspaces;
    this.tip =
      'Pass workspace_id explicitly, or set TOGGL_DEFAULT_WORKSPACE_ID in your MCP server environment.';
  }
}

interface ResolveWorkspaceOptions {
  explicitWorkspaceId?: unknown;
  defaultWorkspaceId?: number;
  getWorkspaces: () => Promise<Workspace[]>;
  action: string;
}

export async function resolveWorkspaceId({
  explicitWorkspaceId,
  defaultWorkspaceId,
  getWorkspaces,
  action,
}: ResolveWorkspaceOptions): Promise<number> {
  const explicit = parseWorkspaceId(explicitWorkspaceId);
  if (explicit !== undefined) return explicit;

  if (defaultWorkspaceId !== undefined) return defaultWorkspaceId;

  const workspaces = await getWorkspaces();
  if (workspaces.length === 1) return workspaces[0]!.id;

  throw new WorkspaceResolutionError(
    action,
    workspaces.map((workspace) => ({
      id: workspace.id,
      name: workspace.name,
    }))
  );
}

export function parseWorkspaceId(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}
