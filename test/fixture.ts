import { createServer } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';

export async function mailboxFixture() {
  const inbox = Array.from({ length: 64 }, (_, n) => ({
    emailId: 101 + n, accountId: 5, userId: 10, type: 0, status: 0, unread: 0,
    sendEmail: 'sender@example.test', name: 'Synthetic sender', toEmail: 'bot@example.test',
    subject: n === 7 ? 'Needle in older page' : `Synthetic message ${n}`,
    text: `Synthetic body ${n}`, content: `<p>Synthetic body ${n}</p>`,
    messageId: `<synthetic-${n}@example.test>`, recipient: '[{"address":"bot@example.test"}]',
  }));
  const state = {
    loginCount: 0, sends: [] as any[], reads: [] as number[][], downloads: 0,
    failSend: false, redirectDownload: false, oversizedDownload: false, badKey: false,
    failBusiness: false, inbox, requests: [] as { path: string; method: string; authorization?: string }[],
  };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, 'http://localhost');
    state.requests.push({ path: url.pathname, method: req.method!, authorization: req.headers.authorization });
    const json = (data: unknown, code = 200) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ code, data }));
    };
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    if (url.pathname === '/api/login') {
      state.loginCount++;
      if (body.email !== 'bot@example.test' || body.password !== 'synthetic-password') return json(null, 401);
      return json('fixture-session');
    }
    if (req.headers.authorization !== 'fixture-session') return json(null, 401);
    if (state.failBusiness) return json(null, 403);
    if (url.pathname === '/api/my/loginUserInfo') return json({
      userId: 10, email: 'bot@example.test', account: { accountId: 5, userId: 10, email: 'bot@example.test' },
      permKeys: ['account:query', 'email:send'],
    });
    if (url.pathname === '/api/account/list') return json([
      { accountId: 5, userId: 10, email: 'bot@example.test', name: 'Bot', sort: 0 },
      { accountId: 6, userId: 10, email: 'alias@example.test', name: 'Alias', sort: 0 },
    ]);
    if (url.pathname === '/api/email/list') {
      const before = Number(url.searchParams.get('emailId'));
      const type = Number(url.searchParams.get('type'));
      const accountId = Number(url.searchParams.get('accountId'));
      const rows = [...inbox].filter(r => r.accountId === accountId && r.type === type && (!before || r.emailId < before))
        .sort((a, b) => b.emailId - a.emailId).slice(0, Number(url.searchParams.get('size')) || 10);
      const full = url.searchParams.get('full') !== '0';
      return json({ list: rows.map(row => full ? row : { ...row, content: undefined, text: undefined, listText: row.text }), total: inbox.length });
    }
    if (url.pathname === '/api/email/attList') return json(Number(url.searchParams.get('emailId')) === 164 ? [{
      attId: 7, emailId: 164, accountId: 5, userId: 10,
      key: state.badKey ? 'attachments/../private' : 'attachments/probe.txt',
      filename: 'probe.txt', mimeType: 'text/plain', size: 16,
    }] : []);
    if (url.pathname.startsWith('/api/oss/')) {
      state.downloads++;
      if (state.redirectDownload) { res.writeHead(302, { Location: 'http://127.0.0.1:1/leak' }); return res.end(); }
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      return res.end(state.oversizedDownload ? 'x'.repeat(3000) : 'synthetic-file');
    }
    if (url.pathname === '/api/email/send') {
      state.sends.push(body);
      if (state.failSend) return req.socket.destroy();
      return json([{ emailId: 900 + state.sends.length, status: 1, resendEmailId: `synthetic-send-${state.sends.length}` }]);
    }
    if (url.pathname === '/api/email/read') { state.reads.push(body.emailIds); return json(null); }
    res.writeHead(404); res.end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { state, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise<void>((resolve, reject) => { server.close(e => e ? reject(e) : resolve()); server.closeAllConnections(); }) };
}
