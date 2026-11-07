import { ApiError } from '@ferretry/kernel/contract';
import { z } from 'zod';
import {
  FerretIdSchema,
  FerretNameSchema,
  FerretRoleSchema,
  FerretTitleSchema,
  HarnessKeySchema,
  LoginNameSchema,
  PackIdSchema,
  RuntimeNameSchema,
  type StartOptions,
  StartOptionsSchema,
  type StartRequest,
} from '../../../contract/index.ts';

/**
 * The bodies of `POST /v1/ferrets` and `POST /v1/ferrets/:id/rename`, parsed strictly at the boundary. A body may name
 * a parent (today's `fy start --parent`): the route keeps it for a person and replaces it for a ferret, whose start is
 * always its own helper (today's `lineageOf`).
 *
 * A start carries today's start fields FLAT, as today's wire did (`model`, `label`, `intervalSeconds`, …); they are
 * gathered into the request's `options` ({@link StartOptionsSchema}). Today's task-title field was `name`; in Ferrets
 * `name` is the ferret's first name, so the title travels as `title`.
 */
const StartIdentitySchema = z.strictObject({
  name: FerretNameSchema.optional(),
  parent: FerretIdSchema.optional(),
  pack: PackIdSchema.optional(),
  role: FerretRoleSchema.optional(),
  harness: HarnessKeySchema.optional(),
  harnessConversation: z.string().min(1).max(256).optional(),
  runtime: RuntimeNameSchema.optional(),
  login: LoginNameSchema.optional(),
  folder: z.string().min(1).max(4_096),
  prompt: z.string().max(200_000).optional(),
});

export const StartBodySchema = z
  .strictObject({ ...StartIdentitySchema.shape, ...StartOptionsSchema.shape })
  .superRefine((value, context) => {
    // Today's start was a union on `mode`: `auto` carries a prompt, `interactive` may start bare.
    if (value.mode === 'auto' && (value.prompt === undefined || value.prompt.trim() === ''))
      context.addIssue({ code: 'custom', message: 'an auto start needs a prompt', path: ['prompt'] });
    // Today's `fy new` refinement: `--auto` picks the runtime.
    if (value.auto === true && value.runtime !== undefined)
      context.addIssue({ code: 'custom', message: '--auto picks the runtime; do not name one', path: ['runtime'] });
  });

export const RenameBodySchema = z
  .strictObject({ name: FerretNameSchema.optional(), title: FerretTitleSchema.optional() })
  .superRefine((value, context) => {
    if (value.name === undefined && value.title === undefined)
      context.addIssue({ code: 'custom', message: 'name or title is required' });
  });

/** Today's `StopSessionRequestSchema`. */
export const StopBodySchema = z.strictObject({ reason: z.string().min(1).optional() });

/** Today's `ResumeSessionRequestSchema`. */
export const ResumeBodySchema = z.strictObject({ message: z.string().min(1).optional() });

const parse = <T>(schema: z.ZodType<T>, value: unknown): T => {
  const parsed = schema.safeParse(value);
  if (!parsed.success)
    throw new ApiError(
      400,
      'the request body is not valid',
      'invalid_request',
      parsed.error.issues.map(issue => ({ path: issue.path, message: issue.message })),
    );
  return parsed.data;
};

const OPTION_KEYS: ReadonlySet<string> = new Set(Object.keys(StartOptionsSchema.shape));

export const parseStartBody = (value: unknown): Omit<StartRequest, 'by'> => {
  const identity: Record<string, unknown> = {};
  const options: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(parse(StartBodySchema, value)))
    if (field !== undefined) (OPTION_KEYS.has(key) ? options : identity)[key] = field;
  return {
    ...(identity as Omit<StartRequest, 'by' | 'options'>),
    ...(Object.keys(options).length === 0 ? {} : { options: options as StartOptions }),
  };
};

export const parseRenameBody = (value: unknown): { readonly name?: string; readonly title?: string } =>
  parse(RenameBodySchema, value);

export const parseStopBody = (value: unknown): { readonly reason?: string } => parse(StopBodySchema, value);

export const parseResumeBody = (value: unknown): { readonly message?: string } => parse(ResumeBodySchema, value);
