import { readFileSync } from 'node:fs';

export type ProjectAliases = Record<string, number>;

export function loadProjectAliases(filePath: string): ProjectAliases {
  const raw = JSON.parse(readFileSync(filePath, 'utf8')) as unknown;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`Project alias config must be a JSON object: ${filePath}`);
  }

  const aliases: ProjectAliases = {};
  for (const [alias, projectId] of Object.entries(raw)) {
    const normalizedAlias = alias.trim().toLowerCase();
    if (!normalizedAlias || !Number.isInteger(projectId) || (projectId as number) <= 0) {
      throw new Error(`Invalid project alias mapping "${alias}" in ${filePath}`);
    }
    aliases[normalizedAlias] = projectId as number;
  }
  return aliases;
}

export function resolveProjectId(
  aliases: ProjectAliases,
  projectId?: number,
  projectAlias?: string
): number | undefined {
  if (projectId !== undefined && projectAlias) {
    throw new Error('Provide either project_id or project_alias, not both.');
  }
  if (!projectAlias) return projectId;

  const normalizedAlias = projectAlias.trim().toLowerCase();
  const resolved = aliases[normalizedAlias];
  if (!resolved) {
    const available = Object.keys(aliases).sort().join(', ');
    throw new Error(
      `Unknown project alias "${projectAlias}". Available aliases: ${available || 'none'}`
    );
  }
  return resolved;
}
