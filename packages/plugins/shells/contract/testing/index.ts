/** @ferretry/plugin-shells/contract/testing — the fake and the conformance suite (§7.8). */
import { err, ok, type Result } from '@ferretry/std';
import {
  type NixFacts,
  NixFactsSchema,
  type ShellItem,
  type ShellLock,
  type ShellName,
  type ShellsApi,
  type ShellSummary,
  ShellSummarySchema,
} from '../index.ts';

export interface FakeShells extends ShellsApi {
  setNix(facts: NixFacts): void;
  put(name: ShellName, item: ShellItem, lock?: ShellLock): void;
}

export function fakeShells(): FakeShells {
  const shells = new Map<ShellName, { item: ShellItem; lock: ShellLock | undefined }>();
  let nix: NixFacts = {
    present: false,
    consequence: 'ferrets use the tools already on this machine',
    remedy: 'install nix to give each ferret its own shell',
  };
  return {
    list: async () =>
      [...shells].map(
        ([name, { item, lock }]): ShellSummary => ({
          name,
          kind: item.flake === undefined ? 'packages' : 'flake',
          locked: lock !== undefined,
          floating: item.floating,
          build: 'not-built',
          usedBy: [],
          ...(item.description === undefined ? {} : { description: item.description }),
          ...(lock?.source.kind === 'flake' ? { narHash: lock.source.narHash } : {}),
        }),
      ),
    get: async name => shells.get(name),
    nix: async () => nix,
    setNix: facts => {
      nix = facts;
    },
    put: (name, item, lock) => {
      shells.set(name, { item, lock });
    },
  };
}

/** What every implementation of `ShellsApi` must satisfy. */
export async function shellsConformance(make: () => ShellsApi): Promise<Result<true, readonly string[]>> {
  const failures: string[] = [];
  const api = make();
  if (!NixFactsSchema.safeParse(await api.nix()).success) failures.push('nix() returns NixFacts');
  for (const summary of await api.list())
    if (!ShellSummarySchema.safeParse(summary).success) failures.push(`list() entry ${summary.name} is a ShellSummary`);
  if ((await api.get('no-such-shell' as ShellName)) !== undefined)
    failures.push('get() of an unknown shell is undefined');
  return failures.length === 0 ? ok(true) : err(failures);
}
