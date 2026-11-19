import { describe, expect, test } from 'bun:test';
import { cap } from '@ferretry/core-gate/contract';
import type { z } from 'zod';
import {
  budgetSentence,
  CacheEntrySchema,
  CiRunSchema,
  MAX_CACHE_BYTES_PER_PROJECT,
  NO_SECRET_FIELDS,
  PullDetailSchema,
  PullFileSchema,
  PullSummarySchema,
  PULLS_CAPS,
  RateBudgetSchema,
  ReviewThreadSchema,
  type CiRun,
  type PullDetail,
  type PullFile,
  type PullSummary,
  type RateBudgetView,
  type ReviewThread,
} from '../../contract/index.ts';
import manifest from '../../manifest.ts';

/** Every key of a zod schema's object shape, through unions, arrays, optionals and nested objects. */
function keysOf(schema: z.ZodType): string[] {
  const def = (
    schema as unknown as {
      def: {
        type: string;
        shape?: Record<string, z.ZodType>;
        options?: z.ZodType[];
        element?: z.ZodType;
        innerType?: z.ZodType;
      };
    }
  ).def;
  switch (def.type) {
    case 'object':
      return Object.entries(def.shape ?? {}).flatMap(([key, value]) => [key, ...keysOf(value)]);
    case 'union':
      return (def.options ?? []).flatMap(keysOf);
    case 'array':
      return def.element === undefined ? [] : keysOf(def.element);
    case 'optional':
    case 'default':
      return def.innerType === undefined ? [] : keysOf(def.innerType);
    default:
      return [];
  }
}

// Compile-time: no wire shape has a token-like key (a typed field would break the build here).
type Forbidden = 'token' | 'accessToken' | 'secret' | 'password' | 'privateKey' | 'bearer' | 'digest';
type NoSecret<T> = Extract<keyof T, Forbidden> extends never ? true : never;
const summaryClean: NoSecret<PullSummary> = true;
const detailClean: NoSecret<PullDetail> = true;
const fileClean: NoSecret<PullFile> = true;
const threadClean: NoSecret<ReviewThread> = true;
const runClean: NoSecret<CiRun> = true;
const budgetClean: NoSecret<RateBudgetView> = true;

const summary = {
  repo: { provider: 'github', owner: 'octo-fake', name: 'widgets' },
  number: 7,
  title: 'Add the thing',
  author: { login: 'octo-fake' },
  state: 'open',
  draft: false,
  review: 'review_required',
  ci: 'running',
  headSha: 'abcdef1234567',
  headRef: 'feature',
  baseRef: 'main',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-02T00:00:00Z',
  url: 'https://github.com/octo-fake/widgets/pull/7',
};

describe('pulls contract', () => {
  test('no wire shape has a field that could carry a token, a secret or rendered HTML (type + schema test)', () => {
    expect([summaryClean, detailClean, fileClean, threadClean, runClean, budgetClean]).toEqual(Array(6).fill(true));
    for (const schema of [
      PullSummarySchema,
      PullDetailSchema,
      PullFileSchema,
      ReviewThreadSchema,
      CiRunSchema,
      RateBudgetSchema,
      CacheEntrySchema,
    ])
      for (const key of keysOf(schema)) expect(NO_SECRET_FIELDS.test(key)).toBe(false);
  });

  test('every object is strict: an unknown field (a token, GitHub’s body_html) is refused', () => {
    expect(PullSummarySchema.safeParse(summary).success).toBe(true);
    expect(PullSummarySchema.safeParse({ ...summary, accessToken: 'x' }).success).toBe(false);
    expect(PullDetailSchema.safeParse({ ...summary, body: 'hi', body_html: '<b>x</b>' }).success).toBe(false);
    expect(
      CacheEntrySchema.safeParse({
        format: 1,
        path: '/x',
        etag: 'W/"1"',
        storedAt: '2026-01-01T00:00:00Z',
        body: 1,
        bearer: 'x',
      }).success,
    ).toBe(false);
  });

  test('a description is bounded to GitHub’s own cap', () => {
    const detail = {
      ...summary,
      body: 'x'.repeat(65_536),
      requestedReviewers: [],
      commits: 1,
      changedFiles: 1,
      additions: 1,
      deletions: 0,
    };
    expect(PullDetailSchema.safeParse(detail).success).toBe(true);
    expect(PullDetailSchema.safeParse({ ...detail, body: 'x'.repeat(65_537) }).success).toBe(false);
  });

  test('the paused sentence is the one the owner asked for', () => {
    expect(budgetSentence('3:05 PM')).toBe("Paused until 3:05 PM to stay inside GitHub's limit");
  });

  test('the cache bound is 32 MiB per project', () => {
    expect(MAX_CACHE_BYTES_PER_PROJECT).toBe(32 * 1024 * 1024);
  });

  test('the manifest reaches nothing itself: no network, no spawn, no root; no new capability', () => {
    expect(manifest.permissions).toEqual({ roots: [], spawn: [], network: [] });
    expect(PULLS_CAPS.read).toEqual(cap('filesystem', 'use'));
    expect(manifest.data?.state?.map(file => file.path)).toEqual(['cache/*']);
  });
});
