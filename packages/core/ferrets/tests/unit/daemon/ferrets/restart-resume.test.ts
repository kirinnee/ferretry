import { describe, expect, test } from 'bun:test';
import { err, ok } from '@ferretry/std';
import { type FerretId, type FerretRecord, PERSON_ORIGIN } from '../../../../contract/index.ts';
import { ferretsRestartResume } from '../../../../daemon/lib/ferrets/move-resume.ts';
import type { ServiceResumeOptions } from '../../../../daemon/lib/ferrets/service.ts';
import { ResumeRefused } from '../../../../daemon/lib/session/resume/types.ts';
import type { RestartRelaunch } from '../../../../daemon/modules/restart-in-place.ts';
import { parseSessionId as sessionId } from '../../../../daemon/lib/session-id.ts';

/**
 * A Restart's relaunch (c58-37), one branch at a time, over a recording service: what it asks the service for (the
 * ferret's own runtime on a fresh conversation, none on a resume, the pane the gate judged as the expectation), and each
 * refusal it restates as a {@link ResumeRefused} before or after the service is asked.
 */
const FERRET = 'lead' as unknown as FerretId;

const record = (over: Partial<FerretRecord> = {}): FerretRecord =>
  ({
    runtime: 'claude-main',
    harness: 'claude-code',
    mode: 'interactive',
    folder: '/work/lead',
    handle: '%1',
    ...over,
  }) as FerretRecord;

const request = (over: Partial<RestartRelaunch> = {}): RestartRelaunch => ({
  id: sessionId('lead'),
  origin: PERSON_ORIGIN,
  message: undefined,
  expectHandle: '%1',
  conversation: { kind: 'resume' },
  ...over,
});

function fixture(options: { readonly record?: FerretRecord | undefined; readonly refuse?: string } = {}) {
  const asked: { ferret: FerretId; message: string | undefined; options: ServiceResumeOptions }[] = [];
  const service = {
    resume: async (ferret: FerretId, message: string | undefined, resumeOptions: ServiceResumeOptions) => {
      asked.push({ ferret, message, options: resumeOptions });
      return options.refuse === undefined ? ok(ferret) : err({ code: 'refused' as const, reason: options.refuse });
    },
  };
  const found = 'record' in options ? options.record : record();
  return { asked, relaunch: ferretsRestartResume(service, () => found) };
}

describe('a Restart’s relaunch', () => {
  test('resuming the bound conversation names no target, expects the pane the gate judged, and answers revived', async () => {
    const { asked, relaunch } = fixture();

    const outcome = await relaunch(request({ message: 'carry on', actor: 'warden' }));

    expect(outcome).toEqual({
      target: { id: sessionId('lead'), status: 'running', mode: 'interactive', cwd: '/work/lead', turn: 0 },
      disposition: 'revived',
    });
    expect(asked).toHaveLength(1);
    const [only] = asked;
    expect(only?.message).toBe('carry on');
    expect(only?.options.target).toBeUndefined();
    expect(only?.options.replaceLiveTerminal).toBe(true);
    expect(only?.options.automatic).toBe(false);
    expect(only?.options.actor).toBe('warden');
    expect(only?.options.expect?.({ handle: '%1' } as never)).toBe(true);
    expect(only?.options.expect?.({ handle: '%2' } as never)).toBe(false);
  });

  test('Start fresh relaunches on the ferret’s own runtime and harness, naming no conversation to resume', async () => {
    const { asked, relaunch } = fixture();

    const outcome = await relaunch(request({ conversation: { kind: 'fresh' } }));

    expect(outcome.disposition).toBe('revived');
    expect(asked[0]?.options.target).toEqual({ runtime: 'claude-main', harness: 'claude-code' });
    expect(asked[0]?.options.actor).toBeUndefined();
  });

  test('a ferret that left the registry after the relaunch is still answered, with the defaults', async () => {
    let reads = 0;
    const service = { resume: async () => ok(FERRET) };
    const relaunch = ferretsRestartResume(service, () => (reads++ === 0 ? record() : undefined));

    const outcome = await relaunch(request());

    expect(outcome.target).toEqual({ id: sessionId('lead'), status: 'running', mode: 'auto', cwd: '', turn: 0 });
  });

  test('a request that does not say who it is for is refused, and nothing is asked of the service', async () => {
    const { asked, relaunch } = fixture();

    const refused = relaunch(request({ origin: { kind: 'nobody' } as never }));

    await expect(refused).rejects.toBeInstanceOf(ResumeRefused);
    await expect(refused).rejects.toThrow('did not say who it is relaunching for');
    expect(asked).toHaveLength(0);
  });

  test('a ferret the registry does not hold is refused, and nothing is asked of the service', async () => {
    const { asked, relaunch } = fixture({ record: undefined });

    const refused = relaunch(request());

    await expect(refused).rejects.toBeInstanceOf(ResumeRefused);
    await expect(refused).rejects.toThrow('no ferret lead');
    expect(asked).toHaveLength(0);
  });

  test('a new conversation on a ferret with no runtime recorded is refused, and nothing is asked of the service', async () => {
    const { asked, relaunch } = fixture({ record: record({ runtime: undefined }) });

    const refused = relaunch(request({ conversation: { kind: 'fresh' } }));

    await expect(refused).rejects.toBeInstanceOf(ResumeRefused);
    await expect(refused).rejects.toThrow('no runtime recorded');
    expect(asked).toHaveLength(0);
  });

  test('the service’s own refusal reaches the Restart as a ResumeRefused with its sentence', async () => {
    const { asked, relaunch } = fixture({ refuse: 'no longer owed this resume' });

    const refused = relaunch(request());

    await expect(refused).rejects.toBeInstanceOf(ResumeRefused);
    await expect(refused).rejects.toThrow('no longer owed this resume');
    expect(asked).toHaveLength(1);
  });
});
