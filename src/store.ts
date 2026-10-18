import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { MailError } from './config.js';
import type { Compose } from './schemas.js';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export interface Draft { id: string; revision: number; createdAt: string; updatedAt: string; message: Compose }

export class Store {
  readonly directory: string;
  constructor(root: string, origin: string, identity: string) {
    this.directory = join(root, hash(`${origin}\n${identity}`));
  }
  private async init() { await mkdir(this.directory, { recursive: true, mode: 0o700 }); }
  private path(kind: string, id: string) { return join(this.directory, `${kind}-${hash(id)}.json`); }
  private async write(path: string, value: unknown, exclusive = false) {
    await this.init();
    const temp = exclusive ? path : `${path}.${randomUUID()}.tmp`;
    const handle = await open(temp, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); }
    finally { await handle.close(); }
    if (!exclusive) await rename(temp, path);
  }
  private async read(path: string): Promise<any> {
    try { return JSON.parse(await readFile(path, 'utf8')); }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw new MailError('NOT_FOUND', 'Local record not found.');
      throw new MailError('STATE_ERROR', 'Local record is unreadable. Restore it before retrying a send.');
    }
  }
  private async lock<T>(path: string, fn: () => Promise<T>): Promise<T> {
    await this.init();
    let handle;
    try { handle = await open(`${path}.lock`, 'wx', 0o600); }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw new MailError('BUSY', 'Draft is being changed. Retry after the other operation finishes.');
      throw e;
    }
    try { return await fn(); }
    finally { await handle.close(); await unlink(`${path}.lock`); }
  }
  async create(message: Compose): Promise<Draft> {
    const now = new Date().toISOString();
    const draft: Draft = { id: randomUUID(), revision: 1, createdAt: now, updatedAt: now, message };
    await this.write(this.path('draft', draft.id), draft, true);
    return draft;
  }
  async get(id: string): Promise<Draft> { return this.read(this.path('draft', id)); }
  async list() {
    await this.init();
    const result = [];
    for (const file of await readdir(this.directory)) {
      if (!/^draft-[a-f0-9]{64}\.json$/.test(file)) continue;
      const d: Draft = await this.read(join(this.directory, file));
      result.push({ id: d.id, revision: d.revision, createdAt: d.createdAt, updatedAt: d.updatedAt, to: d.message.to, subject: d.message.subject });
    }
    return result.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  async update(id: string, revision: number, message: Compose) {
    const path = this.path('draft', id);
    return this.lock(path, async () => {
      const old = await this.get(id);
      if (old.revision !== revision) throw new MailError('REVISION_CONFLICT', 'Draft changed. Read its current revision first.');
      const draft = { ...old, revision: revision + 1, updatedAt: new Date().toISOString(), message };
      await this.write(path, draft);
      return draft;
    });
  }
  async delete(id: string, revision: number) {
    const path = this.path('draft', id);
    return this.lock(path, async () => {
      if ((await this.get(id)).revision !== revision) throw new MailError('REVISION_CONFLICT', 'Draft changed. Read its current revision first.');
      await unlink(path);
      return { deleted: true, id };
    });
  }
  async sendOnce(key: string, payload: unknown, send: () => Promise<unknown>) {
    const path = this.path('send', key), fingerprint = hash(JSON.stringify(payload));
    const record = { key, fingerprint, status: 'pending', createdAt: new Date().toISOString() };
    try { await this.write(path, record, true); }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      const existing = await this.read(path);
      if (existing.fingerprint !== fingerprint) throw new MailError('KEY_CONFLICT', 'This operationKey was used with different message content.');
      if (existing.status === 'accepted') return { ...existing.receipt, replayed: true };
      throw new MailError('SEND_UNCERTAIN', 'This operation is pending or its outcome is uncertain. Inspect the sent mailbox/provider before taking further action; do not retry under a new key.');
    }
    // Any failure after reserving the key remains pending. The upstream has no end-to-end idempotency.
    const receipt = await send();
    await this.write(path, { ...record, status: 'accepted', receipt });
    return { ...(receipt as object), replayed: false };
  }
  async operation(key: string) {
    const record = await this.read(this.path('send', key));
    return { operationKey: record.key, status: record.status, createdAt: record.createdAt, receipt: record.receipt ?? null };
  }
}
