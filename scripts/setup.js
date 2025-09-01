#!/usr/bin/env node

import { promises as fs } from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const execAsync = promisify(exec);

console.log('🚀 MCP Toggl Server Setup\n');

async function setup() {
  try {
    // Check if .env exists
    const envPath = path.join(__dirname, '..', '.env');
    const envExamplePath = path.join(__dirname, '..', '.env.example');
    
    try {
      await fs.access(envPath);
      console.log('✅ .env file already exists');
    } catch {
      console.log('📝 Creating .env file from .env.example...');
      const envContent = await fs.readFile(envExamplePath, 'utf-8');
      await fs.writeFile(envPath, envContent);
      console.log('✅ .env file created');
      console.log('\n⚠️  Please edit .env and add your Toggl API key');
      console.log('   Get your API key from: https://track.toggl.com/profile\n');
    }
    
    // Install dependencies
    console.log('📦 Installing dependencies...');
    await execAsync('npm install');
    console.log('✅ Dependencies installed');
    
    // Build the project
    console.log('🔨 Building the project...');
    await execAsync('npm run build');
    console.log('✅ Project built successfully');
    
    // Display configuration instructions
    console.log('\n' + '='.repeat(50));
    console.log('✨ Setup Complete!\n');
    console.log('Next steps:');
    console.log('1. Edit .env and add your TOGGL_API_KEY');
    console.log('2. Add to your MCP configuration:');
    console.log('\n📋 For Claude Desktop:');
    console.log('Edit: ~/Library/Application Support/Claude/claude_desktop_config.json');
    console.log(JSON.stringify({
      "mcp-toggl": {
        "command": "node",
        "args": [path.join(__dirname, '..', 'dist', 'index.js')],
        "env": {
          "TOGGL_API_KEY": "your_api_key_here"
        }
      }
    }, null, 2));
    
    console.log('\n📋 For Cursor:');
    console.log('Add to .mcp.json in your project:');
    console.log(JSON.stringify({
      "mcp-toggl": {
        "command": "node",
        "args": ["./mcp-servers/mcp-toggl/dist/index.js"],
        "env": {
          "TOGGL_API_KEY": "your_api_key_here"
        }
      }
    }, null, 2));
    
    console.log('\n' + '='.repeat(50));
    console.log('🎉 Ready to use MCP Toggl Server!');
    
  } catch (error) {
    console.error('❌ Setup failed:', error.message);
    process.exit(1);
  }
}

setup();