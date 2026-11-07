/**
 * @ferretry/plugin-claude-code/contract/testing — the fake and the conformance suite (§7.8). The real implementation
 * and the fake pass the same suite.
 */
import { err, ok, type Result } from '@ferretry/std';
import {
  type ClaudeCodeApi,
  type Discovery,
  type HarnessCliView,
  HarnessCliViewSchema,
  PermissionAnswerRequestSchema,
  PermissionAnswerResultSchema,
} from '../index.ts';

/** A `claude` that is not installed on this machine: the honest empty view. */
export const ABSENT_VIEW: HarnessCliView = HarnessCliViewSchema.parse({
  harness: 'claude-code',
  location: { state: 'absent', searched: [] },
  installed: null,
  method: null,
  plan: null,
  check: { state: 'never' },
  verified: { version: '2.1.220', url: 'https://example.invalid/claude-code' },
  verification: 'unknown',
  available: false,
  job: null,
});

export interface FakeClaudeCode extends ClaudeCodeApi {
  setView(view: HarnessCliView): void;
  setDiscovery(discovery: Discovery | undefined): void;
}

export function fakeClaudeCode(): FakeClaudeCode {
  let view: HarnessCliView = ABSENT_VIEW;
  let discovery: Discovery | undefined;
  return {
    view: async () => view,
    discovery: async () => discovery,
    setView: next => {
      view = next;
    },
    setDiscovery: next => {
      discovery = next;
    },
  };
}

/** What every implementation of `ClaudeCodeApi` must satisfy. Returns failures as sentences so any runner can report them. */
export async function claudeCodeConformance(make: () => ClaudeCodeApi): Promise<Result<true, readonly string[]>> {
  const failures: string[] = [];
  const api = make();
  const parsed = HarnessCliViewSchema.safeParse(await api.view());
  if (!parsed.success) failures.push('view() returns a HarnessCliView');
  else if (parsed.data.harness !== 'claude-code') failures.push('view() is about claude-code');
  const found = await api.discovery();
  if (found !== undefined && found.format !== 1) failures.push('discovery() is format 1');
  // The wire never carries the choice an owner made (G31).
  const answer = PermissionAnswerResultSchema.safeParse({ requestId: '0123456789abcdef', cleared: true, choice: 1 });
  if (answer.success) failures.push('a permission answer result carries no choice');
  const request = PermissionAnswerRequestSchema.safeParse({ kind: 'deny', requestId: 'not-a-digest' });
  if (request.success) failures.push('a permission answer names a 16-hex request id');
  return failures.length === 0 ? ok(true) : err(failures);
}
