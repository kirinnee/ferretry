import { ApiError } from '@ferretry/kernel/contract';
import { z } from 'zod';
import {
  FerretNameSchema,
  FerretRoleSchema,
  HarnessKeySchema,
  LoginNameSchema,
  PackIdSchema,
  RuntimeNameSchema,
  type StartRequest,
} from '../../../contract/index.ts';

/**
 * The bodies of `POST /v1/ferrets` and `POST /v1/ferrets/:id/rename`, parsed strictly at the boundary. A body never
 * names the parent: a ferret's start is its own helper (the route sets it from the caller's token), and the owner's
 * start has none.
 */
export const StartBodySchema = z.strictObject({
  name: FerretNameSchema.optional(),
  pack: PackIdSchema.optional(),
  role: FerretRoleSchema.optional(),
  harness: HarnessKeySchema.optional(),
  runtime: RuntimeNameSchema.optional(),
  login: LoginNameSchema.optional(),
  folder: z.string().min(1).max(4_096),
  prompt: z.string().max(200_000).optional(),
});

export const RenameBodySchema = z.strictObject({ name: FerretNameSchema });

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

export const parseStartBody = (value: unknown): Omit<StartRequest, 'by' | 'parent'> =>
  parse(StartBodySchema, value) as Omit<StartRequest, 'by' | 'parent'>;

export const parseRenameBody = (value: unknown): { readonly name: string } => parse(RenameBodySchema, value);
