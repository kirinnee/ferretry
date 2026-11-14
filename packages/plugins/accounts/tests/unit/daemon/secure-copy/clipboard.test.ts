import { describe, it } from 'bun:test';
import should from 'should';
import {
  COPY_AFTER_MASK_SECONDS,
  COPY_DEFAULT_LIFETIME_SECONDS,
  type CopyCapture,
} from '../../../../contract/routes/index.ts';
import { SecureCopyError } from '../../../../daemon/lib/secure-copy/errors.ts';
import type { CopyGuards, CopyPageRead } from '../../../../daemon/lib/secure-copy/ports.ts';
import { SecureCopyService } from '../../../../daemon/lib/secure-copy/service.ts';
import { EphemeralValues } from '../support/masking.ts';

/** Never a real credential. */
const SENTINEL = 'FAKE-SC-7f3a91';
const SESSION = 's1';
const ORIGIN = 'https://keys.example.test';

class Clock {
  ms = Date.parse('2026-11-13T09:00:00.000Z');
  now(): number {
    return this.ms;
  }
}

const FOUND: CopyPageRead = {
  ok: true,
  value: SENTINEL,
  pageId: 'page-1',
  origin: ORIGIN,
  frameOrigin: ORIGIN,
  navigationId: 'loader-1',
};

interface Held {
  readonly session: string;
  readonly copy: string;
  readonly origins: readonly string[];
  readonly until: () => number | undefined;
}

/** The copy service over a clipboard that answers `answer`, a real masking registry and a recording guard port. */
function world(answer: CopyPageRead | Error = FOUND, withClipboard = true) {
  const clock = new Clock();
  const masking = new EphemeralValues(clock);
  const held: Held[] = [];
  const pasted: { session: string; copy: string; origins: readonly string[]; until: () => number | undefined }[] = [];
  const dropped: string[] = [];
  const guards: CopyGuards = {
    hold: (session, copy, origins, until) => void held.push({ session, copy, origins, until }),
    pastedOn: (session, copy, origins, until) => void pasted.push({ session, copy, origins, until }),
    drop: session => void dropped.push(session),
  };
  const asked: string[] = [];
  const inQueue: { masked?: string; guards?: number } = {};
  const scrollback: { session: string; value: string; marker: string }[] = [];
  const service = new SecureCopyService({
    clock,
    runner: {
      run: async () => ({ outcome: 'exited', exitCode: 0, stdout: `${SENTINEL}\n`, stderr: '', truncated: false }),
    },
    folders: { folderOf: async () => '/work' },
    exposure: { transcriptHolds: async () => 'clean' },
    masking: {
      holdUntil: (...args) => masking.holdUntil(...args),
      retime: (...args) => masking.retime(...args),
      holdScrollback: (session, value, marker) => {
        scrollback.push({ session, value, marker });
        return masking.holdScrollback(session, value, marker);
      },
      scrollbackFull: (session, marker) => masking.scrollbackFull(session, marker),
    },
    redact: async text => text,
    guards,
    ...(withClipboard
      ? {
          pages: {
            read: async () => ({ ok: false as const, reason: 'missing' as const }),
            clipboard: async (
              session: string,
              key: string,
              queue: Parameters<
                NonNullable<NonNullable<ConstructorParameters<typeof SecureCopyService>[0]['pages']>['clipboard']>
              >[2],
            ) => {
              asked.push(`${session}:${key}`);
              await queue.guard?.({ document: async () => 'loader-1' });
              if (answer instanceof Error) throw answer;
              if (answer.ok) queue.seal(answer);
              inQueue.masked = masking.scrub(SESSION, `shown: ${SENTINEL}`);
              inQueue.guards = held.length;
              return answer;
            },
          },
        }
      : {}),
  });
  return { clock, masking, service, held, pasted, dropped, asked, inQueue, scrollback };
}

const fromClipboard = (name = 'key'): CopyCapture =>
  ({ name, source: { kind: 'clipboard', key: 'app' } }) as CopyCapture;

const refusal = async (work: Promise<unknown>): Promise<SecureCopyError> => {
  const error = await work.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  should(error).be.instanceOf(SecureCopyError);
  return error as SecureCopyError;
};

describe('capturing what a page put on the clipboard', () => {
  it('should seal the clipboard under the page’s origin, mask it at once and say nothing of the value', async () => {
    const { service, masking, asked } = world();

    const { copy } = await service.capture(SESSION, fromClipboard(), { seen: () => [] });

    should(copy).match({
      handle: 'sealed:key',
      from: { kind: 'clipboard', origin: ORIGIN, surface: 'app' },
      length: SENTINEL.length,
      state: 'live',
    });
    should(asked).eql([`${SESSION}:app`]);
    should(masking.scrub(SESSION, `the key is ${SENTINEL}`)).equal('the key is [sealed:key]');
    should(service.open(SESSION, 'key')).equal(SENTINEL);
    should(JSON.stringify(copy)).not.containEql(SENTINEL);
  });

  it('should mask and close the page INSIDE the page’s queue, before anything queued behind the capture runs', async () => {
    const { service, inQueue, held } = world();

    await service.capture(SESSION, fromClipboard(), { guard: async () => undefined });

    should(inQueue).eql({ masked: 'shown: [sealed:key]', guards: 1 });
    should(held[0]).match({ session: SESSION, copy: 'key', origins: [ORIGIN, ORIGIN] });
  });

  it('should run the guard the agent tools give it first, and read and hold nothing when it refuses', async () => {
    const { service, masking, held } = world();

    const refused = await refusal(
      service.capture(SESSION, fromClipboard(), {
        guard: async () => {
          throw new SecureCopyError('taken_over', 'A person has taken over %browser:app; wait or ask them.');
        },
      }),
    );

    should(refused.message).containEql('taken over');
    should(service.list(SESSION)).eql([]);
    should(masking.scrub(SESSION, SENTINEL)).equal(SENTINEL);
    should(held).eql([]);
  });

  it('should say what to do when the clipboard holds nothing, and hold nothing', async () => {
    const { service, held } = world({ ok: false, reason: 'empty' });

    const refused = await refusal(service.capture(SESSION, fromClipboard()));

    should(refused.message).containEql("press the page's own Copy button first");
    should(service.list(SESSION)).eql([]);
    should(held).eql([]);
  });

  it('should say a page that moved while the clipboard was read copies nothing', async () => {
    const { service } = world({ ok: false, reason: 'changed' });

    const refused = await refusal(service.capture(SESSION, fromClipboard()));

    should(refused.message).containEql('another document');
  });

  it('should refuse a clipboard too short to seal, in words that quote none of it, and guard nothing', async () => {
    const { service, held, masking } = world({ ...FOUND, value: 'abc' });

    const refused = await refusal(service.capture(SESSION, fromClipboard()));

    should(refused.message).containEql('clipboard holds fewer than 4 characters');
    should(refused.message).not.containEql('abc');
    should(held).eql([]);
    should(masking.scrub(SESSION, 'abc')).equal('abc');
  });

  it('should answer unavailable where the daemon has no clipboard reach', async () => {
    const { service } = world(FOUND, false);

    const refused = await refusal(service.capture(SESSION, fromClipboard()));

    should(refused.message).containEql('clipboard is not available');
  });

  it('should pass a refusal from the browser through as a sentence (a person holds the page; a real window)', async () => {
    const { service, held } = world(
      new SecureCopyError('unavailable', 'This browser is a real window on this computer.'),
    );

    const refused = await refusal(service.capture(SESSION, fromClipboard()));

    should(refused.message).containEql('real window');
    should(held).eql([]);
  });
});

describe('the pages a live copy keeps closed', () => {
  it('should answer when the copy ends while it lives, and stop answering when it is discarded', async () => {
    const { service, held, clock } = world();
    await service.capture(SESSION, fromClipboard());
    const [guard] = held;

    const expires = clock.ms + COPY_DEFAULT_LIFETIME_SECONDS * 1000;
    should(guard?.until()).equal(expires);
    service.discard(SESSION, 'key');

    should(guard?.until()).equal(undefined);
  });

  it('should stop answering when the copy expires, and not before', async () => {
    const { service, held, clock } = world();
    await service.capture(SESSION, fromClipboard());
    const [guard] = held;
    clock.ms += COPY_DEFAULT_LIFETIME_SECONDS * 1000 - 1;
    should(guard?.until()).be.a.Number();

    clock.ms += 1;

    should(guard?.until()).equal(undefined);
  });

  it('should not stop answering for the time after a copy ends that its value stays masked (ten minutes)', async () => {
    const { service, held, clock } = world();
    await service.capture(SESSION, fromClipboard());
    service.discard(SESSION, 'key');
    clock.ms += COPY_AFTER_MASK_SECONDS * 500;

    should(held[0]?.until()).equal(undefined);
  });

  it('should register a COMMAND copy too, with no page, so a picture of any page that shows it is checked', async () => {
    const { service, held } = world();

    await service.capture(SESSION, {
      name: 'cli',
      source: { kind: 'command', argv: ['gh', 'auth', 'token'] },
    } as CopyCapture);

    should(held).have.length(1);
    should(held[0]).match({ copy: 'cli', origins: [] });
    should(held[0]?.until()).be.a.Number();
  });

  it('should let go of every guard when the session ends', async () => {
    const { service, dropped } = world();
    await service.capture(SESSION, fromClipboard());

    service.drop(SESSION);

    should(dropped).eql([SESSION]);
  });

  it('should close the origin a copy was PASTED into, until the copy ends', async () => {
    const { service, pasted, clock } = world();
    await service.capture(SESSION, fromClipboard());

    service.protectPaste(SESSION, 'key', { kind: 'page' }, { origins: ['https://form.example.test'] });

    should(pasted).have.length(1);
    should(pasted[0]).match({ session: SESSION, copy: 'key', origins: ['https://form.example.test'] });
    should(pasted[0]?.until()).equal(clock.ms + COPY_DEFAULT_LIFETIME_SECONDS * 1000);
    service.discard(SESSION, 'key');
    should(pasted[0]?.until()).equal(undefined);
  });

  it('should mask a value pasted into a TERMINAL for the life of its scrollback, in every spelling', async () => {
    const { service, scrollback, masking, clock } = world();
    await service.capture(SESSION, fromClipboard());

    service.protectPaste(SESSION, 'key', { kind: 'terminal' }, { origins: [] });
    service.discard(SESSION, 'key');
    clock.ms += 30 * 24 * 3600 * 1000;

    should(scrollback.length).be.above(0);
    should(scrollback.every(held => held.marker === '[sealed:key]')).equal(true);
    should(masking.scrub(SESSION, `$ ${SENTINEL}`)).equal('$ [sealed:key]');
  });

  // R3 (secure-clip-2 fix round 2): the protection is for the capture the write was opened for, not for whatever holds the name.
  it('should refuse to protect a paste for ANOTHER capture of the name, installing nothing', async () => {
    const { service, scrollback, pasted } = world();
    await service.capture(SESSION, fromClipboard());
    const other = new Date(0).toISOString();

    should(() => service.protectPaste(SESSION, 'key', { kind: 'page' }, { origins: ['https://x.test'] }, other)).throw(
      /ended before/,
    );
    should(() => service.protectPaste(SESSION, 'key', { kind: 'terminal' }, { origins: [] }, other)).throw(
      /ended before/,
    );

    should(scrollback).eql([]);
    should(pasted).eql([]);
  });

  it('should protect a paste for the very capture it is pinned to', async () => {
    const { service, pasted } = world();
    await service.capture(SESSION, fromClipboard());
    const pinned = service.describe(SESSION, 'key')?.capturedAt;

    service.protectPaste(SESSION, 'key', { kind: 'page' }, { origins: ['https://form.example.test'] }, pinned);

    should(pasted).have.length(1);
  });

  it('should hold nothing for a paste into the secret store, and for a copy that is no longer live', async () => {
    const { service, scrollback, pasted } = world();
    await service.capture(SESSION, fromClipboard());

    service.protectPaste(SESSION, 'key', { kind: 'secret' }, { origins: [] });
    service.discard(SESSION, 'key');
    // A copy that is no longer live cannot be protected: nothing is written, so the write is refused.
    should(() => service.protectPaste(SESSION, 'key', { kind: 'terminal' }, { origins: [] })).throw(/ended before/);
    should(() => service.protectPaste(SESSION, 'key', { kind: 'page' }, { origins: ['https://x.test'] })).throw(
      /ended before/,
    );

    should(scrollback).eql([]);
    should(pasted).eql([]);
  });
});
