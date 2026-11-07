/**
 * @ferretry/plugin-codex/contract/testing — the fake and the conformance suite (§7.8). The real implementation
 * and the fake pass the same suite.
 */
import { err, ok, type Result } from '@ferretry/std';
import {
  type CodexApi,
  type Discovery,
  type HarnessCliView,
  HarnessCliViewSchema,
  HarnessInstallMethodSchema,
} from '../index.ts';

/** A `codex` that is not installed on this machine: the honest empty view. */
export const ABSENT_VIEW: HarnessCliView = HarnessCliViewSchema.parse({
  harness: 'codex',
  location: { state: 'absent', searched: [] },
  installed: null,
  method: null,
  plan: null,
  check: { state: 'never' },
  verified: { version: '0.145.0', url: 'https://example.invalid/codex' },
  verification: 'unknown',
  available: false,
  job: null,
});

export interface FakeCodex extends CodexApi {
  setView(view: HarnessCliView): void;
  setDiscovery(discovery: Discovery | undefined): void;
}

export function fakeCodex(): FakeCodex {
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

/** What every implementation of `CodexApi` must satisfy. Returns failures as sentences so any runner can report them. */
export async function codexConformance(make: () => CodexApi): Promise<Result<true, readonly string[]>> {
  const failures: string[] = [];
  const api = make();
  const parsed = HarnessCliViewSchema.safeParse(await api.view());
  if (!parsed.success) failures.push('view() returns a HarnessCliView');
  else if (parsed.data.harness !== 'codex') failures.push('view() is about codex');
  const found = await api.discovery();
  if (found !== undefined && found.format !== 1) failures.push('discovery() is format 1');
  // Codex has no native installer: that install method is not one it can report.
  const native = HarnessInstallMethodSchema.safeParse({ kind: 'native-installer', directory: '/x' });
  if (native.success) failures.push('codex reports no native-installer install method');
  return failures.length === 0 ? ok(true) : err(failures);
}
