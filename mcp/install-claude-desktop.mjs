#!/usr/bin/env node
// Connect CircuitPilot to the Claude Desktop app:  node mcp/install-claude-desktop.mjs
// Adds the CircuitPilot MCP server to Claude Desktop's config (a backup is kept next to it), then restart Claude Desktop.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const server = path.join(here, 'circuitpilot-mcp.mjs');
const dir = process.platform === 'win32' ? path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Claude')
  : process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Application Support', 'Claude')
  : path.join(os.homedir(), '.config', 'Claude');
const cfg = path.join(dir, 'claude_desktop_config.json');

// the Python that runs server.py (CircuitPilot starts it automatically when Claude needs it)
let python = 'python';
for (const cand of process.platform === 'win32' ? ['python', 'py'] : ['python3', 'python']) {
  try { const out = execSync(`${cand} -c "import sys;print(sys.executable)"`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); if (out) { python = out; break; } } catch { }
}

let data = {};
if (fs.existsSync(cfg)) {
  try { data = JSON.parse(fs.readFileSync(cfg, 'utf8') || '{}'); } catch { console.error(`Could not read ${cfg} (invalid JSON). Fix or remove it, then run this again.`); process.exit(1); }
  fs.copyFileSync(cfg, cfg + '.backup-before-circuitpilot');
} else fs.mkdirSync(dir, { recursive: true });

data.mcpServers = data.mcpServers || {};
data.mcpServers.circuitpilot = {
  command: process.execPath,
  args: [server],
  env: { CP_URL: process.env.CP_URL || 'http://localhost:5173', CP_PYTHON: python },
};
fs.writeFileSync(cfg, JSON.stringify(data, null, 2));

console.log(`CircuitPilot added to Claude Desktop (${cfg}).
  Node:   ${process.execPath}
  Python: ${python}
Now quit Claude Desktop completely (also from the system tray) and open it again.
Then just ask, for example: "Design a USB-C powered ESP32-C3 board with a BME280 sensor, 30 x 30 mm."
CircuitPilot starts by itself and opens in your browser so you can watch the design.`);
