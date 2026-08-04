import { fetchJson, fetchMutate } from './core';

/**
 * Workspace-wide defaults for per-agent settings. `null` means "no workspace
 * choice" — agents fall through to the deployment default. An agent's own
 * toggle always outranks these, so changing them never overrides a choice
 * someone already made.
 */
export interface WorkspaceDefaults {
  autofix: boolean | null;
  recording: boolean | null;
}

export function getWorkspaceDefaults(): Promise<WorkspaceDefaults> {
  return fetchJson<WorkspaceDefaults>('/workspace/defaults');
}

export function updateWorkspaceDefaults(
  patch: Partial<WorkspaceDefaults>,
): Promise<WorkspaceDefaults> {
  return fetchMutate<WorkspaceDefaults>('/workspace/defaults', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
}
