/**
 * THE APP'S WHOLE UPDATE, ANSWERED BY THE DAEMON'S REAL ROUTES OVER REAL FILES (design §14.4, "never clear existing
 * credentials"; Option A: a key this machine already holds is never replaced).
 *
 * The real `CloneMachine` screen is driven by clicks, and every request it makes goes through the PWA's real wire
 * client to the daemon's real route tables for the fleet, the configuration files and the secret import and export,
 * over the two-machine world in `daemon/tests/integration/fleet/clone-world.ts`. The source names a key the target
 * LACKS and a key the target already HOLDS. The target is signed in: an account with its sign-in, three kinds of 2FA
 * key, their sealed seeds and a registered passkey sit in the stores the daemon reads them from.
 *
 * WHAT THIS IS NOT: a browser run. The screen is mounted in happy-dom in a child process (so its globals stay out of
 * this tier), requests cross no network, and a passkey ceremony is a flag on the step-up witness. One route, the
 * login list, is answered from the declared model. `support/clone-real-daemon-probe.tsx` says the rest.
 *
 * Two callers are run: the machine's owner (a settings write is applied at once) and a paired phone (the same write
 * LOOSENS, so it is held, and Confirm is refused until a passkey is proved for it).
 */
import { describe, it } from 'bun:test';
import { join } from 'node:path';
import should from 'should';

const packageDir = join(import.meta.dir, '..', '..');
const PROBE = join(import.meta.dir, 'support', 'clone-real-daemon-probe.tsx');
const PROBE_DEADLINE_MS = 120_000;

interface Written {
  readonly machine: 'source' | 'target';
  readonly method: string;
  readonly path: string;
  readonly detail?: string;
  readonly status: number;
  readonly answer?: { readonly imported?: readonly string[]; readonly replaced?: readonly string[] };
}

interface Seen {
  readonly written: readonly Written[];
  readonly keysShown: string;
  readonly keysExpected: readonly string[];
  readonly doneStep: string | null;
  readonly learning: {
    readonly outcomeAtDone: string | null;
    readonly outcomeAfter: string | null;
    readonly onDisk: string;
    readonly stateAtDone: string;
    readonly stateAfter: string;
    readonly heldBefore: boolean;
    readonly heldAtDone: boolean;
    readonly heldAfter: boolean;
  };
  readonly confirmRefusal: string | null;
  readonly held: {
    readonly before: readonly string[];
    readonly after: readonly string[];
    readonly identical: boolean;
    readonly changed: readonly string[];
  };
  readonly accountStores: { readonly before: Record<string, string>; readonly after: Record<string, string> };
  readonly vaultNames: readonly string[];
}

/** Both copies, run in a child process against the daemon's real routes. */
const copies = async (): Promise<{ readonly machine: Seen; readonly phone: Seen }> => {
  const child = Bun.spawn([process.execPath, PROBE], { cwd: packageDir, stdout: 'pipe', stderr: 'inherit' });
  const deadline = setTimeout(() => child.kill('SIGKILL'), PROBE_DEADLINE_MS);
  const [exitCode, output] = await Promise.all([child.exited, new Response(child.stdout).text()]);
  clearTimeout(deadline);
  if (exitCode !== 0) throw new Error(`the real-daemon copy probe exited ${exitCode}`);
  return JSON.parse(output.trim().split('\n').at(-1) ?? '{}') as { machine: Seen; phone: Seen };
};

/** Each write the app made, in the order it made it: what it asked, not the ids the daemon gave it. */
const sequence = (seen: Seen): readonly string[] =>
  seen.written
    .filter(call => call.path !== '/v1/fleet/clone/review')
    .map(call => {
      const route = call.path
        .replace(/\/proposals\/[^/]+\/apply$/u, '/proposals/:id/apply')
        .replace(/\/(imports|exports)\/[^/]+$/u, '/$1/:id');
      const what = call.detail === undefined ? '' : ` ${call.detail}`;
      return `${call.machine} ${call.method} ${route}${what} → ${call.status}`;
    });

const ACCOUNT_FILES = ['state/login-entries.json', 'state/login-secrets.json', 'state/passkeys.json'];

describe('the app’s Update over the daemon’s real routes and real files', () => {
  let run: { readonly machine: Seen; readonly phone: Seen } | undefined;
  const ran = async () => {
    run ??= await copies();
    return run;
  };

  for (const caller of ['machine', 'phone'] as const) {
    it(
      `should copy only the key this machine lacks and leave every login, factor and held key byte-identical (${caller})`,
      async () => {
        const seen = (await ran())[caller];

        should(seen.doneStep).equal('done');
        // The app offered the key the source's setup names and the target lacks; the one it holds was never offered.
        should(seen.keysShown).equal('MISSING_KEY');
        should(seen.keysExpected).deepEqual(['MISSING_KEY']);
        const exported = seen.written.find(call => call.path.startsWith('/v1/secrets/exports/'));
        should(exported?.machine).equal('source');
        should(exported?.detail).equal('MISSING_KEY');
        const completed = seen.written.find(call => /^\/v1\/secrets\/imports\/[^/]+$/u.test(call.path));
        should(completed?.answer?.imported).deepEqual(['MISSING_KEY']);
        should(completed?.answer?.replaced).deepEqual([]);
        should(seen.vaultNames).deepEqual(['HELD_KEY', 'MISSING_KEY', 'OTHER_HELD_KEY']);

        // The held entries are the same bytes, value and timestamps included (Option A); no stored byte moved.
        should(seen.held.changed).deepEqual([]);
        should(seen.held.identical).equal(true);
        should(seen.held.after).deepEqual(seen.held.before);

        // The account index (sign-in and 2FA keys), the sealed seeds and the registered passkey are the very same bytes.
        for (const file of ACCOUNT_FILES) {
          should(seen.accountStores.before[file]).not.equal('missing');
          should(seen.accountStores.after[file]).equal(seen.accountStores.before[file]);
        }
      },
      PROBE_DEADLINE_MS,
    );
  }

  it(
    'should make the exact writes, in order, when the owner is at the machine: the settings write applies at once',
    async () => {
      const seen = (await ran()).machine;

      should(sequence(seen)).deepEqual([
        'target POST /v1/fleet/proposals clone.import → 200',
        'target POST /v1/fleet/proposals/:id/apply → 200',
        'target PUT /v1/config/file learning.yaml → 200',
        'target POST /v1/fleet/proposals machine.settings → 200',
        'target POST /v1/fleet/proposals/:id/apply → 200',
        'target POST /v1/secrets/imports → 201',
        'source POST /v1/secrets/exports/:id MISSING_KEY → 200',
        'target POST /v1/secrets/imports/:id → 200',
      ]);
      // The learning write was applied, not held: in effect, nothing waiting, nothing to confirm.
      should(seen.learning).deepEqual({
        outcomeAtDone: 'copied',
        outcomeAfter: 'copied',
        onDisk: 'enabled: true\nmaxMinersPerRun: 5\n',
        stateAtDone: 'ok',
        stateAfter: 'ok',
        heldBefore: false,
        heldAtDone: false,
        heldAfter: false,
      });
      should(seen.confirmRefusal).be.null();
    },
    PROBE_DEADLINE_MS,
  );

  it(
    'should hold the same loosening for a paired phone, refuse Confirm without a passkey, then put it into effect with one',
    async () => {
      const seen = (await ran()).phone;

      should(sequence(seen)).deepEqual([
        'target POST /v1/fleet/proposals clone.import → 200',
        'target POST /v1/fleet/proposals/:id/apply → 200',
        'target PUT /v1/config/file learning.yaml → 200',
        'target POST /v1/fleet/proposals machine.settings → 200',
        'target POST /v1/fleet/proposals/:id/apply → 200',
        'target POST /v1/secrets/imports → 201',
        'source POST /v1/secrets/exports/:id MISSING_KEY → 200',
        'target POST /v1/secrets/imports/:id → 200',
        // Confirm, first without a passkey for it (refused), then with one.
        'target POST /v1/config/confirm learning.yaml → 403',
        'target POST /v1/config/confirm learning.yaml → 200',
      ]);
      // Written but waiting: the screen and the daemon agree it is held, and say so in words.
      should(seen.learning.outcomeAtDone).equal('pending');
      should(seen.learning.stateAtDone).equal('pending');
      should(seen.learning.heldBefore).equal(false);
      should(seen.learning.heldAtDone).equal(true);
      should(seen.confirmRefusal).match(/passkey/u);
      // The confirmation put it into effect.
      should(seen.learning.outcomeAfter).equal('copied');
      should(seen.learning.stateAfter).equal('ok');
      should(seen.learning.heldAfter).equal(false);
      should(seen.learning.onDisk).equal('enabled: true\nmaxMinersPerRun: 5\n');
    },
    PROBE_DEADLINE_MS,
  );
});
