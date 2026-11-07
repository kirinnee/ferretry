/** Attachments and renders (today's `service.ts` attachment schemas and `renders.ts`). */
import { InstantSchema } from '@ferretry/std';
import { z } from 'zod';

const NonNegativeInteger = z.number().int().nonnegative();
const PositiveInteger = z.number().int().positive();

// ── attachments ──────────────────────────────────────────────────────────────────────────────────

const AttachmentExtractionSchema = z
  .strictObject({
    method: z.enum(['pdfjs', 'docx-xml']),
    characters: NonNegativeInteger,
    truncated: z.boolean(),
    totalPages: PositiveInteger.optional(),
    pagesRead: NonNegativeInteger.optional(),
  })
  .superRefine((value, context) => {
    if ((value.totalPages === undefined) !== (value.pagesRead === undefined))
      context.addIssue({ code: 'custom', message: 'totalPages and pagesRead must appear together' });
    if (value.pagesRead !== undefined && value.totalPages !== undefined && value.pagesRead > value.totalPages)
      context.addIssue({ code: 'custom', message: 'pagesRead may not exceed totalPages', path: ['pagesRead'] });
  });

const AttachmentExtractionFailureSchema = z.strictObject({
  code: z.enum([
    'password_protected_document',
    'no_extractable_text',
    'unreadable_document',
    'document_extraction_timeout',
    'document_too_complex',
  ]),
  message: z.string().min(1),
});

const AttachmentEncryptionSchema = z.discriminatedUnion('locked', [
  z.strictObject({ kind: z.literal('pdf'), locked: z.literal(true) }),
  z.strictObject({
    kind: z.literal('pdf'),
    locked: z.literal(false),
    expiresAt: InstantSchema,
    decryptedSize: PositiveInteger,
  }),
]);

export const AttachmentViewSchema = z
  .strictObject({
    id: z.string().min(1),
    filename: z.string().min(1),
    mime: z.string().min(1),
    size: NonNegativeInteger,
    sha256: z.string().regex(/^[0-9a-f]{64}$/u),
    createdAt: InstantSchema,
    textExtraction: AttachmentExtractionSchema.optional(),
    textExtractionFailure: AttachmentExtractionFailureSchema.optional(),
    encrypted: AttachmentEncryptionSchema.optional(),
  })
  .superRefine((value, context) => {
    if (value.textExtraction !== undefined && value.textExtractionFailure !== undefined)
      context.addIssue({ code: 'custom', message: 'extraction success and failure are mutually exclusive' });
    if (value.encrypted?.locked === true && value.textExtraction !== undefined)
      context.addIssue({ code: 'custom', message: 'a locked attachment cannot expose extracted text' });
  });
export type AttachmentView = z.infer<typeof AttachmentViewSchema>;

export const AttachmentUploadRequestSchema = z.strictObject({
  filename: z.string().trim().min(1).max(255),
  mime: z.string().trim().min(1).max(255),
  base64: z.string().min(1),
});
export type AttachmentUploadRequest = z.infer<typeof AttachmentUploadRequestSchema>;

export const AttachmentUnlockRequestSchema = z.strictObject({ password: z.string().min(1).max(4_096) });
export type AttachmentUnlockRequest = z.infer<typeof AttachmentUnlockRequestSchema>;

export const AttachmentDownloadSchema = z.strictObject({ attachment: AttachmentViewSchema, base64: z.string().min(1) });
export type AttachmentDownload = z.infer<typeof AttachmentDownloadSchema>;

// ── renders ──────────────────────────────────────────────────────────────────────────────────────

export const RENDER_KINDS = ['svg', 'html'] as const;
export const RenderKindSchema = z.enum(RENDER_KINDS);
export type RenderKind = z.infer<typeof RenderKindSchema>;

export const RenderIdSchema = z
  .string()
  .regex(/^[0-9a-hjkmnp-tv-z]{6,52}$/u, 'a render id is 6 to 52 lowercase base32 characters (no i, l, o or u)');
export type RenderId = z.infer<typeof RenderIdSchema>;

/** The token a ferret writes to show a render in its message: `%svg:<id>` / `%html:<id>`. */
export const renderToken = (kind: RenderKind, id: RenderId): string => `%${kind}:${id}`;

export const RENDER_QUOTAS = {
  perFerretCount: 2000,
  perFerretBytes: 64 * 1024 * 1024,
  machineCount: 20_000,
  machineBytes: 1024 * 1024 * 1024,
} as const;
export const RENDER_MAX_PENDING_SAVES = 8;

export const RenderSaveRequestSchema = z.strictObject({
  kind: RenderKindSchema,
  alt: z.string(),
  payload: z.string(),
  supersedes: RenderIdSchema.optional(),
});
export type RenderSaveRequest = z.infer<typeof RenderSaveRequestSchema>;

export const StoredRenderMetaSchema = z.strictObject({
  v: z.literal(1),
  id: RenderIdSchema,
  kind: RenderKindSchema,
  alt: z.string(),
  bytes: NonNegativeInteger,
  sha256: z.string().regex(/^[0-9a-f]{64}$/u),
  createdAt: InstantSchema,
  author: z.strictObject({ ferret: z.string().min(1).optional() }),
  supersedes: RenderIdSchema.optional(),
});
export type StoredRenderMeta = z.infer<typeof StoredRenderMetaSchema>;

export const RenderMetaSchema = StoredRenderMetaSchema.extend({ supersededBy: RenderIdSchema.optional() });
export type RenderMeta = z.infer<typeof RenderMetaSchema>;

export const RenderSaveResponseSchema = z.strictObject({
  id: RenderIdSchema,
  token: z.string(),
  created: z.boolean(),
  meta: RenderMetaSchema,
});
export type RenderSaveResponse = z.infer<typeof RenderSaveResponseSchema>;

export const RenderBodySchema = z.strictObject({ meta: StoredRenderMetaSchema, payload: z.string() });
export type RenderBody = z.infer<typeof RenderBodySchema>;
