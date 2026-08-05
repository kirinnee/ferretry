import { describe, expect, it } from 'bun:test';
import { FLEET_REFUSAL_CODES } from '@ferretry/protocol';
import { FyHttpError } from '@ferretry/protocol/client';
// A value import, not a type-only one: these tests build the client's real parse failures with it.
import { z } from 'zod';

import {
  applyFleetProposal,
  createFleetProposal,
  FLEET_PATH,
  type FleetClient,
  type FleetRefusalKind,
  fleetRefusal,
  listFleetAssets,
  parseApprovalCode,
  readFleetAsset,
  readFleetConfig,
  readFleetManifest,
  readFleetPermissions,
  readFleetProposal,
} from '../../../../src/features/fleet/fleet-api.ts';
import { config, manifest, permissions, proposal } from './fleet-support.ts';

interface Call {
  readonly path: string;
  readonly init: RequestInit | undefined;
}

const clientFor = (answer: unknown): { client: FleetClient; calls: Call[] } => {
  const calls: Call[] = [];
  const client: FleetClient = {
    request: async <T>(path: string, schema: z.ZodType<T>, init?: RequestInit): Promise<T> => {
      calls.push({ path, init });
      return schema.parse(answer);
    },
  };
  return { client, calls };
};

describe('the fleet wire client', () => {
  it('reads permissions, the manifest and the configuration from their own routes', async () => {
    const readers = [
      [readFleetPermissions, permissions(), `${FLEET_PATH}/permissions`],
      [readFleetManifest, manifest(), `${FLEET_PATH}/accounts`],
      [readFleetConfig, config(), `${FLEET_PATH}/config`],
    ] as const;
    for (const [read, answer, path] of readers) {
      const { client, calls } = clientFor(answer);
      expect(await (read as (client: FleetClient) => Promise<unknown>)(client)).toBeDefined();
      expect(calls[0]?.path).toBe(path);
      expect(calls[0]?.init).toBeUndefined();
    }
  });

  it('reads the asset index and one document by an encoded path', async () => {
    const index = clientFor({ files: [{ path: 'instructions/studio.md', bytes: 12, readable: true }], complete: true });
    const tree = await listFleetAssets(index.client);
    expect(tree.files).toHaveLength(1);
    expect(tree.complete).toBe(true);
    expect(index.calls[0]?.path).toBe(`${FLEET_PATH}/assets`);

    const document = clientFor({ path: 'skills/a b.md', content: 'hello', bytes: 5 });
    expect((await readFleetAsset(document.client, 'skills/a b.md')).content).toBe('hello');
    expect(document.calls[0]?.path).toBe(`${FLEET_PATH}/assets/skills%2Fa%20b.md`);
  });

  it('keeps an unreadable listing, and a truncated walk, instead of dropping either', async () => {
    const { client } = clientFor({
      files: [{ path: 'skills/huge.md', bytes: 999_999, readable: false, reason: 'over the 65536-byte limit' }],
      complete: false,
    });
    const tree = await listFleetAssets(client);
    const entry = tree.files[0];
    expect(entry?.readable).toBe(false);
    // The shared schema makes the reason REQUIRED on an unreadable entry, so this narrows rather than checks.
    expect(entry !== undefined && !entry.readable ? entry.reason : null).toBe('over the 65536-byte limit');
    expect(tree.complete).toBe(false);
  });

  it('posts a proposal as one named mutation and reads it back by id', async () => {
    const created = clientFor(proposal());
    const view = await createFleetProposal(created.client, {
      mutation: { kind: 'edit-account', accountId: 'abc', layer: null },
      assetEdits: [],
    });
    expect(view.id).toBe('fy_fprop_AAAAAAAAAAAAAAAAAAAAAA');
    expect(created.calls[0]?.path).toBe(`${FLEET_PATH}/proposals`);
    expect(created.calls[0]?.init?.method).toBe('POST');
    expect(JSON.parse(String(created.calls[0]?.init?.body))).toEqual({
      mutation: { kind: 'edit-account', accountId: 'abc', layer: null },
      assetEdits: [],
    });

    const read = clientFor(proposal({ approval: { outstanding: true, expiresAt: '2026-08-05T06:02:00.000Z' } }));
    expect((await readFleetProposal(read.client, 'fy_fprop_A')).approval?.outstanding).toBe(true);
    expect(read.calls[0]?.path).toBe(`${FLEET_PATH}/proposals/fy_fprop_A`);
  });

  it('applies exactly one proposal, with the approval code only when there is one', async () => {
    const answer = {
      outcome: 'committed',
      result: { accountCount: 1, operationCount: 3, manifestPath: '/m', prunedWrappers: [], sharedHistory: [] },
    };
    const direct = clientFor(answer);
    const outcome = await applyFleetProposal(direct.client, 'fy_fprop_A');
    expect(outcome.outcome).toBe('committed');
    expect(direct.calls[0]?.path).toBe(`${FLEET_PATH}/proposals/fy_fprop_A/apply`);
    expect(JSON.parse(String(direct.calls[0]?.init?.body))).toEqual({});

    const approved = clientFor(answer);
    await applyFleetProposal(approved.client, 'fy_fprop_A', '7F3K-M9QW');
    expect(JSON.parse(String(approved.calls[0]?.init?.body))).toEqual({ approvalCode: '7F3K-M9QW' });
  });

  it('parses every apply outcome the daemon can report, including the failures', async () => {
    const outcomes: readonly unknown[] = [
      {
        outcome: 'committed-with-history-failure',
        failedHarness: 'claude',
        reason: 'pool is not writable',
        committed: {
          accountCount: 2,
          operationCount: 9,
          manifestPath: '/m',
          manifest: manifest(),
          prunedWrappers: [],
          sharedHistory: [],
        },
      },
      { outcome: 'rolled-back', failedOperation: 'file /bin/claude-studio', reason: 'permission denied' },
      {
        outcome: 'rollback-incomplete',
        failedOperation: 'settings /homes/x/settings.json',
        reason: 'disk full',
        unrestored: [{ path: '/homes/x/settings.json', reason: 'rename failed', backup: '/tmp/x.bak' }],
      },
    ];
    for (const answer of outcomes) {
      const { client } = clientFor(answer);
      const parsed: string = (await applyFleetProposal(client, 'fy_fprop_A')).outcome;
      expect(parsed).toBe((answer as { outcome: string }).outcome);
    }
  });

  it('normalises an approval code the way a person types it, and refuses one that is not a code', () => {
    expect(parseApprovalCode('7f3k m9qw')).toBe('7F3K-M9QW');
    expect(parseApprovalCode('  7F3KM9QW ')).toBe('7F3K-M9QW');
    expect(parseApprovalCode('7F3K-M9Q')).toBeNull();
    // 0, 1, I, L, O and U are not in the alphabet, so a transcription of them is not a code.
    expect(parseApprovalCode('01IL-OUOU')).toBeNull();
  });
});

describe('fleet refusals', () => {
  it('names each daemon code as the state a person has to act on', () => {
    const cases: readonly (readonly [string, FleetRefusalKind])[] = [
      ['fleet_config_missing', 'config-missing'],
      ['fleet_config_invalid', 'config-invalid'],
      ['fleet_not_applied', 'not-applied'],
      ['fleet_manifest_invalid', 'manifest-invalid'],
      ['fleet_proposal_unknown', 'proposal-gone'],
      ['fleet_proposal_expired', 'proposal-gone'],
      ['fleet_proposal_consumed', 'proposal-gone'],
      ['fleet_proposal_stale', 'proposal-stale'],
      ['fleet_proposal_unauthorized', 'proposal-unauthorized'],
      ['fleet_asset_refused', 'refused'],
      ['fleet_plan_refused', 'refused'],
      ['something_new', 'refused'],
    ];
    for (const [code, kind] of cases) {
      expect(fleetRefusal(new FyHttpError('refused', 409, code))).toEqual({ kind, detail: 'refused', code });
    }
  });

  it('maps EVERY code the shared contract declares, so a new one cannot slip through as generic', () => {
    // The compile-time half is `satisfies Record<FleetRefusalCode, …>` in fleet-api.ts. This is the
    // runtime half: if the shared list grows a code the mapping does not carry, the new code would
    // arrive here as the fallback, and this test says that is not good enough.
    const mapped = FLEET_REFUSAL_CODES.map(code => [code, fleetRefusal(new FyHttpError('x', 409, code)).kind]);
    expect(mapped).toHaveLength(FLEET_REFUSAL_CODES.length);
    const generic = mapped.filter(([, kind]) => kind === 'refused').map(([code]) => code);
    // Exactly the five that ARE generic refusals; everything else must name its own state.
    expect(generic).toEqual([
      'fleet_plan_refused',
      'fleet_apply_refused',
      'fleet_environment_refused',
      'fleet_asset_refused',
      'fleet_proposal_refused',
    ]);
  });

  it('treats a 403 as forbidden whatever the code says, and a transport failure as unreachable', () => {
    expect(fleetRefusal(new FyHttpError('a paired device may not apply', 403, 'forbidden')).kind).toBe('forbidden');
    expect(fleetRefusal(new Error('network down')).kind).toBe('unreachable');
    expect(fleetRefusal('not even an error')).toEqual({ kind: 'unreachable', detail: 'not even an error' });
  });

  it('keeps a multiline refusal whole, because the actionable half is usually not the first line', () => {
    const detail = 'the resulting fleet configuration would be invalid:\nagents.0.routes.default.home: duplicate home';
    const refusal = fleetRefusal(new FyHttpError(detail, 409, 'fleet_proposal_refused'));
    expect(refusal.detail).toBe(detail);
    expect(refusal.detail.split('\n')).toHaveLength(2);
  });

  it('falls back to the error type when a thrown error carries no message', () => {
    expect(fleetRefusal(new Error('')).detail).toBe('Error');
  });

  it('calls a structurally invalid answer malformed, in one sentence rather than a JSON dump', () => {
    // What the client actually throws: `schema.parse` on a 200 whose shape is wrong. Built by parsing,
    // not hand-written, so the test cannot drift from the error this boundary really receives.
    const failure = z
      .object({ files: z.array(z.object({ path: z.string(), bytes: z.number() })) })
      .safeParse({ files: [{ path: 'instructions/a.md', bytes: 'twelve' }] });
    const thrown = failure.success ? new Error('the fixture was supposed to fail') : failure.error;

    const refusal = fleetRefusal(thrown);
    // RED before F3: kind was `unreachable` and detail was the multi-line dump of every issue.
    expect(refusal.kind).toBe('malformed');
    expect(refusal.detail).toBe(
      "this daemon's answer does not match the fleet contract at files.0.bytes: Invalid input: expected number, received string",
    );
    expect(refusal.detail).not.toContain('\n');
    expect(refusal.detail).not.toContain('"code"');
    expect(refusal.code).toBeUndefined();
  });

  it('counts the issues it did not print, and names the answer itself when the failure has no path', () => {
    const many = z.object({ a: z.number(), b: z.number(), c: z.number() }).safeParse({ a: 'x', b: 'y', c: 'z' });
    const detail = many.success ? '' : fleetRefusal(many.error).detail;
    expect(detail).toContain('at a:');
    expect(detail).toContain('(and 2 more)');

    const root = z.array(z.string()).safeParse({ not: 'an array' });
    const rootDetail = root.success ? '' : fleetRefusal(root.error).detail;
    expect(rootDetail).toBe(
      "this daemon's answer does not match the fleet contract: Invalid input: expected array, received object",
    );
  });

  it('keeps a transport failure and a worded refusal out of the malformed state', () => {
    // The check is about the SHAPE a schema failure has, so an ordinary error must not fall into it —
    // otherwise "the daemon answered badly" would start covering "the daemon never answered".
    expect(fleetRefusal(new Error('network down')).kind).toBe('unreachable');
    const carrying = Object.assign(new Error('network down'), { issues: 'not a list of issues' });
    expect(fleetRefusal(carrying).kind).toBe('unreachable');
    expect(fleetRefusal(Object.assign(new Error('x'), { issues: [] })).kind).toBe('unreachable');
    // A daemon that WORDED its refusal is still that refusal, whatever it carries.
    expect(fleetRefusal(new FyHttpError('no', 403, 'forbidden')).kind).toBe('forbidden');
  });
});
