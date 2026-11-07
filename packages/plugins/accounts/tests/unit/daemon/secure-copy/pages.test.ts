import { describe, it } from 'bun:test';
import { COPY_AFTER_MASK_SECONDS, COPY_DEFAULT_LIFETIME_SECONDS, type CopyCapture } from '@ferretry/protocol';
import should from 'should';
import type { BrowserCopyRead } from '../../../src/lib/browser/transport/copy-contracts.ts';
import {
  BrowserCopyPages,
  type CopyPageRead,
  EphemeralValues,
  PageCopyRecords,
  SecureCopyError,
  SecureCopyService,
} from '../../../src/lib/index.ts';

const TOKEN = 'ghp_PAGE-SEALED-UNIQUE-55b0';
const SESSION = 's1';

class Clock {
  ms = Date.parse('2026-10-31T09:00:00.000Z');
  now(): number {
    return this.ms;
  }
}

const READ: CopyPageRead = {
  ok: true,
  value: `\n  ${TOKEN}  \n`,
  pageId: 'page-1',
  origin: 'https://github.com',
  frameOrigin: 'https://github.com',
  navigationId: 'loader-1',
};

/**
 * The copy service over a fake page that runs the queue as `BrowserCopyPages` does (guard, read, seal), a real
 * masking registry and real page records. `inQueue` is what the masking showed right after the seal, before the
 * read returned: what an act queued behind the copy would meet.
 */
function world(answer: CopyPageRead | Error = READ, wired = true) {
  const clock = new Clock();
  const masking = new EphemeralValues(clock);
  const records = new PageCopyRecords(clock);
  const asked: string[] = [];
  const inQueue: { masked?: string; held?: readonly string[]; guarded?: string } = {};
  const service = new SecureCopyService({
    clock,
    runner: {
      run: async () => {
        throw new Error('a page copy runs no command');
      },
    },
    folders: { folderOf: async () => '/work' },
    exposure: { transcriptHolds: async () => 'clean' },
    masking,
    redact: async text => text,
    ...(wired
      ? {
          pages: {
            read: async (sessionId, key, target, part, attribute, queue) => {
              asked.push(`${sessionId}:${key}:${JSON.stringify(target)}:${part}:${attribute ?? ''}`);
              await queue.guard?.({ document: async () => 'loader-1' });
              if (queue.guard !== undefined) inQueue.guarded = 'yes';
              if (answer instanceof Error) throw answer;
              if (answer.ok) queue.seal(answer);
              inQueue.masked = masking.scrub(SESSION, `shown: ${TOKEN}`);
              inQueue.held = records.documents(SESSION, ['app']);
              return answer;
            },
          },
          pageHolds: records,
        }
      : {}),
  });
  return { clock, masking, records, service, asked, inQueue };
}

const fromPage = (extra: Partial<Extract<CopyCapture['source'], { kind: 'browser' }>> = {}): CopyCapture =>
  ({ name: 'gh', source: { kind: 'browser', key: 'app', ref: 'e12', read: 'text', ...extra } }) as CopyCapture;

const refusal = async (work: Promise<unknown>): Promise<SecureCopyError> => {
  const error = await work.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  should(error).be.instanceOf(SecureCopyError);
  return error as SecureCopyError;
};

describe('copying a page element', () => {
  it('should seal the trimmed value under the frame origin, mask it at once and say nothing of it', async () => {
    const { service, masking, asked } = world();

    const { copy, command } = await service.capture(SESSION, fromPage());

    should(copy).match({
      handle: 'sealed:gh',
      from: { kind: 'browser', origin: 'https://github.com', surface: 'app' },
      length: TOKEN.length,
      exposure: { transcript: 'clean', pageReadBeforeCapture: false },
    });
    should(copy.from.editable).be.undefined();
    should(command).be.undefined();
    should(asked).eql([`${SESSION}:app:{"kind":"ref","ref":"e12"}:text:`]);
    should(masking.scrub(SESSION, `the token is ${TOKEN}`)).equal('the token is [sealed:gh]');
    should(service.open(SESSION, 'gh')).equal(TOKEN);
    should(JSON.stringify(copy)).not.containEql(TOKEN);
  });

  it("should mask the value and hold the page INSIDE the page's queue, before anything queued behind the copy runs", async () => {
    const { service, inQueue } = world();

    await service.capture(SESSION, fromPage(), { guard: async () => undefined });

    should(inQueue).eql({ guarded: 'yes', masked: 'shown: [sealed:gh]', held: ['loader-1'] });
  });

  it("should refuse the copy when the queue's guard refuses, reading and holding nothing", async () => {
    const { service, inQueue, masking } = world();

    const refused = await service
      .capture(SESSION, fromPage(), {
        guard: async () => {
          throw new Error('the owner took the page over');
        },
      })
      .then(
        () => undefined,
        (error: unknown) => error as Error,
      );

    should(refused?.message).equal('the owner took the page over');
    should(inQueue).eql({});
    should(masking.scrub(SESSION, TOKEN)).equal(TOKEN);
  });

  it('should mask the value however a page snapshot lays it out: its lines, its collapsed white space, escaped', async () => {
    const codes = 'RECOVERY-aaaa-1111\n  RECOVERY-bbbb-2222\n\tRECOVERY "cccc" 3333';
    const { service, masking } = world({ ...READ, value: codes });

    await service.capture(SESSION, fromPage());

    should(masking.scrub(SESSION, 'list: RECOVERY-bbbb-2222')).equal('list: [sealed:gh]');
    should(masking.scrub(SESSION, 'text: RECOVERY-aaaa-1111 RECOVERY-bbbb-2222 RECOVERY "cccc" 3333')).equal(
      'text: [sealed:gh]',
    );
    should(masking.scrub(SESSION, 'yaml: "RECOVERY \\"cccc\\" 3333"')).equal('yaml: "[sealed:gh]"');
  });

  it("should not mask a short line of a copied container on its own, so the page's buttons stay findable", async () => {
    const { service, masking } = world({ ...READ, value: `${TOKEN}\nDone\nCopy it` });

    await service.capture(SESSION, fromPage());

    should(masking.scrub(SESSION, 'button "Done", button "Copy it"')).equal('button "Done", button "Copy it"');
    should(masking.scrub(SESSION, `token ${TOKEN}`)).equal('token [sealed:gh]');
  });

  it("should mark a field's value, or an editable element's text, as editable: no rule matches what the agent typed", async () => {
    const field = world();
    const editable = world({ ...READ, editable: true });

    const value = await field.service.capture(SESSION, fromPage({ read: 'value' }));
    const text = await editable.service.capture(SESSION, fromPage());

    should([value.copy.from.editable, text.copy.from.editable]).eql([true, true]);
  });

  it('should name a selector, a part and an attribute as the agent did, and the frame a value really came from', async () => {
    const { service, asked } = world({ ...READ, frameOrigin: 'https://auth.example' });

    const { copy } = await service.capture(
      SESSION,
      fromPage({ ref: undefined, selector: '#token', read: 'attribute', attribute: 'data-token' }),
    );

    should(asked).eql([`${SESSION}:app:{"kind":"selector","selector":"#token"}:attribute:data-token`]);
    should(copy.from.origin).equal('https://auth.example');
  });

  it('should hold pictures of the page while it shows that document, until the mask ends, and drop them with the session', async () => {
    const { service, records, clock } = world();

    await service.capture(SESSION, fromPage());
    const held = records.documents(SESSION, ['app']);
    const byId = records.documents(SESSION, [undefined, 'page-1']);
    clock.ms += (COPY_DEFAULT_LIFETIME_SECONDS + COPY_AFTER_MASK_SECONDS) * 1000;
    const after = records.documents(SESSION, ['app']);
    clock.ms -= 1000;
    service.drop(SESSION);

    should([held, byId, after]).eql([['loader-1'], ['loader-1'], []]);
    should(records.documents(SESSION, ['app'])).eql([]);
  });

  it('should end the page hold with the mask when the copy is discarded', async () => {
    const { service, records, clock } = world();
    await service.capture(SESSION, fromPage());

    service.discard(SESSION, 'gh');
    clock.ms += COPY_AFTER_MASK_SECONDS * 1000;

    should(records.documents(SESSION, ['app'])).eql([]);
  });

  it('should say the agent had read that very document, asking only after the read, and not another one', async () => {
    const seen = world();
    const other = world();
    const asked: string[] = [];

    const before = await seen.service.capture(SESSION, fromPage(), {
      seen: () => {
        asked.push('seen');
        return ['loader-0', 'loader-1'];
      },
    });
    const elsewhere = await other.service.capture(SESSION, fromPage(), { seen: () => ['loader-0'] });

    should(before.copy.exposure.pageReadBeforeCapture).be.true();
    should(elsewhere.copy.exposure.pageReadBeforeCapture).be.false();
    should(asked).eql(['seen']);
  });

  it('should refuse an element that is gone, empty, changed, too short or too long, holding nothing', async () => {
    const cases: readonly CopyPageRead[] = [
      { ok: false, reason: 'missing' },
      { ok: false, reason: 'empty' },
      { ok: false, reason: 'changed' },
      { ...READ, value: '  ab  ' },
      { ...READ, value: 'x'.repeat(16_385) },
    ];

    const errors = [];
    for (const answer of cases) {
      const { service, masking, records } = world(answer);
      errors.push((await refusal(service.capture(SESSION, fromPage()))).message);
      should(masking.scrub(SESSION, 'x'.repeat(40))).equal('x'.repeat(40));
      should(records.documents(SESSION, ['app'])).eql([]);
    }

    should(errors).eql([
      'That element is not on the page (read the page again for a fresh ref); nothing was copied.',
      'That element holds nothing to copy; nothing was copied.',
      'The page moved to another document while it was read; nothing was copied.',
      'The element holds fewer than 4 characters: too short to seal and mask safely; nothing was copied.',
      'The element holds more than 16384 bytes; nothing was copied.',
    ]);
  });

  it('should refuse a page copy with no browser wired, and a clipboard copy, which is the next phase', async () => {
    const { service } = world(READ, false);

    const page = await refusal(service.capture(SESSION, fromPage()));
    const clipboard = await refusal(
      service.capture(SESSION, { name: 'gh', source: { kind: 'clipboard', key: 'app' } }),
    );

    should([page.code, clipboard.code]).eql(['unavailable', 'unavailable']);
  });
});

describe('PageCopyRecords', () => {
  it('should keep what the agent read by document, once each, for every name the page has', () => {
    const records = new PageCopyRecords(new Clock());

    records.saw(SESSION, ['app', 'page-1'], 'loader-1');
    records.saw(SESSION, ['app', undefined, ''], 'loader-2');
    records.saw(SESSION, ['app', 'page-1'], 'loader-1');
    records.saw('s2', ['app'], 'loader-9');

    should(records.seen(SESSION, ['app'])).eql(['loader-2', 'loader-1']);
    should(records.seen(SESSION, ['page-1'])).eql(['loader-1']);
    should(records.seen(SESSION, ['other'])).eql([]);
    should(records.sessions()).eql([SESSION, 's2']);
  });

  it('should bound what the agent read per session, and never drop a live hold to make room', () => {
    const clock = new Clock();
    const records = new PageCopyRecords(clock);

    for (let index = 0; index < 100; index += 1) {
      records.saw(SESSION, ['app'], `loader-${String(index)}`);
      records.hold(SESSION, `copy-${String(index)}`, ['app'], `loader-${String(index)}`, clock.ms + 1000);
    }

    should(records.seen(SESSION, ['app'])).have.length(64);
    should(records.documents(SESSION, ['app'])).have.length(100);
  });

  it("should end only that copy's holds, never later than they were", () => {
    const clock = new Clock();
    const records = new PageCopyRecords(clock);
    records.hold(SESSION, 'gh', ['app'], 'loader-1', clock.ms + 10_000);
    records.hold(SESSION, 'npm', ['app'], 'loader-2', clock.ms + 10_000);

    records.retime(SESSION, 'gh', clock.ms + 1_000);
    records.retime(SESSION, 'npm', clock.ms + 60_000);
    records.retime('s2', 'gh', clock.ms);
    clock.ms += 5_000;

    should(records.documents(SESSION, ['app'])).eql(['loader-2']);
  });
});

describe('BrowserCopyPages', () => {
  it("should guard, read and seal in the page's own queue, and name the page it read", async () => {
    const calls: string[] = [];
    const answer: BrowserCopyRead = { ...READ };
    const guard = async () => void calls.push('guard');
    const pages = new BrowserCopyPages({
      copyOnPage: async (sessionId, key, { work, guard: queueGuard }) => {
        calls.push(`queue:${sessionId}:${key}`);
        await queueGuard?.({ document: async () => 'loader-1' });
        return await work(
          {
            copyRead: async (pageId, target, part, attribute) => {
              calls.push(`read:${pageId}:${JSON.stringify(target)}:${part}:${attribute ?? ''}`);
              return calls.filter(call => call.startsWith('read')).length > 2 ? { ok: false, reason: 'empty' } : answer;
            },
          },
          'page-1',
        );
      },
    });
    const seal = (read: unknown) => void calls.push(`seal:${(read as { pageId: string }).pageId}`);

    const found = await pages.read(SESSION, 'app', { kind: 'ref', ref: 'e1' }, 'value', undefined, { guard, seal });
    const attribute = await pages.read(SESSION, 'app', { kind: 'ref', ref: 'e1' }, 'attribute', 'title', { seal });
    const empty = await pages.read(SESSION, 'app', { kind: 'ref', ref: 'e1' }, 'text', undefined, { seal });

    should([found, attribute]).eql([
      { ...READ, pageId: 'page-1' },
      { ...READ, pageId: 'page-1' },
    ]);
    should(empty).eql({ ok: false, reason: 'empty' });
    should(calls.slice(0, 4)).eql([
      `queue:${SESSION}:app`,
      'guard',
      'read:page-1:{"kind":"ref","ref":"e1"}:value:',
      'seal:page-1',
    ]);
    should(calls.filter(call => call.startsWith('seal'))).have.length(2);
  });
});
