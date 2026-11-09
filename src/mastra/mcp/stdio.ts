#!/usr/bin/env node
/**
 * Stdio entry point — run the portal MCP server over stdio so any MCP client
 * (Claude Desktop, Cursor, Mistra CLI) can launch it as a subprocess:
 *
 *   "mcp-portal": { "command": "npx", "args": ["tsx", "/path/to/src/mastra/mcp/stdio.ts"] }
 */
import { portalMcpServer } from './server.js';

portalMcpServer.startStdio().catch((error) => {
  console.error('Failed to start MCP server:', error);
  process.exit(1);
});
