import { describe, expect, it } from 'vitest';
import { loadProjectAliases, resolveProjectId } from '../src/project-aliases.js';

describe('project aliases', () => {
  const aliases = { wotw: 123, gsol: 456 };

  it('loads the example alias config', () => {
    expect(loadProjectAliases('config/project-aliases.example.json')).toEqual({
      writing: 123456789,
      service: 987654321,
    });
  });

  it('resolves aliases case-insensitively', () => {
    expect(resolveProjectId(aliases, undefined, 'WOTW')).toBe(123);
  });

  it('accepts a direct project id', () => {
    expect(resolveProjectId(aliases, 789)).toBe(789);
  });

  it('rejects ambiguous and unknown project selections', () => {
    expect(() => resolveProjectId(aliases, 789, 'wotw')).toThrow('either project_id');
    expect(() => resolveProjectId(aliases, undefined, 'missing')).toThrow('Unknown project alias');
  });
});
