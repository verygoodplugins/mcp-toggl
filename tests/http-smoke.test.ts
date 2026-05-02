import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { once } from 'node:events';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { describe, expect, it } from 'vitest';

const entryPoint = resolve('dist/index.js');

async function getFreePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen) => {
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  if (typeof address !== 'object' || address === null) {
    throw new Error('Unable to allocate test port');
  }
  const port = address.port;
  server.close();
  await once(server, 'close');
  return port;
}

async function waitForHealth(url: string, child: ChildProcessWithoutNullStreams): Promise<void> {
  const started = Date.now();
  let lastError: unknown;

  while (Date.now() - started < 5_000) {
    if (child.exitCode !== null) {
      throw new Error(`HTTP server exited early with code ${child.exitCode}`);
    }

    try {
      const response = await fetch(url);
      if (response.ok) return;
      lastError = new Error(`Health returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }

    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }

  throw lastError instanceof Error ? lastError : new Error('Timed out waiting for health check');
}

describe.skipIf(!existsSync(entryPoint))('http transport smoke checks', () => {
  it('serves health and MCP tools over Streamable HTTP', async () => {
    const port = await getFreePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    const child = spawn(process.execPath, [entryPoint], {
      env: {
        ...process.env,
        TRANSPORT: 'http',
        HOST: '127.0.0.1',
        PORT: String(port),
        TOGGL_API_KEY: 'dummy-token',
        TOGGL_API_TOKEN: '',
        TOGGL_TOKEN: '',
      },
      stdio: 'pipe',
    });

    try {
      await waitForHealth(`${baseUrl}/health`, child);

      const health = (await (await fetch(`${baseUrl}/health`)).json()) as Record<string, unknown>;
      expect(health).toMatchObject({
        ok: true,
        name: 'mcp-toggl',
        transport: 'http',
      });

      const client = new Client({ name: 'mcp-toggl-http-test', version: '1.0.0' });
      const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`));
      await client.connect(transport);

      try {
        const tools = await client.listTools();
        expect(tools.tools.some((tool) => tool.name === 'toggl_get_timeline')).toBe(true);

        const result = await client.callTool({
          name: 'toggl_get_timeline',
          arguments: { start_date: '2026-02-30' },
        });
        const payload = JSON.parse(result.content?.[0]?.text ?? '{}') as Record<string, unknown>;
        const serialized = JSON.stringify(payload);

        expect(payload).toMatchObject({
          error: true,
          code: 'INVALID_ARGUMENT',
        });
        expect(payload.message).toContain('Invalid calendar date');
        expect(serialized).not.toContain('/Users/');
        expect(serialized).not.toContain('dist/index.js');
        expect(serialized).not.toContain('at ');
      } finally {
        await client.close();
      }
    } finally {
      child.kill('SIGTERM');
      await once(child, 'close');
    }
  });
});
