#!/usr/bin/env node
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { loadConfig, MailError } from './config.js';
import { createServer } from './server.js';

try {
  const config = loadConfig();
  const handle = serveStdio(() => createServer(config), {
    onerror: () => { process.stderr.write('cloud-mail-mcp: MCP transport error.\n'); },
  });
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => { void handle.close().finally(() => process.exit(0)); });
  }
} catch (e) {
  process.stderr.write(`cloud-mail-mcp: ${e instanceof MailError ? e.message : 'Startup failed.'}\n`);
  process.exitCode = 1;
}
