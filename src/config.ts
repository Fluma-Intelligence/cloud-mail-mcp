import { homedir } from 'node:os';
import { resolve } from 'node:path';

export class MailError extends Error {
  constructor(public code: string, message: string) { super(message); }
}

export interface Config {
  baseUrl: string;
  token?: string;
  email?: string;
  password?: string;
  enableWrite: boolean;
  allowedRecipients: string[];
  stateDir: string;
  timeoutMs: number;
  maxAttachmentBytes: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  let url: URL;
  try { url = new URL(env.MAIL_BASE_URL || ''); }
  catch { throw new MailError('CONFIG', 'MAIL_BASE_URL must be the HTTPS origin of your mailbox.'); }
  const loopback = ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) ||
      url.username || url.password || url.search || url.hash ||
      !['/', '/api', '/api/'].includes(url.pathname)) {
    throw new MailError('CONFIG', 'Use an HTTPS origin without credentials, query or path (HTTP allowed on loopback).');
  }
  const token = env.MAIL_TOKEN?.trim() || undefined;
  const email = env.MAIL_EMAIL?.trim() || undefined;
  const password = env.MAIL_PASSWORD || undefined;
  if (!token && !(email && password)) {
    throw new MailError('CONFIG', 'Set MAIL_TOKEN or both MAIL_EMAIL and MAIL_PASSWORD.');
  }
  if (token && /[\r\n]/.test(token)) throw new MailError('CONFIG', 'Invalid MAIL_TOKEN.');
  function int(name: string, fallback: number, min: number, max: number) {
    const value = Number(env[name] ?? fallback);
    if (!Number.isInteger(value) || value < min || value > max) throw new MailError('CONFIG', `Invalid ${name}.`);
    return value;
  }
  if (env.MAIL_ENABLE_WRITE && !['true', 'false'].includes(env.MAIL_ENABLE_WRITE)) {
    throw new MailError('CONFIG', 'MAIL_ENABLE_WRITE must be true or false.');
  }
  const allowedRecipients = (env.MAIL_ALLOWED_RECIPIENTS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  if (allowedRecipients.some(s => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s))) {
    throw new MailError('CONFIG', 'MAIL_ALLOWED_RECIPIENTS requires exact email addresses.');
  }
  return {
    baseUrl: url.origin, token, email, password,
    enableWrite: env.MAIL_ENABLE_WRITE === 'true', allowedRecipients,
    stateDir: resolve(env.MAIL_STATE_DIR || `${homedir()}/.local/state/cloud-mail-mcp`),
    timeoutMs: int('MAIL_TIMEOUT_MS', 15000, 100, 120000),
    maxAttachmentBytes: int('MAIL_MAX_ATTACHMENT_BYTES', 1048576, 1, 5 * 1048576),
  };
}
