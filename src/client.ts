import { Config, MailError } from './config.js';
import type { Compose, Folder } from './schemas.js';

export type Row = Record<string, any>;
export interface Profile { userId: number; email: string; account: Row; permKeys: string[] }

export async function boundedBody(response: Response, maxBytes: number): Promise<Buffer> {
  if (Number(response.headers.get('content-length')) > maxBytes) {
    await response.body?.cancel();
    throw new MailError('SIZE_LIMIT', 'Response exceeds the configured size limit.');
  }
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maxBytes) throw new MailError('SIZE_LIMIT', 'Response exceeds the configured size limit.');
      chunks.push(value);
    }
    return Buffer.concat(chunks);
  } finally { await reader.cancel().catch(() => {}); }
}

export class MailClient {
  private token?: string;
  private loggingIn?: Promise<string>;
  constructor(readonly config: Config) { this.token = config.token; }

  private async request(path: string, method: string, body?: unknown, auth = true): Promise<any> {
    const headers: Record<string, string> = { 'Accept': 'application/json', 'User-Agent': 'cloud-mail-mcp/0.1.0' };
    if (auth) headers.Authorization = await this.getToken();
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    try {
      const r = await fetch(`${this.config.baseUrl}/api${path}`, {
        method, headers, body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'error', signal: AbortSignal.timeout(this.config.timeoutMs),
      });
      if (!r.ok) {
        await r.body?.cancel();
        throw new MailError(`HTTP_${r.status}`, `Mailbox returned HTTP ${r.status}. Check access and service availability.`);
      }
      const raw = await boundedBody(r, 12 * 1048576);
      let data;
      try { data = JSON.parse(raw.toString('utf8')); }
      catch { throw new MailError('INVALID_RESPONSE', 'Mailbox did not return JSON. Check the API origin and access policy.'); }
      if (!data || data.code !== 200) {
        const code = Number.isInteger(data?.code) ? data.code : 500;
        throw new MailError(`API_${code}`, `Mailbox business error ${code}. Check credentials, role permissions and mailbox configuration.`);
      }
      return data.data;
    } catch (e) {
      if (e instanceof MailError) throw e;
      throw new MailError('NETWORK', 'Mailbox request failed or timed out. Write requests are never retried automatically.');
    }
  }

  private async getToken(): Promise<string> {
    if (this.token) return this.token;
    if (!this.config.email || !this.config.password) throw new MailError('AUTH', 'Provide fresh user credentials or MAIL_TOKEN.');
    this.loggingIn ??= this.request('/login', 'POST', {
      email: this.config.email, password: this.config.password,
    }, false).then(value => {
      if (typeof value !== 'string' || !value) throw new MailError('AUTH', 'Unexpected login response.');
      return this.token = value;
    }).finally(() => { this.loggingIn = undefined; });
    return this.loggingIn;
  }

  async api(path: string, method = 'GET', body?: unknown): Promise<any> {
    try { return await this.request(path, method, body); }
    catch (e) {
      if (method === 'GET' && e instanceof MailError && ['API_401', 'HTTP_401'].includes(e.code) && this.config.email && this.config.password) {
        this.token = undefined;
        return this.request(path, method, body);
      }
      throw e;
    }
  }

  async profile(): Promise<Profile> {
    const p = await this.api('/my/loginUserInfo');
    if (!Number.isSafeInteger(p?.userId) || typeof p?.email !== 'string' || !Number.isSafeInteger(p?.account?.accountId)) {
      throw new MailError('INVALID_RESPONSE', 'Unexpected profile response.');
    }
    return p;
  }

  async mailboxes(accountId = 0, lastSort = 9999999999, limit = 30): Promise<Row[]> {
    const rows = await this.api(`/account/list?${new URLSearchParams({ accountId: String(accountId), lastSort: String(lastSort), size: String(limit) })}`);
    if (!Array.isArray(rows)) throw new MailError('INVALID_RESPONSE', 'Unexpected mailbox list.');
    return rows;
  }

  async resolveAccount(accountId?: number): Promise<{ accountId: number; profile: Profile }> {
    const p = await this.profile();
    const wanted = accountId ?? p.account.accountId;
    if (wanted === p.account.accountId) return { accountId: wanted, profile: p };
    let cursorId = 0, lastSort = 9999999999;
    for (let page = 0; page < 100; page++) {
      const rows = await this.mailboxes(cursorId, lastSort);
      if (rows.some(row => row.accountId === wanted && row.userId === p.userId)) return { accountId: wanted, profile: p };
      if (rows.length < 30) break;
      const last = rows.at(-1)!;
      if (last.accountId === cursorId && last.sort === lastSort) throw new MailError('PAGINATION', 'Mailbox cursor did not advance.');
      cursorId = last.accountId; lastSort = last.sort;
    }
    throw new MailError('ACCOUNT_ACCESS', 'Mailbox is not in the current user’s accessible mailbox list.');
  }

  async page(accountId: number, folder: Folder, beforeId = 0, limit = 50, full = true): Promise<Row[]> {
    const data = await this.api(`/email/list?${new URLSearchParams({
      accountId: String(accountId), type: folder === 'inbox' ? '0' : '1',
      emailId: String(beforeId), size: String(limit), timeSort: '0', allReceive: '0', full: full ? '1' : '0',
    })}`);
    if (!Array.isArray(data?.list)) throw new MailError('INVALID_RESPONSE', 'Unexpected message list.');
    let previous = beforeId || Number.MAX_SAFE_INTEGER;
    for (const row of data.list) {
      if (!Number.isSafeInteger(row.emailId) || row.emailId <= 0 || row.emailId >= previous ||
          (row.accountId !== undefined && row.accountId !== accountId)) {
        throw new MailError('INVALID_RESPONSE', 'Mailbox returned inconsistent message IDs or account ownership.');
      }
      previous = row.emailId;
    }
    return data.list;
  }

  async getMessage(accountId: number | undefined, emailId: number, folder: Folder): Promise<Row> {
    const owner = await this.resolveAccount(accountId);
    // Upstream's descending cursor is strictly less-than; id + 1 selects the exact target or an older row.
    const rows = await this.page(owner.accountId, folder, emailId + 1, 1, true);
    const row = rows[0];
    if (!row || row.emailId !== emailId) throw new MailError('NOT_FOUND', 'Message not found in this mailbox and folder.');
    if (row.userId !== owner.profile.userId || row.accountId !== owner.accountId) throw new MailError('MESSAGE_ACCESS', 'Message ownership mismatch.');
    return row;
  }

  async attachments(accountId: number | undefined, emailId: number, folder: Folder): Promise<Row[]> {
    await this.getMessage(accountId, emailId, folder);
    const rows = await this.api(`/email/attList?emailId=${emailId}`);
    if (!Array.isArray(rows) || rows.some(row => row.emailId !== emailId)) throw new MailError('INVALID_RESPONSE', 'Unexpected attachment list.');
    return rows;
  }

  async download(accountId: number | undefined, emailId: number, folder: Folder, attachmentId: number) {
    const row = (await this.attachments(accountId, emailId, folder)).find(row => row.attId === attachmentId);
    if (!row) throw new MailError('NOT_FOUND', 'Attachment not found on the selected message.');
    const key = row.key;
    if (typeof key !== 'string' || !key.startsWith('attachments/') || /[\\?#\x00-\x1f]/.test(key) || key.split('/').some(p => !p || p === '.' || p === '..')) {
      throw new MailError('ATTACHMENT_PATH', 'Unexpected attachment object key.');
    }
    if (Number(row.size) > this.config.maxAttachmentBytes) throw new MailError('SIZE_LIMIT', 'Attachment exceeds MAIL_MAX_ATTACHMENT_BYTES.');
    let bytes: Buffer;
    try {
      const response = await fetch(`${this.config.baseUrl}/api/oss/${key.split('/').map(encodeURIComponent).join('/')}`, {
        headers: { Authorization: await this.getToken(), 'User-Agent': 'cloud-mail-mcp/0.1.0' },
        redirect: 'error', signal: AbortSignal.timeout(this.config.timeoutMs),
      });
      if (!response.ok) { await response.body?.cancel(); throw new MailError('ATTACHMENT_HTTP', 'Attachment download failed.'); }
      bytes = await boundedBody(response, this.config.maxAttachmentBytes);
    } catch (e) {
      if (e instanceof MailError) throw e;
      throw new MailError('NETWORK', 'Attachment download failed or timed out.');
    }
    return { attachmentId, filename: row.filename, mimeType: row.mimeType, bytes: bytes.length, encoding: 'base64', content: bytes.toString('base64') };
  }

  assertWrite() {
    if (!this.config.enableWrite) throw new MailError('WRITE_DISABLED', 'Mailbox writes require MAIL_ENABLE_WRITE=true.');
  }

  validateCompose(input: Compose) {
    for (const to of input.to) {
      if (this.config.allowedRecipients.length && !this.config.allowedRecipients.includes(to.toLowerCase())) {
        throw new MailError('RECIPIENT_DENIED', 'Recipient is outside MAIL_ALLOWED_RECIPIENTS.');
      }
    }
    let size = 0;
    for (const file of input.attachments) {
      if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(file.content)) throw new MailError('ATTACHMENT_ENCODING', 'Attachment content must be canonical Base64.');
      const decoded = Buffer.from(file.content, 'base64');
      if (decoded.toString('base64') !== file.content) throw new MailError('ATTACHMENT_ENCODING', 'Attachment content must be canonical Base64.');
      size += decoded.length;
    }
    if (size > this.config.maxAttachmentBytes) throw new MailError('SIZE_LIMIT', 'Combined attachments exceed MAIL_MAX_ATTACHMENT_BYTES.');
  }
}

export function messageView(row: Row, full = false) {
  const view: Row = {};
  for (const key of ['emailId', 'accountId', 'sendEmail', 'name', 'toEmail', 'subject', 'type', 'status', 'unread', 'createTime', 'messageId', 'inReplyTo', 'relation']) {
    if (row[key] !== undefined) view[key] = row[key];
  }
  view.preview = String(row.listText ?? row.text ?? '').slice(0, 300);
  if (full) {
    view.text = String(row.text ?? '').slice(0, 100000);
    view.html = String(row.content ?? '').slice(0, 100000);
    view.bodyTruncated = String(row.text ?? '').length > 100000 || String(row.content ?? '').length > 100000;
    view.recipient = row.recipient;
  }
  return view;
}
