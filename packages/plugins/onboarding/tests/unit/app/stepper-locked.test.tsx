/**
 * THE STEPPER ON A LOCKED MACHINE, through the REAL client (`DaemonClient`) over a fake transport, because the fake
 * client of the other suites cannot show what the real one does: a locked machine answers every protected read
 * `401 unlock_required` EXCEPT the passkey list, and the client PARKS a background read behind that unlock (waiting
 * quietly, never raising the prompt), so such a read never settles at all while the machine stays locked.
 */
import { describe, expect, it } from 'bun:test';
import { DaemonClient } from '@ferretry/app/testing';
import { useStepper } from '../../../app/features/stepper/use-stepper.ts';
import { readStepperFacts, type FactKey } from '../../../app/features/stepper/stepper-facts.ts';
import type { StepperFact } from '../../../app/features/stepper/stepper-model.ts';
import { mount } from '../support/dom.ts';
import { StepperView } from '../../../app/features/stepper/stepper-view.tsx';
import type { StepperStorage } from '../../../app/features/stepper/stepper-memory.ts';

const ROUTES: Record<string, readonly string[]> = {
  kernel: ['GET /v1/config/file'],
  access: ['GET /v1/passkeys'],
  logins: ['GET /v1/logins'],
  ferrets: ['GET /v1/ferrets', 'GET /v1/archived-sessions'],
  onboarding: ['GET /v1/onboarding'],
};
const surfaces = Object.entries(ROUTES).map(([id, routes]) => ({
  id,
  title: id,
  core: false,
  contract: `h-${id}`,
  consumes: [],
  manifest: {
    id,
    title: id,
    version: '5.0.0',
    api: 5,
    core: false,
    kinds: [],
    actions: { routes: routes.map(key => ({ key, minimum: 'authenticated', caller: 'any', audit: 'skip' })) },
  },
}));
const ok = (body: unknown) => ({ status: 200, headers: {}, body });
const UNLOCK = { status: 401, headers: {}, body: { error: 'Unlock this machine first.', code: 'unlock_required' } };

const SET_UP: Record<string, unknown> = {
  '/v1/config/file': { exists: true, text: 'name: "Studio"\n', etag: 'e' },
  '/v1/logins': { logins: [{ id: 'main' }] },
  '/v1/ferrets': [{ id: 'f' }],
  '/v1/archived-sessions': { count: 0, sessions: [] },
  '/v1/onboarding': { setUp: true },
};

/** A machine that answers the passkey list whatever its lock, and every other read only once `state.locked` is false. */
function machine(options: { passkeys: number }) {
  const state = { locked: true };
  const prompts: string[] = [];
  const transport = {
    requests: [] as { path: string }[],
    async request(request: { path: string }) {
      transport.requests.push(request);
      if (request.path === '/v1/plugins')
        return ok({ protocol: 1, plugins: surfaces.map(s => ({ id: s.id, on: true, contract: s.contract })) });
      if (request.path === '/v1/health') return ok({ protocol: 1, version: '5.0.0' });
      if (request.path === '/v1/passkeys')
        return ok({ passkeys: Array.from({ length: options.passkeys }, () => ({})) });
      return state.locked ? UNLOCK : ok(SET_UP[request.path]);
    },
    events: () => () => undefined,
    socket: () => ({ send: () => undefined, close: () => undefined }),
    onReconnect: () => () => undefined,
  };
  const client = new DaemonClient({
    transport: transport as never,
    surfaces: surfaces as never,
    personActing: () => false,
    passkey: {
      daemon: {
        daemon: 'd1',
        machine: 'laptop',
        deviceId: 'x',
        address: 'http://127.0.0.1:1',
        carriers: [],
        pairedAt: 1,
        lastSelectedAt: 1,
      },
      handler: {
        need: (refusal: { status: number; body: unknown }) =>
          refusal.status === 401 && (refusal.body as { code?: string }).code === 'unlock_required'
            ? { kind: 'unlock' }
            : undefined,
        // The person has not unlocked: the prompt waits (and is asked only as an `unasked` origin, which never pops).
        confirm: (_daemon: unknown, _need: unknown, origin: string) => {
          prompts.push(origin);
          return new Promise<boolean>(() => undefined);
        },
        ask: async () => false,
        focus: () => undefined,
        locked: () => [],
        subscribe: () => () => undefined,
      } as never,
    },
  });
  const plugin = client.forPackage('onboarding');
  return {
    state,
    prompts,
    client,
    stepperClient: { call: plugin.call.bind(plugin), subscribe: () => () => undefined } as never,
  };
}

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const memoryStore = (): StepperStorage => {
  const map = new Map<string, string>();
  return { getItem: key => map.get(key) ?? null, setItem: (key, value) => void map.set(key, value) };
};

describe('the stepper facts on a locked machine (the real client)', () => {
  it('the passkey fact settles by itself while the four parked reads are still waiting (no all-or-nothing)', async () => {
    const world = machine({ passkeys: 0 });
    await world.client.start();
    const controller = new AbortController();
    const heard: Partial<Record<FactKey, StepperFact>> = {};
    void readStepperFacts(world.stepperClient, false, controller.signal, (key, fact) => {
      heard[key] = fact;
    });
    await wait(40);
    expect(heard).toEqual({ passkey: false }); // the other four are parked behind the unlock, not answered, not guessed
    expect(world.prompts.every(origin => origin === 'unasked')).toBe(true); // a background read never raises a prompt
    controller.abort();
  });

  it('on a machine known to be locked the other four are locked at once, from one passkey read', async () => {
    const world = machine({ passkeys: 1 });
    await world.client.start();
    const heard: Partial<Record<FactKey, StepperFact>> = {};
    await readStepperFacts(world.stepperClient, true, new AbortController().signal, (key, fact) => {
      heard[key] = fact;
    });
    expect(heard).toEqual({ passkey: 'locked', name: 'locked', login: 'locked', runtime: 'locked', ferret: 'locked' });
  });

  it('the stepper draws once the shell knows it is locked, the first still-unknown step the one to do, though four reads never answered', async () => {
    const world = machine({ passkeys: 1 });
    await world.client.start();
    const Probe = ({ locked }: { readonly locked: boolean }) => {
      const reading = useStepper(world.stepperClient, 'd1', locked, () => memoryStore());
      return reading.visible && reading.steps !== undefined ? (
        <StepperView
          onDismiss={reading.dismiss}
          steps={reading.steps}
          action={{ label: 'Unlock', run: () => undefined }}
        />
      ) : null;
    };
    // A cold cache: nothing says "locked" yet, so the four reads park and only the passkey answers (it holds: nothing open).
    const view = await mount(<Probe locked={false} />);
    await wait(40);
    expect(view.container.querySelector('[data-first-run-stepper]')).toBeNull();
    // The shell then learns the machine is locked from the parked refusal: the steps now say so.
    await view.render(<Probe locked />);
    await wait(40);
    const states = [...view.container.querySelectorAll('[data-step]')].map(
      item => `${item.getAttribute('data-step')}:${item.getAttribute('data-state')}`,
    );
    expect(states).toEqual(['pair:done', 'passkey:done', 'name:current', 'login:next', 'runtime:next', 'ferret:next']);
    expect(view.container.querySelector('[data-first-run-stepper-action="name"]')?.textContent).toBe('Unlock');
    await view.unmount();
  });
});

describe('a late answer from an older batch (out of order)', () => {
  it('is never heard: the older batch answers AFTER the newer one and the passkey stays done, in memory and in storage', async () => {
    const releaseOld: (() => void)[] = [];
    let passkeyReads = 0;
    const answers: Record<string, unknown> = { ...SET_UP, '/v1/passkeys': { passkeys: [{}] } };
    const client = {
      call: (async (route: string) => {
        const path = route.replace('GET ', '');
        if (path === '/v1/passkeys') {
          passkeyReads += 1;
          // The first read (the locked batch) is slow; the second (after the unlock) answers at once.
          if (passkeyReads === 1) {
            await new Promise<void>(resolve => releaseOld.push(resolve));
            return { passkeys: [] }; // stale: the passkey had not been added when this batch asked
          }
        }
        return answers[path];
      }) as never,
      subscribe: (() => () => undefined) as never,
    };
    const storage = memoryStore();
    const Probe = ({ locked }: { readonly locked: boolean }) => {
      const reading = useStepper(client, 'd1', locked, () => storage);
      return reading.steps === undefined ? null : (
        <p data-passkey={reading.steps.find(step => step.id === 'passkey')?.state} />
      );
    };
    const passkey = (container: HTMLElement) => container.querySelector('[data-passkey]')?.getAttribute('data-passkey');
    const view = await mount(<Probe locked />);
    await wait(20);
    await view.render(<Probe locked={false} />);
    await wait(40);
    expect(passkey(view.container)).toBe('done');
    for (const release of releaseOld) release(); // the old batch finally answers, with a stale "no passkey"
    await wait(40);
    expect(passkey(view.container)).toBe('done');
    expect(storage.getItem('fy:onboarding:stepper:d1')).toContain('"passkey":true');
    await view.unmount();
  });
});
