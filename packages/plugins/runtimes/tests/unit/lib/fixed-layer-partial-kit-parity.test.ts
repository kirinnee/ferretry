/**
 * Partial-kit parity (E-276 PR 17a, review r2 [2]): a kit that hands Runtimes ONLY its fixed layer (no other member) launches exactly
 * as the base did, which dropped the profile's own permission flags and reported each as overridden. The flags a layer replaces
 * travel WITH the layer (`layer.supersededFlags`), so no kit can give a layer and leave them out. The expected launches are what the
 * base commit made for the same input (`FY_PARITY_PRINT=1` prints them; run the file's `launches()` on the base to re-derive).
 */
import { describe, expect, it } from 'bun:test';
import type { RuntimesHarnessKit } from '../../../contract/index.ts';
import { applyFixedLayer, fixedLayerFor } from '../../../daemon/lib/account/fixed-layer.ts';
import { resolveProfile } from '../../../daemon/lib/account/layering.ts';
import { parseAccountModel } from '../../../daemon/lib/account/schema.ts';
import type { HarnessKind } from '../../../daemon/lib/manifest.ts';
import { REAL_KITS } from '../../support/real-kits.ts';

const CWD = '/home/me/work.repo';
const FY = '/opt/fy/bin/fy';

const profileWith = (harness: HarnessKind, flags: string[]) => {
  const model = parseAccountModel({
    version: 1,
    components: { settings: { mine: { harness, flags, env: { A: 'b' } } } },
    profiles: { agent: { layers: ['settings/mine'] } },
  });
  const result = resolveProfile({ model, profile: 'agent', harness });
  if (!result.ok) throw new Error('unexpected');
  return result.resolved;
};

/** The kits with every member but the fixed layer taken away: the least a plugin can hand Runtimes and still be launched. */
const onlyTheFixedLayer = (): ReadonlyMap<HarnessKind, RuntimesHarnessKit> =>
  new Map([...REAL_KITS].map(([kind, kit]) => [kind, { fixedLayer: kit.fixedLayer } as RuntimesHarnessKit]));

const launchOf = (kits: ReadonlyMap<HarnessKind, RuntimesHarnessKit>, harness: HarnessKind, flags: string[]) => {
  const made = fixedLayerFor(
    { harness, agentPermissions: 'auto', cwd: CWD, fyCommand: FY, acceptsAutoPermissionMode: true },
    kits,
  );
  if (!made.ok) throw new Error(made.refusal.message);
  const launch = applyFixedLayer(profileWith(harness, flags), made.layer);
  return {
    permissionArgs: launch.args.filter(arg =>
      /^(auto|--permission-mode|--dangerously|--full-auto|--sandbox|-a$|-s$|approval_policy=|sandbox_mode=)/u.test(arg),
    ),
    overrides: launch.overridden.filter(entry => entry.kind === 'flag').map(entry => entry.tokens),
  };
};

/** What the base commit made for each case (captured there). */
const EXPECTED: Readonly<Record<string, unknown>> = {
  'claude --permission-mode=default': {
    permissionArgs: ['--permission-mode', 'auto'],
    overrides: [['--permission-mode=default']],
  },
  'claude --permission-mode plan --dangerously-skip-permissions': {
    permissionArgs: ['--permission-mode', 'auto'],
    overrides: [['--permission-mode', 'plan'], ['--dangerously-skip-permissions']],
  },
  'codex --full-auto': {
    permissionArgs: ['approval_policy="on-request"', 'sandbox_mode="workspace-write"'],
    overrides: [['--full-auto']],
  },
  'codex --sandbox read-only -a never': {
    permissionArgs: ['approval_policy="on-request"', 'sandbox_mode="workspace-write"'],
    overrides: [
      ['--sandbox', 'read-only'],
      ['-a', 'never'],
    ],
  },
};

const CASES = [
  ['claude', ['--permission-mode=default']],
  ['claude', ['--permission-mode', 'plan', '--dangerously-skip-permissions']],
  ['codex', ['--full-auto']],
  ['codex', ['--sandbox', 'read-only', '-a', 'never']],
] as const;

describe('a kit with only its fixed layer', () => {
  for (const [harness, flags] of CASES) {
    it(`launches ${harness} with ${flags.join(' ')} as the full kit does, and as the base did`, () => {
      const partial = launchOf(onlyTheFixedLayer(), harness, [...flags]);
      expect(partial).toEqual(launchOf(REAL_KITS, harness, [...flags]));
      expect(partial).toEqual(EXPECTED[`${harness} ${flags.join(' ')}`] as typeof partial);
    });
  }
});

if (process.env.FY_PARITY_PRINT === '1') {
  const printed = Object.fromEntries(
    CASES.map(([harness, flags]) => [
      `${harness} ${flags.join(' ')}`,
      launchOf(onlyTheFixedLayer(), harness, [...flags]),
    ]),
  );
  console.log(JSON.stringify(printed, null, 2));
}
