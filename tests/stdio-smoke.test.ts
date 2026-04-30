import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
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

  it('exposes timeline schema bounds and sanitized tool errors', async () => {
    const client = new Client({ name: 'mcp-toggl-test', version: '1.0.0' });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [entryPoint],
      env: {
        ...process.env,
        TOGGL_API_KEY: 'dummy-token',
        TOGGL_API_TOKEN: '',
        TOGGL_TOKEN: '',
      },
    });

    await client.connect(transport);

    try {
      const tools = await client.listTools();
      const timelineTool = tools.tools.find((tool) => tool.name === 'toggl_get_timeline');
      const properties = timelineTool?.inputSchema.properties as
        | Record<string, Record<string, unknown>>
        | undefined;

      expect(properties?.limit).toMatchObject({
        minimum: 1,
        maximum: 1000,
        default: 50,
      });
      expect(properties?.redact_titles).toMatchObject({
        type: 'boolean',
        default: false,
      });

      const result = await client.callTool({
        name: 'toggl_get_timeline',
        arguments: { start_date: '2026-02-30' },
      });
      const payload = JSON.parse(result.content?.[0]?.text ?? '{}') as Record<string, unknown>;
      const serialized = JSON.stringify(payload);

      expect(payload.error).toBe(true);
      expect(payload.message).toContain('Invalid calendar date');
      expect(payload).not.toHaveProperty('details');
      expect(serialized).not.toContain('/Users/');
      expect(serialized).not.toContain('dist/index.js');
      expect(serialized).not.toContain('at ');
    } finally {
      await client.close();
    }
  });
});
