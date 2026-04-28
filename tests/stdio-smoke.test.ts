import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const entryPoint = resolve('dist/index.js');

describe.skipIf(!existsSync(entryPoint))('stdio smoke checks', () => {
  it('keeps CLI metadata off stdout', async () => {
    const { stdout, stderr } = await execFileAsync(process.execPath, [entryPoint, '--version']);

    expect(stdout).toBe('');
    expect(stderr).toContain('mcp-toggl version');
  });

  it('reports missing configuration on stderr before opening stdio transport', async () => {
    let result:
      | {
          code?: number;
          stdout?: string;
          stderr?: string;
        }
      | undefined;

    try {
      await execFileAsync(process.execPath, [entryPoint], {
        env: {
          ...process.env,
          TOGGL_API_KEY: '',
          TOGGL_API_TOKEN: '',
          TOGGL_TOKEN: '',
        },
      });
    } catch (error) {
      result = error as typeof result;
    }

    expect(result?.code).toBe(1);
    expect(result?.stdout).toBe('');
    expect(result?.stderr).toContain('Missing required environment variable');
  });
});
