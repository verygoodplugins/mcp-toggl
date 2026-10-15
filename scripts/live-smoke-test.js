#!/usr/bin/env node
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { config } from 'dotenv';
import { resolve } from 'node:path';
import { TogglAPI } from '../dist/toggl-api.js';

config({ quiet: true });

const token = (
  process.env.TOGGL_API_TOKEN ||
  process.env.TOGGL_API_KEY ||
  process.env.TOGGL_TOKEN ||
  ''
).trim();
if (!token) throw new Error('Set TOGGL_API_TOKEN before running the live smoke test.');

const client = new Client({ name: 'toggl-live-smoke-test', version: '1.0.0' });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [resolve('dist/index.js')],
  env: {
    ...process.env,
    TOGGL_API_TOKEN: token,
  },
});
const api = new TogglAPI(token);
const createdIds = [];
const smokePrefix = 'MCP live smoke test';

function parse(result) {
  const text = result.content?.find((item) => item.type === 'text')?.text || '{}';
  return JSON.parse(text);
}

async function call(name, args = {}) {
  const payload = parse(await client.callTool({ name, arguments: args }));
  if (payload.error) throw new Error(`${name}: ${payload.message}`);
  console.log(`PASS ${name}`);
  return payload;
}

await client.connect(transport);
try {
  const tools = await client.listTools();
  const required = [
    'toggl_start_timer',
    'toggl_stop_timer',
    'toggl_get_current_entry',
    'toggl_get_time_entries',
    'toggl_list_projects',
    'toggl_create_time_entry',
    'toggl_list_project_aliases',
  ];
  for (const name of required) {
    if (!tools.tools.some((tool) => tool.name === name)) throw new Error(`Missing tool: ${name}`);
  }
  console.log('PASS required tool schemas');

  await call('toggl_check_auth');
  const workspaces = await call('toggl_list_workspaces');
  const workspaceId = workspaces.workspaces[0]?.id;
  if (!workspaceId) throw new Error('No Toggl workspace available.');

  const projects = await call('toggl_list_projects', { workspace_id: workspaceId });
  const aliases = await call('toggl_list_project_aliases');
  const projectIds = new Set(projects.projects.map((project) => project.id));
  for (const [alias, projectId] of Object.entries(aliases.aliases)) {
    if (!projectIds.has(projectId)) throw new Error(`Alias ${alias} points to missing project ${projectId}`);
  }
  console.log('PASS project alias IDs');
  await call('toggl_get_time_entries', { period: 'today' });
  const current = await call('toggl_get_current_entry');

  const completed = await call('toggl_create_time_entry', {
    workspace_id: workspaceId,
    project_alias: 'admin',
    description: `${smokePrefix} - completed entry`,
    duration_seconds: 1,
  });
  createdIds.push([workspaceId, completed.entry.id]);

  if (current.running) {
    console.log('SKIP toggl_start_timer/toggl_stop_timer: a user timer is already running');
  } else {
    const started = await call('toggl_start_timer', {
      workspace_id: workspaceId,
      project_alias: 'admin',
      description: `${smokePrefix} - timer`,
    });
    createdIds.push([workspaceId, started.entry.id]);
    await call('toggl_stop_timer');
  }
} finally {
  const recent = await api.getTimeEntries();
  for (const entry of recent) {
    if (entry.description?.startsWith(smokePrefix)) {
      createdIds.push([entry.workspace_id, entry.id]);
    }
  }
  const uniqueIds = new Map(createdIds.map(([workspaceId, entryId]) => [entryId, workspaceId]));
  for (const [entryId, workspaceId] of uniqueIds) {
    try {
      await api.deleteTimeEntry(workspaceId, entryId);
      console.log(`CLEANUP deleted test entry ${entryId}`);
    } catch (error) {
      if (!String(error).includes('404')) throw error;
      console.log(`CLEANUP test entry ${entryId} was already absent`);
    }
  }
  await client.close();
}
