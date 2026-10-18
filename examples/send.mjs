import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { operationKey } from '../dist/schemas.js';

const usage = `Usage:
  node --env-file=.env examples/send.mjs <private-request.json>
  node --env-file=.env examples/send.mjs --status <operationKey>

Request format: {"name":"send_message|send_draft|reply_message","arguments":{...}}
Sending requires MAIL_ENABLE_WRITE=true and a stable, unique operationKey.
The first command sends immediately. --status only reads the local receipt.`;

class InputError extends Error {}

async function main(args) {
  if (args.length === 1 && args[0] === '--help') {
    console.log(usage);
    return;
  }
  let request;
  if (args.length === 2 && args[0] === '--status') {
    request = { name: 'get_send_status', arguments: { operationKey: args[1] } };
  } else if (args.length === 1 && !args[0].startsWith('--')) {
    let contents;
    try { contents = await readFile(args[0], 'utf8'); }
    catch { throw new InputError('Cannot read the request file.'); }
    try { request = JSON.parse(contents); }
    catch { throw new InputError('The request file must contain valid JSON.'); }
    if (!['send_message', 'send_draft', 'reply_message'].includes(request?.name)) {
      throw new InputError('Use send_message, send_draft or reply_message in the request file.');
    }
    if (process.env.MAIL_ENABLE_WRITE !== 'true') {
      throw new InputError('Set MAIL_ENABLE_WRITE=true in the private environment to enable sending.');
    }
  } else {
    throw new InputError(usage);
  }
  const key = request?.arguments?.operationKey;
  if (!operationKey.safeParse(key).success || key === 'REPLACE_WITH_UNIQUE_OPERATION_KEY') {
    throw new InputError('Provide a stable, unique operationKey in the request; reuse it for this same send.');
  }

  const env = Object.fromEntries(Object.entries(process.env).filter(([k, v]) => k.startsWith('MAIL_') && v !== undefined));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL('../dist/index.js', import.meta.url))],
    env,
  });
  const client = new Client({ name: 'cloud-mail-send-example', version: '0.1.0' });
  try {
    await client.connect(transport);
    const result = await client.callTool(request);
    const data = JSON.parse(result.content.find(item => item.type === 'text')?.text ?? '{}');
    if (result.isError) {
      console.error(JSON.stringify({ operationKey: key, ...data }));
      process.exitCode = 1;
    } else {
      console.log(JSON.stringify(data, null, 2));
    }
  } catch {
    console.error(JSON.stringify({ operationKey: key, error: {
      code: 'MCP_CONNECTION',
      message: 'MCP request did not complete. Check the connection, then use --status with this operationKey before any resend.',
    } }));
    process.exitCode = 1;
  } finally {
    await client.close();
  }
}

try { await main(process.argv.slice(2)); }
catch (error) {
  console.error(error instanceof InputError ? error.message : 'Send example failed. Check the MCP configuration.');
  process.exitCode = 1;
}
