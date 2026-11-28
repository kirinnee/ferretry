import { describe, it } from 'bun:test';
import { err, ok } from '@ferretry/std';
import { type LaunchPart, PERSON_ORIGIN } from '../../../contract/index.ts';
import {
  emptyChildEnvironment,
  FakeHarness,
  FakeRunner,
  fenced,
  ferretId,
  T0,
} from '../../../contract/testing/index.ts';
import { FerretsService, type FerretsPorts } from '../../../daemon/lib/ferrets/service.ts';
import { FerretRegistry } from '../../../daemon/lib/registry/registry.ts';
import { FerretTokenDirectory } from '../../../daemon/lib/tokens/tokens.ts';
import { expectGolden } from './golden-file.ts';

/**
 * E-276 PR 16: how a Ferrets launch treats OpenCode, captured on the base.
 *
 * Two behaviours belong to OpenCode alone, and a harness without them must keep doing what it does today:
 *   1. STAGING. A replacing resume prepares the whole launch (the Vault check included) BEFORE it releases the old pane,
 *      so a refusal leaves the live pane untouched. Every other harness releases first.
 *   2. THE SUBSCRIPTION REFUSAL. The Vault is told this launch refuses Anthropic subscription credentials; when it
 *      refuses, Ferrets answers one sentence, word for word. A harness that does not refuse is told nothing, so the
 *      same credential launches.
 *
 * The three subjects are OpenCode, Claude Code and a third key the contract has never heard of. The Vault here is a
 * stand-in that refuses only when it was told to (it reads the destination the way the base AND the flagged call spell it),
 * and the credential is a synthetic marker, not a credential. The golden holds booleans, counts, order and sentences only.
 *
 * The OpenCode subject is given the two members this PR adds with `Object.assign`, so this file runs, unedited, on the
 * base (which ignores them and reads the key) and after the move (which reads them).
 */

const MARKER = 'SYNTHETIC-SUBSCRIPTION-MARKER';
const SENTENCE = 'OpenCode refuses Anthropic subscription credentials; choose an API key or endpoint login';
const OPENCODE_MEMBERS = { stagesRelaunch: true, subscriptionRefusal: SENTENCE } as const;

type Subject = 'opencode' | 'claude-code' | 'fake-third';
const SUBJECTS: readonly Subject[] = ['opencode', 'claude-code', 'fake-third'];

function fixture(subject: Subject) {
  const registry = new FerretRegistry([]);
  const tokens = new FerretTokenDirectory();
  const harness: FakeHarness =
    subject === 'opencode' ? Object.assign(new FakeHarness(subject), OPENCODE_MEMBERS) : new FakeHarness(subject);
  const runner = new FakeRunner();
  const events: string[] = [];
  const state = { vaultRefuses: false, subscription: false };
  let next = 0;
  const loginParts: readonly LaunchPart[] = [{ kind: 'env', env: { ANTHROPIC_API_KEY: MARKER } }];
  const ports: FerretsPorts = {
    now: () => T0,
    newId: () => {
      next += 1;
      return ferretId(`f${next}`);
    },
    newName: taken => {
      for (let n = 1; ; n += 1) if (!taken(`fern${n}`)) return `fern${n}`;
    },
    save: async () => {},
    saveTokens: async () => {},
    harness: key => (key === harness.key ? harness : undefined),
    harnessKeys: () => [harness.key],
    runner: () => runner,
    decide: async () => ({ allow: true }),
    launchParts: () => [{ parts: async () => (state.subscription ? loginParts : []) }],
    sitrepSources: () => [],
    instructions: () => [],
    folder: path => ok(fenced(path)),
    changed: () => {},
    vault: {
      // The base passes the harness KEY; the move passes a flag. Either spelling of "refuse subscriptions" is told apart here.
      childEnvironment: async (_ferret, env, destination: unknown) => {
        const told = destination === 'opencode' || destination === true;
        events.push(`vault told=${told}`);
        const subscription = Object.values(env).includes(MARKER);
        if (told && (subscription || state.vaultRefuses)) return err({ unknown: [], code: 'subscription_login' });
        return ok(emptyChildEnvironment());
      },
    },
    asks: { open: async () => [] },
  };
  return { harness, runner, events, state, service: new FerretsService(registry, tokens, ports) };
}

const outcome = (answer: { ok: boolean; error?: { code: string; reason?: string } }) =>
  answer.ok ? { ok: true } : { ok: false, code: answer.error?.code, reason: answer.error?.reason };

describe('E-276 PR 16: an OpenCode launch, as the base does it', () => {
  it('stages the replacement and refuses a subscription; every other harness is untouched', async () => {
    const golden: Record<string, unknown> = {};
    for (const subject of SUBJECTS) {
      // 1. A start whose credential is a subscription.
      const first = fixture(subject);
      first.state.subscription = true;
      const refused = await first.service.start({ folder: '/work', harness: subject, by: 'owner' }, PERSON_ORIGIN);
      const start = {
        outcome: outcome(refused),
        events: first.events.join(' > '),
        launched: first.harness.launched.length,
      };

      // 2. A replacing resume that may proceed: where the Vault is asked, and whether the old pane is still alive then.
      const ok1 = fixture(subject);
      ok1.state.vaultRefuses = false;
      const started = await ok1.service.start({ folder: '/work', harness: subject, by: 'owner' }, PERSON_ORIGIN);
      const permitted: Record<string, unknown> = { started: outcome(started) };
      if (started.ok) {
        const before = await ok1.service.handle(started.value);
        ok1.events.length = 0;
        const prepare = ok1.harness.prepareHome.bind(ok1.harness);
        ok1.harness.prepareHome = async spec => {
          ok1.events.push(`prepareHome oldPaneAlive=${await ok1.runner.alive(before as NonNullable<typeof before>)}`);
          return await prepare(spec);
        };
        const replaced = await ok1.service.resume(started.value, undefined, {
          origin: PERSON_ORIGIN,
          replaceLiveTerminal: true,
        });
        permitted['replaced'] = outcome(replaced);
        permitted['events'] = ok1.events.join(' > ');
        permitted['launched'] = ok1.harness.launched.length;
      }

      // 3. A replacing resume the Vault refuses: whether the old pane survives it.
      const refusing = fixture(subject);
      const began = await refusing.service.start({ folder: '/work', harness: subject, by: 'owner' }, PERSON_ORIGIN);
      const refusedReplace: Record<string, unknown> = { started: outcome(began) };
      if (began.ok) {
        const before = await refusing.service.handle(began.value);
        refusing.state.vaultRefuses = true;
        refusing.events.length = 0;
        const replaced = await refusing.service.resume(began.value, undefined, {
          origin: PERSON_ORIGIN,
          replaceLiveTerminal: true,
        });
        refusedReplace['replaced'] = outcome(replaced);
        refusedReplace['events'] = refusing.events.join(' > ');
        refusedReplace['oldPaneAlive'] = await refusing.runner.alive(before as NonNullable<typeof before>);
        refusedReplace['launched'] = refusing.harness.launched.length;
      }
      golden[subject] = { start, permitted, refusedReplace };
    }
    expectGolden('opencode-launch', golden);
  });
});
