import { describe, it } from 'bun:test';
import type { InputTargetFacts } from '@ferretry/core-vault/contract';
import type { AgentControlReader, FerretId } from '@ferretry/kernel/contract';
import should from 'should';
import { type PageInputHost, PageInputTarget, throwawayValue } from '../../../daemon/target/adapter.ts';
import type {
  BrowserInputFacts,
  BrowserInputFieldsPort,
  BrowserInputObservation,
  BrowserInputOutcome,
} from '../../../daemon/target/lib/contracts.ts';

/** The owner's "What agents may control" switches with every kind on (the fixture default). */
const ALL_ON = (): AgentControlReader => ({ allows: async () => true });

/** A ferret's pages are asked for by the ferret's id. */
const S1 = 's1' as FerretId;

/** A terminal's facts: never a page's, so a page target refuses them. */
const FACTS: Extract<InputTargetFacts, { readonly kind: 'terminal' }> = {
  kind: 'terminal',
  paneProof: { paneId: '%3', pid: 4242, sessionCreated: 1_700_000_000 },
  foreground: { pid: 4300, pgid: 4300, comm: 'sudo', argv: 'sudo -v' },
  echo: 'off',
  cursorRow: 1,
  promptLine: '[sudo] password for kirin:',
  promptLineDigest: 'a'.repeat(64),
  program: 'sudo',
  canonical: true,
  recognisedConsumer: true,
};

const FACTS_PAGE: BrowserInputFacts = {
  kind: 'page',
  pageId: 'page-1',
  origin: 'https://example.test',
  secure: true,
  navigationId: 'loader-1',
  fields: [
    {
      fieldId: 'password',
      frameOrigin: 'https://example.test',
      frameId: 'main',
      backendNodeId: 9,
      field: { tag: 'input', type: 'password' },
      box: { x: 0, y: 0, w: 10, h: 10 },
      visible: true,
    },
  ],
};
const APP = { kind: 'page', key: 'app' } as const;
const FIELDS = [{ id: 'password', element: { kind: 'ref', ref: 'e3' } }] as const;

/** The browser host and its page, faked: what it was asked and what it answers. */
function host(
  options: {
    pageId?: string;
    refuse?: boolean;
    hostless?: boolean;
    observation?: BrowserInputObservation;
    refound?: BrowserInputObservation;
    /** This browser cannot check or empty a field when a grant fill's hold ends. */
    clearless?: boolean;
    /** This browser can't arm the pagehide clear (this browser cannot), or refuses to now. */
    armless?: boolean;
    arm?: 'armed' | 'refused' | Error;
    cleared?: 'cleared' | 'moved' | 'unknown' | Error;
  } = {},
) {
  const calls: string[] = [];
  let outcome: BrowserInputOutcome | Error = 'typed';
  const port: BrowserInputFieldsPort = {
    inputDocument: async pageId => {
      calls.push(`document:${pageId}`);
      return options.hostless === true
        ? { navigationId: 'loader-2' }
        : { navigationId: 'loader-2', host: 'accounts.example.test' };
    },
    inputProbe: async (pageId, _expected, fieldIds, dummy) => {
      calls.push(`probe:${pageId}:${fieldIds.join(',')}:${dummy}`);
      return 'hidden';
    },
    inputText: async pageId => {
      calls.push(`text:${pageId}`);
      return 'Welcome back';
    },
    inputObserve: async (pageId, fields) => {
      calls.push(`observe:${pageId}:${fields.map(field => `${field.id}=${JSON.stringify(field.target)}`).join(',')}`);
      return options.observation ?? { ok: true, facts: FACTS_PAGE };
    },
    inputRefind: async (pageId, expected, fields) => {
      calls.push(
        `refind:${pageId}:${expected.navigationId}:${fields.map(field => `${field.id}=${JSON.stringify(field.target)}`).join(',')}`,
      );
      return options.refound ?? { ok: true, facts: FACTS_PAGE };
    },
    inputShot: async pageId => {
      calls.push(`shot:${pageId}`);
      return { pngBase64: 'AAAA', clip: { x: 0, y: 0, w: 10, h: 10 } };
    },
    inputType: async (pageId, _expected, values, submit) => {
      calls.push(`type:${pageId}:${values.map(value => value.field).join(',')}:${submit}`);
      if (outcome instanceof Error) throw outcome;
      return outcome;
    },
    ...(options.armless === true
      ? {}
      : {
          inputArm: async (pageId: string, _expected: unknown, fieldIds: readonly string[]) => {
            calls.push(`arm:${pageId}:${fieldIds.join(',')}`);
            if (options.arm instanceof Error) throw options.arm;
            return options.arm ?? 'armed';
          },
        }),
    ...(options.clearless === true
      ? {}
      : {
          inputClear: async (
            pageId: string,
            job: { readonly fields: readonly { readonly backendNodeId: number }[] },
          ) => {
            calls.push(`clear:${pageId}:${job.fields.map(field => field.backendNodeId).join(',')}`);
            if (options.cleared instanceof Error) throw options.cleared;
            return options.cleared ?? 'moved';
          },
        }),
  };
  const pages: PageInputHost = {
    inputOnPage: async (sessionId, key, work) => {
      calls.push(`page:${sessionId}:${key}`);
      if (options.refuse === true) throw new Error('no such page in this session');
      return await work(port, options.pageId ?? 'page-1');
    },
  };
  return {
    target: new PageInputTarget(pages, ALL_ON),
    calls,
    answer: (next: BrowserInputOutcome | Error) => {
      outcome = next;
    },
  };
}

describe('PageInputTarget', () => {
  it('should ask the browser about each field by the pointer the agent gave, and name the page by its id', async () => {
    const { target, calls } = host();

    const seen = await target.observe(S1, APP, FIELDS);

    should(seen).eql({ ok: true, facts: FACTS_PAGE, names: ['page-1'] });
    should(calls).eql(['page:s1:app', 'observe:page-1:password={"kind":"ref","ref":"e3"}']);
  });

  it('I111 should call a field the page lacks, a page that is not the session’s, or a stale page id gone', async () => {
    should(await host({ observation: { ok: false, missing: 'password' } }).target.observe(S1, APP, FIELDS)).eql({
      ok: false,
      reason: 'target_gone',
    });
    should(await host({ refuse: true }).target.observe(S1, APP, FIELDS)).eql({ ok: false, reason: 'target_gone' });
    should(await host({ pageId: 'page-2' }).target.observe(S1, APP, FIELDS)).eql({
      ok: false,
      reason: 'target_gone',
    });
  });

  it('should take no terminal and no field without an element', async () => {
    const { target, calls } = host();

    should(await target.observe(S1, { kind: 'terminal', key: 'dev' }, FIELDS)).eql({
      ok: false,
      reason: 'unsupported',
    });
    should(await target.observe(S1, APP, [{ id: 'password' }])).eql({ ok: false, reason: 'unsupported' });
    should(calls).eql([]);
  });

  it('I63 should type only into the page the card showed, and say what came of it', async () => {
    const same = host();
    const moved = host({ pageId: 'page-2' });

    const typed = await same.target.type(S1, APP, [{ field: 'password', text: 'x' }], true, FACTS_PAGE);
    const changed = await moved.target.type(S1, APP, [{ field: 'password', text: 'x' }], true, FACTS_PAGE);

    should(typed).equal('typed');
    should(same.calls).eql(['page:s1:app', 'type:page-1:password:true']);
    should(changed).equal('target_changed');
    should(moved.calls).eql(['page:s1:app']);
  });

  it('should call a page that is gone before the write gone, and a write that failed once begun uncertain', async () => {
    const gone = host({ refuse: true });
    const broken = host();
    broken.answer(new Error('the worker fell over'));

    should(await gone.target.type(S1, APP, [{ field: 'password', text: 'x' }], false, FACTS_PAGE)).equal('target_gone');
    should(await broken.target.type(S1, APP, [{ field: 'password', text: 'x' }], false, FACTS_PAGE)).equal('uncertain');
    should(await gone.target.type(S1, APP, [], false, FACTS as InputTargetFacts)).equal('target_gone');
  });

  it("I56 should look for the card's fields again on the same page, by the agent's pointers and the card's facts (#B100)", async () => {
    const moved = { ...FACTS_PAGE, navigationId: 'loader-3' };
    const { target, calls } = host({ refound: { ok: true, facts: moved } });

    should(await target.refind(S1, APP, FIELDS, FACTS_PAGE)).eql({ ok: true, facts: moved, names: ['page-1'] });
    should(calls).eql(['page:s1:app', 'refind:page-1:loader-1:password={"kind":"ref","ref":"e3"}']);
  });

  it('should call a re-find gone for another page, a field not found or not one, and a page that is not there', async () => {
    const elsewhere = host({ pageId: 'page-2' });
    const missing = host({ refound: { ok: false, missing: 'password' } });
    const ambiguous = host({ refound: { ok: false, ambiguous: 'password' } });
    const wrongPage = host({ refound: { ok: true, facts: { ...FACTS_PAGE, pageId: 'page-9' } } });
    const gone = { ok: false, reason: 'target_gone' };

    should(await elsewhere.target.refind(S1, APP, FIELDS, FACTS_PAGE)).eql(gone);
    should(elsewhere.calls).eql(['page:s1:app']);
    should(await missing.target.refind(S1, APP, FIELDS, FACTS_PAGE)).eql(gone);
    should(await ambiguous.target.refind(S1, APP, FIELDS, FACTS_PAGE)).eql(gone);
    should(await wrongPage.target.refind(S1, APP, FIELDS, FACTS_PAGE)).eql(gone);
    should(await host({ refuse: true }).target.refind(S1, APP, FIELDS, FACTS_PAGE)).eql(gone);
  });

  it("should re-find no terminal, no facts that are not a page's and no field without an element", async () => {
    const { target, calls } = host();

    should(await target.refind(S1, { kind: 'terminal', key: 'dev' }, FIELDS, FACTS_PAGE)).eql({
      ok: false,
      reason: 'unsupported',
    });
    should(await target.refind(S1, APP, FIELDS, FACTS as InputTargetFacts)).eql({ ok: false, reason: 'unsupported' });
    should(await target.refind(S1, APP, [{ id: 'password' }], FACTS_PAGE)).eql({ ok: false, reason: 'unsupported' });
    should(calls).eql([]);
  });

  it('I112 should picture the fields and tell the page’s document, and answer nothing when it cannot', async () => {
    const { target } = host();
    const refused = host({ refuse: true });

    should(await target.shoot(S1, APP, FACTS_PAGE)).eql({ pngBase64: 'AAAA', clip: { x: 0, y: 0, w: 10, h: 10 } });
    should(await host({ pageId: 'page-2' }).target.shoot(S1, APP, FACTS_PAGE)).be.undefined();
    should(await refused.target.shoot(S1, APP, FACTS_PAGE)).be.undefined();
    should(await target.shoot(S1, { kind: 'terminal', key: 'dev' }, FACTS)).be.undefined();
    should(await target.document(S1, 'app')).equal('loader-2');
    should(await refused.target.document(S1, 'app')).be.undefined();
  });
});

describe('PageInputTarget, for a saved login’s facts', () => {
  it('should say the page’s document and host, and its text, through the page’s own queue', async () => {
    const { target, calls } = host();
    should(await target.where(S1, 'app', ['app', 'page-1'])).deepEqual({
      navigationId: 'loader-2',
      host: 'accounts.example.test',
    });
    should(await target.text(S1, 'app', ['app', 'page-1'])).equal('Welcome back');
    should(calls).deepEqual(['page:s1:app', 'document:page-1', 'page:s1:app', 'text:page-1']);
  });

  it('should answer nothing for a page that is gone or does not say its host', async () => {
    should(await host({ refuse: true }).target.where(S1, 'app', ['app', 'page-1'])).be.undefined();
    should(await host({ refuse: true }).target.text(S1, 'app', ['app', 'page-1'])).be.undefined();
    should(await host({ hostless: true }).target.where(S1, 'app', ['app', 'page-1'])).be.undefined();
  });
});

describe('PageInputTarget pins its looks to the page typed into', () => {
  it('should say nothing about another page opened under the same name', async () => {
    const { target, calls } = host({ pageId: 'page-9' });
    should(await target.where(S1, 'app', ['app', 'page-1'])).be.undefined();
    should(await target.text(S1, 'app', ['app', 'page-1'])).be.undefined();
    should(calls).deepEqual(['page:s1:app', 'page:s1:app']);
  });
});

describe('the dummy probe through a page target', () => {
  it('I96 should probe the page the card was drawn from, in its queue, with a fresh throwaway value', async () => {
    const { target, calls } = host();
    should(await target.probe(S1, APP, FACTS_PAGE, ['password'])).equal('hidden');
    should(calls[0]).equal('page:s1:app');
    should(calls[1]).match(/^probe:page-1:password:~[a-z0-9]{2}$/u);
  });

  it('should abort for another page, a terminal, a refused page, or a browser that cannot probe', async () => {
    should(await host({ pageId: 'page-9' }).target.probe(S1, APP, FACTS_PAGE, ['password'])).equal('aborted');
    should(await host().target.probe(S1, { kind: 'terminal', key: 'dev' }, FACTS_PAGE, ['password'])).equal('aborted');
    should(await host({ refuse: true }).target.probe(S1, APP, FACTS_PAGE, ['password'])).equal('aborted');
  });

  it('should make a throwaway value of a tilde and two letters or digits, different each time', () => {
    const made = new Set(Array.from({ length: 20 }, () => throwawayValue()));
    for (const value of made) should(value).match(/^~[a-z0-9]{2}$/u);
    should(made.size).be.above(1);
  });
});

describe('PageInputTarget.pushNumber', () => {
  const READ = { origin: 'https://company.okta.com', navigationId: 'loader-1', provider: 'okta' } as const;
  const pages = (port: Partial<BrowserInputFieldsPort>, refuse = false): PageInputHost => ({
    inputOnPage: async (_session, _key, work) => {
      if (refuse) throw new Error('no such page in this session');
      return await work(port as BrowserInputFieldsPort, 'page-7');
    },
  });

  it('should read the number in the page’s own queue, with the page’s id', async () => {
    // Arrange
    const asked: unknown[] = [];
    const target = new PageInputTarget(
      pages({
        pushNumberRead: async pageId => {
          asked.push(pageId);
          return READ;
        },
      }),
      ALL_ON,
    );

    // Act
    const read = await target.pushNumber(S1, 'app');

    // Assert
    should(read).eql({ pageId: 'page-7', read: READ });
    should(asked).eql(['page-7']);
  });

  it('should answer nothing from a browser that cannot read one, a page that is not the session’s, or a failed read', async () => {
    // Arrange
    const unable = new PageInputTarget(pages({}), ALL_ON);
    const missing = new PageInputTarget(pages({ pushNumberRead: async () => READ }, true), ALL_ON);
    const failing = new PageInputTarget(
      pages({
        pushNumberRead: async () => {
          throw new Error('the worker went away');
        },
      }),
      ALL_ON,
    );

    // Act + Assert
    should(await unable.pushNumber(S1, 'app')).be.undefined();
    should(await missing.pushNumber(S1, 'app')).be.undefined();
    should(await failing.pushNumber(S1, 'app')).be.undefined();
  });
});

describe('PageInputTarget: a grant fill’s clear (R3a-4)', () => {
  const VALUES = [{ field: 'password', text: 'hunter2-hunter2' }];
  const JOB = {
    navigationId: 'loader-1',
    fields: [{ frameId: 'main', backendNodeId: 9 }],
  };

  it('I217 should arm the pagehide clear on the password fields first, in the same page turn, and only when asked', async () => {
    const armed = host();
    should(await armed.target.type(S1, APP, VALUES, true, FACTS_PAGE, { armClear: true })).equal('typed');
    should(armed.calls).eql(['page:s1:app', 'arm:page-1:password', 'type:page-1:password:true']);
    const plain = host();
    should(await plain.target.type(S1, APP, VALUES, true, FACTS_PAGE)).equal('typed');
    should(plain.calls).eql(['page:s1:app', 'type:page-1:password:true']);
  });

  it('I217 should type nothing when the browser refuses the arm, cannot arm (this browser cannot) or cannot clear', async () => {
    for (const options of [{ arm: 'refused' as const }, { armless: true }, { clearless: true }]) {
      const { target, calls } = host(options);
      should(await target.type(S1, APP, VALUES, true, FACTS_PAGE, { armClear: true })).equal('target_changed');
      should(calls.some(call => call.startsWith('type:'))).be.false();
    }
  });

  it('should ask a grant fill whether it may still go ahead inside the page turn, before arming and before typing', async () => {
    const first = host();
    should(await first.target.type(S1, APP, VALUES, true, FACTS_PAGE, { armClear: true, proceed: () => false })).equal(
      'target_changed',
    );
    should(first.calls).eql(['page:s1:app']);

    // Revoked while the arm ran: armed, but not a key typed.
    let asked = 0;
    const second = host();
    should(
      await second.target.type(S1, APP, VALUES, true, FACTS_PAGE, {
        armClear: true,
        proceed: () => {
          asked += 1;
          return asked === 1;
        },
      }),
    ).equal('target_changed');
    should(second.calls).eql(['page:s1:app', 'arm:page-1:password']);
  });

  it('I217 should check and empty the typed fields in the page’s own queue, and read anything odd as unknown', async () => {
    const { target, calls } = host({ cleared: 'cleared' });
    should(await target.arm(S1, APP, JOB)).equal('cleared');
    should(calls).eql(['page:s1:app', 'clear:page-1:9']);
    should(await host({ cleared: new Error('worker fell over') }).target.arm(S1, APP, JOB)).equal('unknown');
    should(await host({ clearless: true }).target.arm(S1, APP, JOB)).equal('unknown');
    should(await host({ refuse: true }).target.arm(S1, APP, JOB)).equal('unknown');
  });
});

describe("PageInputTarget: an owner's value Ferretry does not submit (secrev-1333 M1)", () => {
  const VALUES = [{ field: 'password', text: 'hunter2-hunter2' }];
  const typed = async (options: Parameters<typeof host>[0], values = VALUES) => {
    const said: boolean[] = [];
    const world = host(options);
    const outcome = await world.target.type(S1, APP, values, false, FACTS_PAGE, {
      armClear: 'try',
      armed: armed => void said.push(armed),
    });
    return { outcome, said, calls: world.calls };
  };

  it('should arm the pagehide clear when it can, say so, and type in the same page turn', async () => {
    const { outcome, said, calls } = await typed({});
    should(outcome).equal('typed');
    should(said).eql([true]);
    should(calls).eql(['page:s1:app', 'arm:page-1:password', 'type:page-1:password:false']);
  });

  it('should still type, and say it is not armed, when the browser refuses, cannot arm or throws', async () => {
    for (const options of [{ arm: 'refused' as const }, { armless: true }, { arm: new Error('worker fell over') }]) {
      const { outcome, said, calls } = await typed(options);
      should(outcome).equal('typed');
      should(said).eql([false]);
      should(calls.at(-1)).equal('type:page-1:password:false');
    }
  });

  it('should not arm, and say so, when no value goes into a password field', async () => {
    const { outcome, said, calls } = await typed({}, [{ field: 'email', text: 'kirin@example.test' }]);
    should(outcome).equal('typed');
    should(said).eql([false]);
    should(calls.some(call => call.startsWith('arm:'))).be.false();
  });
});
