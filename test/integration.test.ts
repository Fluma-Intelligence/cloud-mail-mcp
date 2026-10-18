import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, stat, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { mailboxFixture } from './fixture.js';
import { loadConfig } from '../src/config.js';

async function setup(t: any, writes = false, options: Record<string, string> = {}, modern = false) {
  const fixture = await mailboxFixture();
  const stateDir = await mkdtemp(join(tmpdir(), 'cloud-mail-mcp-test-'));
  const connections: Client[] = [];
  let stderr = '';
  const connect = async () => {
    const transport = new StdioClientTransport({
      command: process.execPath, args: [resolve('dist/index.js')], stderr: 'pipe',
      env: { MAIL_BASE_URL: fixture.url, MAIL_EMAIL: 'bot@example.test', MAIL_PASSWORD: 'synthetic-password',
        MAIL_STATE_DIR: stateDir, MAIL_ENABLE_WRITE: String(writes), ...options },
    });
    transport.stderr?.on('data', chunk => { stderr += chunk; });
    const client = new Client({ name: 'fixture-client', version: '1.0.0' }, { mode: modern ? { pin: '2026-07-28' } : 'legacy' });
    connections.push(client);
    await client.connect(transport);
    return client;
  };
  t.after(async () => {
    await Promise.all(connections.map(c => c.close()));
    await fixture.close();
    await rm(stateDir, { force: true, recursive: true });
    assert.equal(stderr, '', 'protocol and authentication must not log credentials or mail content');
  });
  const client = await connect();
  async function call(name: string, args: Record<string, unknown> = {}, c = client) {
    const result = await c.callTool({ name, arguments: args });
    const text = (result.content as any[]).find(c => c.type === 'text')?.text;
    return { error: result.isError === true, data: JSON.parse(text) };
  }
  return { ...fixture, client, connect, call, stateDir };
}
const message = { to: ['sender@example.test'], subject: 'Synthetic outbound', text: '<hello>&' };

const execExample = promisify(execFile);
async function sendExample(f: { url: string; stateDir: string }, args: string[], writes = true) {
  const options = { env: { MAIL_BASE_URL: f.url, MAIL_TOKEN: 'fixture-session',
    MAIL_STATE_DIR: f.stateDir, MAIL_ENABLE_WRITE: String(writes) }, timeout: 15000 };
  try {
    return { code: 0, ...await execExample(process.execPath, [resolve('examples/send.mjs'), ...args], options) };
  } catch (error: any) {
    return { code: error.code, stdout: String(error.stdout), stderr: String(error.stderr) };
  }
}

test('legacy MCP handshake, tool schemas and read-only tool visibility', async t => {
  const f = await setup(t);
  const tools = (await f.client.listTools()).tools;
  assert.equal(tools.length, 13);
  assert.ok(!tools.some(t => ['send_message', 'reply_message', 'send_draft', 'mark_read'].includes(t.name)));
  assert.equal(tools.find(t => t.name === 'get_message')?.annotations?.readOnlyHint, true);
  assert.equal((await f.call('mail_status')).data.email, 'bot@example.test');
  await f.call('list_mailboxes');
  assert.equal(f.state.loginCount, 1);
  assert.ok(f.state.requests.filter(r => r.path !== '/api/login').every(r => r.authorization === 'fixture-session'));
});

test('modern MCP discovery and calls use the same tools', async t => {
  const f = await setup(t, false, {}, true);
  assert.ok((await f.client.listTools()).tools.some(t => t.name === 'search_messages'));
  assert.equal((await f.call('mail_status')).data.accountId, 5);
});

test('mailbox listing and descending message pagination', async t => {
  const f = await setup(t);
  const accounts = (await f.call('list_mailboxes')).data.mailboxes;
  assert.deepEqual(accounts.map((a: any) => a.accountId), [5, 6]);
  const first = (await f.call('list_messages', { limit: 2 })).data;
  assert.deepEqual(first.messages.map((r: any) => r.emailId), [164, 163]);
  const next = (await f.call('list_messages', { limit: 2, beforeId: first.nextBeforeId })).data;
  assert.equal(next.messages[0].emailId, 162);
  assert.ok(!('html' in first.messages[0]));
});

test('get_message validates exact ID, folder and ownership', async t => {
  const f = await setup(t);
  const found = await f.call('get_message', { emailId: 164 });
  assert.equal(found.error, false);
  assert.equal(found.data.text, 'Synthetic body 63');
  assert.equal((await f.call('get_message', { emailId: 1000 })).data.error.code, 'NOT_FOUND');
  assert.equal((await f.call('get_message', { emailId: 164, folder: 'sent' })).data.error.code, 'NOT_FOUND');
  assert.equal((await f.call('get_message', { emailId: 164, accountId: 99 })).data.error.code, 'ACCOUNT_ACCESS');
  assert.equal(f.state.reads.length, 0);
});

test('bounded search reports partial results and resumes without skips', async t => {
  const f = await setup(t);
  const first = (await f.call('search_messages', { query: 'needle', field: 'subject', maxPages: 1 })).data;
  assert.equal(first.exhausted, false);
  assert.equal(first.scanned, 50);
  assert.equal(first.messages.length, 0);
  const next = (await f.call('search_messages', { query: 'NEEDLE', beforeId: first.nextBeforeId })).data;
  assert.equal(next.exhausted, true);
  assert.equal(next.messages[0].emailId, 108);
  const capped = (await f.call('search_messages', { query: 'synthetic', maxResults: 2 })).data;
  assert.equal(capped.nextBeforeId, 163);
  assert.equal(capped.scanned, 2);
});

test('download uses an attachment from a verified message', async t => {
  const f = await setup(t);
  assert.equal((await f.call('list_attachments', { emailId: 164 })).data.attachments[0].attachmentId, 7);
  const file = (await f.call('download_attachment', { emailId: 164, attachmentId: 7 })).data;
  assert.equal(Buffer.from(file.content, 'base64').toString(), 'synthetic-file');
  assert.equal((await f.call('download_attachment', { emailId: 164, attachmentId: 8 })).data.error.code, 'NOT_FOUND');
  assert.equal((await f.call('download_attachment', { emailId: 164, accountId: 99, attachmentId: 7 })).data.error.code, 'ACCOUNT_ACCESS');
  assert.equal(f.state.downloads, 1);
});

test('attachment traversal, redirects and streaming size excess are rejected', async t => {
  const f = await setup(t, false, { MAIL_MAX_ATTACHMENT_BYTES: '1024' });
  f.state.badKey = true;
  assert.equal((await f.call('download_attachment', { emailId: 164, attachmentId: 7 })).data.error.code, 'ATTACHMENT_PATH');
  assert.equal(f.state.downloads, 0);
  f.state.badKey = false; f.state.redirectDownload = true;
  assert.equal((await f.call('download_attachment', { emailId: 164, attachmentId: 7 })).error, true);
  f.state.redirectDownload = false; f.state.oversizedDownload = true;
  assert.equal((await f.call('download_attachment', { emailId: 164, attachmentId: 7 })).data.error.code, 'SIZE_LIMIT');
});

test('local drafts survive restart, enforce revisions and use private files', async t => {
  const f = await setup(t);
  const draft = (await f.call('create_draft', message)).data;
  assert.ok(draft.id);
  const other = await f.connect();
  const read = (await f.call('get_draft', { draftId: draft.id }, other)).data;
  assert.equal(read.message.text, '<hello>&');
  const updated = (await f.call('update_draft', { draftId: draft.id, revision: 1, message: { ...message, subject: 'Updated' } })).data;
  assert.equal(updated.revision, 2);
  assert.equal((await f.call('delete_draft', { draftId: draft.id, revision: 1 })).data.error.code, 'REVISION_CONFLICT');
  assert.equal((await f.call('list_drafts')).data.drafts.length, 1);
  const dir = join(f.stateDir, (await readdir(f.stateDir))[0]);
  assert.equal((await stat(dir)).mode & 0o777, 0o700);
  assert.equal((await stat(join(dir, (await readdir(dir))[0]))).mode & 0o777, 0o600);
  assert.equal((await f.call('delete_draft', { draftId: draft.id, revision: 2 })).data.deleted, true);
});

test('send returns receipt, preserves attachment encoding and replays after restart', async t => {
  const f = await setup(t, true);
  const args = { ...message, operationKey: 'test-send-1', attachments: [{ filename: 'test.txt', content: 'aGk=', type: 'text/plain' }] };
  const first = (await f.call('send_message', args)).data;
  assert.equal(first.accepted, true);
  assert.equal(first.deliveryConfirmed, false);
  assert.equal(f.state.sends[0].content, '<pre>&lt;hello&gt;&amp;</pre>');
  assert.equal(f.state.sends[0].attachments[0].content, 'aGk=');
  const other = await f.connect();
  assert.equal((await f.call('send_message', args, other)).data.replayed, true);
  assert.equal(f.state.sends.length, 1);
  assert.equal((await f.call('get_send_status', { operationKey: args.operationKey })).data.status, 'accepted');
  assert.equal((await f.call('send_message', { ...args, text: 'Changed' })).data.error.code, 'KEY_CONFLICT');
});

test('concurrent same-key sends reach the provider at most once', async t => {
  const f = await setup(t, true);
  const other = await f.connect();
  const args = { ...message, operationKey: 'concurrent' };
  const results = await Promise.all([f.call('send_message', args), f.call('send_message', args, other)]);
  assert.equal(f.state.sends.length, 1);
  assert.ok(results.some(r => r.data.accepted));
});

test('uncertain send is never retried automatically or after restart', async t => {
  const f = await setup(t, true);
  f.state.failSend = true;
  const args = { ...message, operationKey: 'uncertain' };
  assert.equal((await f.call('send_message', args)).error, true);
  assert.equal(f.state.sends.length, 1);
  f.state.failSend = false;
  const other = await f.connect();
  assert.equal((await f.call('send_message', args, other)).data.error.code, 'SEND_UNCERTAIN');
  assert.equal(f.state.sends.length, 1);
});

test('reply uses the verified original sender and upstream threading contract', async t => {
  const f = await setup(t, true);
  assert.equal((await f.call('reply_message', { emailId: 164, text: 'Synthetic reply', operationKey: 'reply-1' })).data.accepted, true);
  assert.deepEqual(f.state.sends[0].receiveEmail, ['sender@example.test']);
  assert.equal(f.state.sends[0].emailId, 164);
  assert.equal(f.state.sends[0].sendType, 'reply');
  assert.equal(f.state.sends[0].subject, 'Re: Synthetic message 63');
  f.state.inbox[63].messageId = '';
  assert.equal((await f.call('reply_message', { emailId: 164, text: 'Synthetic reply', operationKey: 'reply-2' })).data.error.code, 'MISSING_THREAD_ID');
  assert.equal(f.state.sends.length, 1);
});

test('send_draft uses the selected revision and retains the local draft', async t => {
  const f = await setup(t, true);
  const draft = (await f.call('create_draft', message)).data;
  assert.equal((await f.call('send_draft', { draftId: draft.id, revision: 2, operationKey: 'draft-1' })).data.error.code, 'REVISION_CONFLICT');
  assert.equal((await f.call('send_draft', { draftId: draft.id, revision: 1, operationKey: 'draft-1' })).data.accepted, true);
  assert.equal((await f.call('list_drafts')).data.drafts.length, 1);
});

test('recipient limits and attachment validation happen before sending', async t => {
  const f = await setup(t, true, { MAIL_ALLOWED_RECIPIENTS: 'allowed@example.test' });
  assert.equal((await f.call('send_message', { ...message, operationKey: 'denied' })).data.error.code, 'RECIPIENT_DENIED');
  assert.equal((await f.call('send_message', { ...message, to: ['allowed@example.test'], operationKey: 'bad-file', attachments: [{ filename: 'x', content: 'invalid!' }] })).data.error.code, 'ATTACHMENT_ENCODING');
  assert.equal(f.state.sends.length, 0);
});

test('mark_read validates the whole batch before changing remote state', async t => {
  const f = await setup(t, true);
  assert.equal((await f.call('mark_read', { emailIds: [164, 1000] })).data.error.code, 'NOT_FOUND');
  assert.equal(f.state.reads.length, 0);
  assert.deepEqual((await f.call('mark_read', { emailIds: [164, 164, 163] })).data.markedRead, [164, 163]);
  assert.deepEqual(f.state.reads, [[164, 163]]);
});

test('HTTP 200 business failures are exposed as MCP errors', async t => {
  const f = await setup(t);
  f.state.failBusiness = true;
  const response = await f.call('mail_status');
  assert.equal(response.error, true);
  assert.equal(response.data.error.code, 'API_403');
});

test('expired JWT can refresh using credentials on read requests', async t => {
  const f = await setup(t, false, { MAIL_TOKEN: 'expired-synthetic-session' });
  assert.equal((await f.call('mail_status')).data.accountId, 5);
  assert.equal(f.state.loginCount, 1);
});

test('user JWT supports authentication without storing a password', async t => {
  const f = await setup(t, false, { MAIL_TOKEN: 'fixture-session', MAIL_EMAIL: '', MAIL_PASSWORD: '' });
  assert.equal((await f.call('mail_status')).data.email, 'bot@example.test');
  assert.equal(f.state.loginCount, 0);
});

test('configuration rejects unsafe origins and malformed controls', () => {
  for (const url of ['http://example.test', 'https://user:password@example.test', 'https://example.test/other', 'https://example.test/?key=secret']) {
    assert.throws(() => loadConfig({ MAIL_BASE_URL: url, MAIL_TOKEN: 'test' }));
  }
  assert.throws(() => loadConfig({ MAIL_BASE_URL: 'https://mail.example.test', MAIL_TOKEN: 'test', MAIL_ENABLE_WRITE: 'yes' }));
  assert.throws(() => loadConfig({ MAIL_BASE_URL: 'https://mail.example.test' }));
  assert.equal(loadConfig({ MAIL_BASE_URL: 'https://mail.example.test/api', MAIL_TOKEN: 'test' }).baseUrl, 'https://mail.example.test');
});

test('send example sends attachments, drafts and replies and reads receipts across processes', async t => {
  const f = await setup(t, true);
  const path = join(f.stateDir, 'request.private.json');
  const request = { name: 'send_message', arguments: { ...message, operationKey: 'example-send',
    attachments: [{ filename: 'hello.txt', type: 'text/plain', content: 'aGVsbG8=' }] } };
  await writeFile(path, JSON.stringify(request));
  const first = await sendExample(f, [path]);
  assert.equal(first.code, 0, first.stderr);
  assert.equal(JSON.parse(first.stdout).accepted, true);
  assert.equal(f.state.sends[0].attachments[0].content, 'aGVsbG8=');
  const repeat = await sendExample(f, [path]);
  assert.equal(JSON.parse(repeat.stdout).replayed, true);
  assert.equal(f.state.sends.length, 1);
  const receipt = await sendExample(f, ['--status', 'example-send'], false);
  assert.equal(receipt.code, 0, receipt.stderr);
  assert.equal(JSON.parse(receipt.stdout).status, 'accepted');
  assert.equal(JSON.parse(receipt.stdout).receipt.deliveryConfirmed, false);

  const draft = (await f.call('create_draft', message)).data;
  await writeFile(path, JSON.stringify({ name: 'send_draft', arguments: {
    draftId: draft.id, revision: draft.revision, operationKey: 'example-draft',
  } }));
  assert.equal((await sendExample(f, [path])).code, 0);
  assert.equal((await f.call('get_draft', { draftId: draft.id })).data.id, draft.id);
  await writeFile(path, JSON.stringify({ name: 'reply_message', arguments: {
    emailId: 164, text: 'Synthetic reply', operationKey: 'example-reply',
  } }));
  assert.equal((await sendExample(f, [path])).code, 0);
  assert.equal(f.state.sends.length, 3);
  assert.equal(f.state.sends[2].sendType, 'reply');
  assert.equal(f.state.sends[2].emailId, 164);
  assert.deepEqual(f.state.sends[2].receiveEmail, ['sender@example.test']);
  assert.ok(!first.stdout.includes(message.text));
  assert.ok(!first.stdout.includes('fixture-session'));
});

test('send example requires write configuration and an explicit operation key before connecting', async t => {
  const f = await setup(t);
  const path = join(f.stateDir, 'request.private.json');
  await writeFile(path, JSON.stringify({ name: 'send_message', arguments: { ...message, operationKey: 'disabled' } }));
  const disabled = await sendExample(f, [path], false);
  assert.equal(disabled.code, 1);
  assert.match(disabled.stderr, /MAIL_ENABLE_WRITE=true/);
  await writeFile(path, JSON.stringify({ name: 'send_message', arguments: message }));
  const missingKey = await sendExample(f, [path]);
  assert.equal(missingKey.code, 1);
  assert.match(missingKey.stderr, /operationKey/);
  const template = await sendExample(f, [resolve('examples/send-message.example.json')]);
  assert.equal(template.code, 1);
  assert.match(template.stderr, /operationKey/);
  assert.equal(f.state.requests.length, 0);
  assert.equal(f.state.sends.length, 0);
});

test('send example exposes pending outcomes and never repeats an uncertain send', async t => {
  const f = await setup(t, true);
  f.state.failSend = true;
  const path = join(f.stateDir, 'request.private.json');
  await writeFile(path, JSON.stringify({ name: 'send_message', arguments: { ...message, operationKey: 'example-uncertain' } }));
  const first = await sendExample(f, [path]);
  assert.equal(first.code, 1);
  assert.equal(JSON.parse(first.stderr).operationKey, 'example-uncertain');
  assert.equal(f.state.sends.length, 1);
  const receipt = await sendExample(f, ['--status', 'example-uncertain'], false);
  assert.equal(JSON.parse(receipt.stdout).status, 'pending');
  f.state.failSend = false;
  const repeat = await sendExample(f, [path]);
  assert.equal(repeat.code, 1);
  assert.equal(JSON.parse(repeat.stderr).error.code, 'SEND_UNCERTAIN');
  assert.equal(f.state.sends.length, 1);
});
