import { describe, expect, it } from 'bun:test';
import { readStepperFacts } from '../../../app/features/stepper/stepper-facts.ts';

interface Call {
  readonly route: string;
  readonly init: unknown;
}

/** A client answering each route from a table; a missing route or an `Error` value is a refusal. */
const clientOf = (answers: Record<string, unknown>) => {
  const calls: Call[] = [];
  return {
    calls,
    client: {
      call: (async (route: string, init?: unknown) => {
        calls.push({ route, init });
        const answer = answers[route];
        if (answer === undefined || answer instanceof Error) throw answer ?? new Error('refused');
        return answer;
      }) as never,
    },
  };
};

const SET_UP = {
  'GET /v1/passkeys': { passkeys: [{ id: 'k' }], registration: 'closed' },
  'GET /v1/config/file': { exists: true, text: 'name: "Studio"\n', etag: 'e' },
  'GET /v1/logins': { format: 1, machine: 'm', logins: [{ id: 'main' }] },
  'GET /v1/onboarding': { steps: [], complete: false, setUp: true },
  'GET /v1/ferrets': [{ id: 'f1' }],
};
const FRESH = {
  'GET /v1/passkeys': { passkeys: [], registration: 'open' },
  'GET /v1/config/file': { exists: false, text: '', etag: 'e' },
  'GET /v1/logins': { format: 1, machine: 'm', logins: [] },
  'GET /v1/onboarding': { steps: [], complete: false, setUp: false },
  'GET /v1/ferrets': [],
};

describe('reading the stepper facts', () => {
  it('a fully set-up machine holds every fact', async () => {
    expect(await readStepperFacts(clientOf(SET_UP).client, false)).toEqual({
      passkey: true,
      name: true,
      login: true,
      runtime: true,
      ferret: true,
    });
  });

  it('a fresh machine holds none', async () => {
    expect(await readStepperFacts(clientOf(FRESH).client, false)).toEqual({
      passkey: false,
      name: false,
      login: false,
      runtime: false,
      ferret: false,
    });
  });

  it('a passkey that exists on a LOCKED machine is a step still to do (Unlock)', async () => {
    expect((await readStepperFacts(clientOf(SET_UP).client, true)).passkey).toBe(false);
  });

  it('a host file with no name line is an unnamed machine, even when the file exists', async () => {
    const answers = { ...SET_UP, 'GET /v1/config/file': { exists: true, text: '# nothing\nother: 1\n', etag: 'e' } };
    expect((await readStepperFacts(clientOf(answers).client, false)).name).toBe(false);
  });

  it('a refused or unreadable read is unknown for that fact only', async () => {
    const answers = { ...SET_UP, 'GET /v1/logins': new Error('unlock_required'), 'GET /v1/ferrets': { not: 'a list' } };
    expect(await readStepperFacts(clientOf(answers).client, false)).toEqual({
      passkey: true,
      name: true,
      login: undefined,
      runtime: true,
      ferret: undefined,
    });
  });

  it('every read is quiet, so a background read never raises a passkey prompt, and it is exactly five reads', async () => {
    const { client, calls } = clientOf(SET_UP);
    await readStepperFacts(client, false);
    expect(calls.map(call => call.route).sort()).toEqual(Object.keys(SET_UP).sort());
    for (const call of calls) expect((call.init as { quiet?: boolean }).quiet).toBe(true);
  });
});
