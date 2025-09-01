#!/usr/bin/env node
import { config } from 'dotenv';

// Load environment variables
config();

// Simple test to verify environment is set up
console.log('🧪 Testing MCP Toggl Server Configuration\n');

// Check API key
const apiKey = process.env.TOGGL_API_KEY;
if (!apiKey) {
  console.error('❌ TOGGL_API_KEY is not set in environment');
  console.log('   Please create a .env file with your Toggl API key');
  console.log('   Get your API key from: https://track.toggl.com/profile');
  process.exit(1);
}

console.log('✅ API Key found');

// Check optional settings
const defaultWorkspace = process.env.TOGGL_DEFAULT_WORKSPACE_ID;
if (defaultWorkspace) {
  console.log(`✅ Default workspace ID: ${defaultWorkspace}`);
} else {
  console.log('ℹ️  No default workspace set (optional)');
}

const cacheTTL = process.env.TOGGL_CACHE_TTL || '3600000';
console.log(`✅ Cache TTL: ${cacheTTL}ms (${parseInt(cacheTTL) / 1000 / 60} minutes)`);

const cacheSize = process.env.TOGGL_CACHE_SIZE || '1000';
console.log(`✅ Cache size: ${cacheSize} entities`);

console.log('\n🎉 Configuration looks good!');
console.log('\nTo test the MCP server, you can:');
console.log('1. Run in dev mode: npm run dev');
console.log('2. Add to your Claude Desktop or Cursor configuration');
console.log('3. Use the toggl_list_workspaces tool to verify connection');