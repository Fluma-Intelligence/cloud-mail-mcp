import { z } from 'zod';

export const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER - 1);
export const cursor = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER - 1).default(0);
export const folder = z.enum(['inbox', 'sent']).default('inbox');
export const messageRef = { accountId: id.optional(), emailId: id, folder };
export const attachment = z.object({
  filename: z.string().min(1).max(255).regex(/^[^\r\n/\\\x00]+$/),
  content: z.string().max(7 * 1048576).describe('Base64 file content, without a data: prefix.'),
  type: z.string().max(128).regex(/^[a-zA-Z0-9.+_-]+\/[a-zA-Z0-9.+_-]+$/).default('application/octet-stream'),
});
export const composeShape = {
  accountId: id.optional(),
  to: z.array(z.email()).min(1).max(20),
  subject: z.string().max(998).regex(/^[^\r\n\x00]*$/),
  text: z.string().max(100000).default(''),
  html: z.string().max(100000).default(''),
  attachments: z.array(attachment).max(10).default([]),
};
export const compose = z.object(composeShape).refine(v => !!(v.text || v.html), 'Provide text or html.');
export type Compose = z.infer<typeof compose>;
export type Folder = z.infer<typeof folder>;
export const operationKey = z.string().min(1).max(128).regex(/^[a-zA-Z0-9._-]+$/)
  .describe('Stable unique key for this exact send. Reuse for retries; never change it after an uncertain result.');
