import { describe, expect, it, vi } from 'vitest';
import { resolveWorkspaceId, WorkspaceResolutionError } from '../src/workspace.js';
import type { Workspace } from '../src/types.js';

const workspace = (id: number, name: string): Workspace => ({ id, name });

describe('workspace resolution', () => {
  it('uses an explicit workspace id first', async () => {
    const getWorkspaces = vi.fn<() => Promise<Workspace[]>>();

    await expect(
      resolveWorkspaceId({
        explicitWorkspaceId: 123,
        defaultWorkspaceId: 456,
        getWorkspaces,
        action: 'testing',
      })
    ).resolves.toBe(123);
    expect(getWorkspaces).not.toHaveBeenCalled();
  });

  it('uses the configured default workspace when no explicit id is provided', async () => {
    const getWorkspaces = vi.fn<() => Promise<Workspace[]>>();

    await expect(
      resolveWorkspaceId({
        defaultWorkspaceId: 456,
        getWorkspaces,
        action: 'testing',
      })
    ).resolves.toBe(456);
    expect(getWorkspaces).not.toHaveBeenCalled();
  });

  it('auto-selects the only available workspace', async () => {
    const getWorkspaces = vi.fn(async () => [workspace(789, 'Solo')]);

    await expect(
      resolveWorkspaceId({
        getWorkspaces,
        action: 'testing',
      })
    ).resolves.toBe(789);
  });

  it('fails clearly when multiple workspaces require a choice', async () => {
    const getWorkspaces = vi.fn(async () => [workspace(1, 'First'), workspace(2, 'Second')]);

    await expect(
      resolveWorkspaceId({
        getWorkspaces,
        action: 'listing projects',
      })
    ).rejects.toMatchObject({
      code: 'WORKSPACE_REQUIRED',
      available_workspaces: [
        { id: 1, name: 'First' },
        { id: 2, name: 'Second' },
      ],
    });

    await expect(
      resolveWorkspaceId({
        getWorkspaces,
        action: 'listing projects',
      })
    ).rejects.toBeInstanceOf(WorkspaceResolutionError);
  });
});
