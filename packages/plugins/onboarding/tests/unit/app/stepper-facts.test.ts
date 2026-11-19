import { describe, expect, it } from 'bun:test';
import { type FactKey, readStepperFacts } from '../../../app/features/stepper/stepper-facts.ts';
import type { StepperFact, StepperFacts } from '../../../app/features/stepper/stepper-model.ts';

interface Call {
  readonly route: string;
  readonly init: { quiet?: boolean; signal?: AbortSignal } | undefined;
}

/** A refusal as the client throws it: the status is what says "this machine wants its unlock". */
export const refusal = (status: number, code: string): Error => Object.assign(new Error(code), { status, code });

/** A client answering each route from a table; a missing route or an `Error` value is a refusal. */
const clientOf = (answers: Record<string, unknown>) => {
  const calls: Call[] = [];
  return {
    calls,
    client: {
      call: (async (route: string, init?: Call['init']) => {
        calls.push({ route, init });
        const answer = answers[route];
        if (answer === undefined || answer instanceof Error) throw answer ?? new Error('refused');
        return answer;
      }) as never,
    },
  };
};

/** Reads one batch to the end and gives what each fact said (a fact that never settles is absent). */
const batch = async (
  client: Parameters<typeof readStepperFacts>[0],
  locked = false,
): Promise<Partial<Record<FactKey, StepperFact>>> => {
  const heard: Partial<Record<FactKey, StepperFact>> = {};
  await readStepperFacts(client, locked, new AbortController().signal, (key, fact) => {
    heard[key] = fact;
  });
  return heard;
};

const SET_UP = {
  'GET /v1/passkeys': { passkeys: [{ id: 'k' }], registration: 'closed' },
  'GET /v1/config/file': { exists: true, text: 'name: "Studio"\n', etag: 'e' },
  'GET /v1/logins': { format: 1, machine: 'm', logins: [{ id: 'main' }] },
  'GET /v1/onboarding': { steps: [], complete: false, setUp: true },
  'GET /v1/ferrets': [{ id: 'f1' }],
  'GET /v1/archived-sessions': { count: 0, sessions: [] },
};
const FRESH = {
  'GET /v1/passkeys': { passkeys: [], registration: 'open' },
  'GET /v1/config/file': { exists: false, text: '', etag: 'e' },
  'GET /v1/logins': { format: 1, machine: 'm', logins: [] },
  'GET /v1/onboarding': { steps: [], complete: false, setUp: false },
  'GET /v1/ferrets': [],
  'GET /v1/archived-sessions': { count: 0, sessions: [] },
};
const ALL_TRUE: StepperFacts = { passkey: true, name: true, login: true, runtime: true, ferret: true };
const ALL_FALSE: StepperFacts = { passkey: false, name: false, login: false, runtime: false, ferret: false };

describe('reading the stepper facts', () => {
  it('a fully set-up machine holds every fact', async () => {
    expect(await batch(clientOf(SET_UP).client)).toEqual(ALL_TRUE);
  });

  it('a fresh machine holds none', async () => {
    expect(await batch(clientOf(FRESH).client)).toEqual(ALL_FALSE);
  });

  it('a passkey that exists on a LOCKED machine is a step still to do (Unlock): the passkey fact is locked', async () => {
    expect((await batch(clientOf(SET_UP).client, true)).passkey).toBe('locked');
  });

  it('a host file with no name line is an unnamed machine, even when the file exists', async () => {
    const answers = { ...SET_UP, 'GET /v1/config/file': { exists: true, text: '# nothing\nother: 1\n', etag: 'e' } };
    expect((await batch(clientOf(answers).client)).name).toBe(false);
  });

  it('a machine whose live list is empty but whose archive holds a ferret HAS made a ferret', async () => {
    const answers = { ...SET_UP, 'GET /v1/ferrets': [], 'GET /v1/archived-sessions': { count: 3, sessions: [{}] } };
    expect((await batch(clientOf(answers).client)).ferret).toBe(true);
  });

  it('a machine with neither a live nor an archived ferret has made none', async () => {
    expect((await batch(clientOf({ ...SET_UP, 'GET /v1/ferrets': [] }).client)).ferret).toBe(false);
  });

  it('a live ferret settles the fact without asking the archive', async () => {
    const { client, calls } = clientOf(SET_UP);
    await batch(client);
    expect(calls.map(call => call.route)).not.toContain('GET /v1/archived-sessions');
  });

  it('an unlock refusal makes THAT fact locked; any other failure is unknown; the rest still answer', async () => {
    const answers = {
      ...SET_UP,
      'GET /v1/logins': refusal(401, 'unlock_required'),
      'GET /v1/ferrets': { not: 'a list' },
      'GET /v1/onboarding': refusal(403, 'grant_step_up_required'),
    };
    expect(await batch(clientOf(answers).client)).toEqual({
      passkey: true,
      name: true,
      login: 'locked',
      runtime: undefined,
      ferret: undefined,
    });
  });

  it('a live list refused for the unlock is locked, and the archive is not asked behind it', async () => {
    const { client, calls } = clientOf({ ...SET_UP, 'GET /v1/ferrets': refusal(401, 'unlock_required') });
    expect((await batch(client)).ferret).toBe('locked');
    expect(calls.map(call => call.route)).not.toContain('GET /v1/archived-sessions');
  });

  it('every read is quiet and carries the batch signal, so a background read never raises a prompt and can be cancelled', async () => {
    const { client, calls } = clientOf(FRESH);
    const controller = new AbortController();
    await readStepperFacts(client, false, controller.signal, () => undefined);
    expect(calls.map(call => call.route).sort()).toEqual(Object.keys(FRESH).sort());
    for (const call of calls) {
      expect(call.init?.quiet).toBe(true);
      expect(call.init?.signal).toBe(controller.signal);
    }
  });

  it('a machine known to be locked reads only the passkey (the one read it answers) and says the other four are locked', async () => {
    const { client, calls } = clientOf(SET_UP);
    expect(await batch(client, true)).toEqual({
      passkey: 'locked',
      name: 'locked',
      login: 'locked',
      runtime: 'locked',
      ferret: 'locked',
    });
    expect(calls.map(call => call.route)).toEqual(['GET /v1/passkeys']);
  });

  it('an aborted batch says nothing more', async () => {
    const controller = new AbortController();
    const heard: string[] = [];
    const pending = readStepperFacts(clientOf(SET_UP).client, false, controller.signal, key => heard.push(key));
    controller.abort();
    await pending;
    expect(heard).toEqual([]);
  });
});
