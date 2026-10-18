import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { fileURLToPath } from 'node:url';

// Read-only connection smoke test. Prints counts and health, never mail contents or credentials.
const env = Object.fromEntries(Object.entries(process.env).filter(([k, v]) => k.startsWith('MAIL_') && v !== undefined));
env.MAIL_ENABLE_WRITE = 'false';
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [fileURLToPath(new URL('../dist/index.js', import.meta.url))],
  env,
});
const client = new Client({ name: 'cloud-mail-smoke', version: '0.1.0' });
try {
  await client.connect(transport);
  const tools = await client.listTools();
  for (const name of ['mail_status', 'list_messages']) {
    const result = await client.callTool({ name, arguments: name === 'list_messages' ? { limit: 1 } : {} });
    if (result.isError) throw new Error(`Smoke check failed: ${name}. Check mailbox credentials and permissions.`);
  }
  console.log(JSON.stringify({ connected: true, readChecksPassed: true, toolCount: tools.tools.length }));
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Smoke check failed.');
  process.exitCode = 1;
} finally {
  await client.close();
}
