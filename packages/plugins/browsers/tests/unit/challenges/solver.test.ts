import { describe, it } from 'bun:test';
import { AuditDetailSchema, type AuditDraft } from '@ferretry/core-gate/contract';
import { OwnSecret, type OwnSecretRefusal } from '@ferretry/kernel/contract';
import should from 'should';
import { AUDIT, BrowsersConfigSchema, CAPTCHA_MONTHLY_CAP_MICROS, type CaptchaSpend } from '../../../contract/index.ts';
import { browsersLoosens } from '../../../contract/config-loosens.ts';
import {
  CapSolver,
  type CapSolverPorts,
  type CaptchaPagePort,
  CaptchaSolving,
  captchaProxyOf,
  type CaptchaSolveRequest,
  type CaptchaSolverPort,
  HUMAN_CHECK_NOTE,
  SOLVE_COST_MICROS,
  SOLVING_NOTE,
  solveCheck,
  SpendLedger,
} from '../../../daemon/challenges/solver.ts';
import { workerInputFields } from '../../../daemon/target/lib/worker-port.ts';

const KEY = 'CAP-0123456789ABCDEFSECRETKEY';
const TOKEN = '0.TOKEN-from-the-vendor-abcdefghijklmnop';
const SITE_KEY = '0x4AAAAAAAdemoSiteKeyForTurnstile';
const PAGE_URL = 'https://app.example.com/#/login?code=abc';

/** An in-memory `kernel.state.update` over one document. */
function memoryState(initial?: CaptchaSpend) {
  const box: { value: CaptchaSpend | undefined } = { value: initial };
  return {
    box,
    update: async (_file: unknown, edit: (current: CaptchaSpend | undefined) => CaptchaSpend) => {
      const next = edit(box.value);
      box.value = next;
      return { ok: true as const, value: next };
    },
  };
}

const NOW = '2026-11-24T10:00:00.000Z';

/** What the adapter sends the vendor: the key, a task id or a task. */
interface SentBody {
  readonly clientKey?: string;
  readonly taskId?: string;
  readonly task?: { readonly type?: string; readonly proxyLogin?: string };
}

/** A fake CapSolver: what each path answers, and every request body it saw. */
function fakeVendor(
  answers: { create?: unknown; results?: unknown[]; fail?: 'status' | 'throw' | 'poll-status' | 'poll-throw' } = {},
) {
  const seen: { path: string; body: SentBody }[] = [];
  const results = [...(answers.results ?? [{ errorId: 0, status: 'ready', solution: { token: TOKEN } }])];
  const fetch: CapSolverPorts['fetch'] = async (url, init) => {
    if (answers.fail === 'throw') throw new Error(`could not reach ${url} with ${String(init.body)}`);
    const path = new URL(url).pathname;
    seen.push({ path, body: JSON.parse(String(init.body)) as SentBody });
    if (answers.fail === 'status') return new Response('no', { status: 500 });
    // A fake that takes the task and then goes wrong on the second poll.
    if (path === '/getTaskResult' && seen.filter(each => each.path === path).length > 1) {
      if (answers.fail === 'poll-throw') throw new Error(`could not reach ${url} with ${String(init.body)}`);
      if (answers.fail === 'poll-status') return new Response('no', { status: 502 });
    }
    const body = path === '/createTask' ? (answers.create ?? { errorId: 0, taskId: 'task-1' }) : results.shift();
    return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
  };
  return { seen, fetch };
}

function capSolver(
  vendor: ReturnType<typeof fakeVendor>,
  options: {
    readonly state?: ReturnType<typeof memoryState>;
    readonly secret?: OwnSecret | { readonly refused: OwnSecretRefusal };
    readonly deadlineMilliseconds?: number;
  } = {},
) {
  const state = options.state ?? memoryState();
  const solver = new CapSolver({
    fetch: vendor.fetch,
    secret: async () => options.secret ?? new OwnSecret('CAPSOLVER_API_KEY', KEY),
    ledger: new SpendLedger(state as never, () => NOW),
    sleep: async () => undefined,
    origin: 'http://127.0.0.1:1',
    pollMilliseconds: 1_000,
    ...(options.deadlineMilliseconds === undefined ? {} : { deadlineMilliseconds: options.deadlineMilliseconds }),
  });
  return { solver, state };
}

const TURNSTILE: CaptchaSolveRequest = { kind: 'turnstile', siteKey: SITE_KEY, pageUrl: PAGE_URL };

describe('the CapSolver adapter', () => {
  it('should create a task, poll it and answer the token, with the key only in the vendor request body', async () => {
    const vendor = fakeVendor({
      results: [
        { errorId: 0, status: 'processing' },
        { errorId: 0, status: 'ready', solution: { token: TOKEN } },
      ],
    });
    const { solver, state } = capSolver(vendor);

    const answer = await solver.solve({ ...TURNSTILE, action: 'login' });

    should(answer).eql({ token: TOKEN });
    should(vendor.seen.map(call => call.path)).eql(['/createTask', '/getTaskResult', '/getTaskResult']);
    should(vendor.seen[0]?.body).eql({
      clientKey: KEY,
      task: {
        type: 'AntiTurnstileTaskProxyLess',
        websiteURL: PAGE_URL,
        websiteKey: SITE_KEY,
        metadata: { action: 'login' },
      },
    });
    should(vendor.seen[1]?.body).eql({ clientKey: KEY, taskId: 'task-1' });
    should(state.box.value).eql({ month: '2026-11', micros: SOLVE_COST_MICROS.turnstile });
  });

  it('should ask for each kind of check by the vendor’s own task and read its answer from the field that kind uses', async () => {
    const proxy = { type: 'http', host: '203.0.113.9', port: 8080, login: 'u', password: 'p' } as const;
    const kinds = [
      ['recaptcha-v2', {}, 'ReCaptchaV2TaskProxyLess'],
      ['recaptcha-v3', { action: 'submit' }, 'ReCaptchaV3TaskProxyLess'],
      ['hcaptcha', {}, 'HCaptchaTaskProxyLess'],
    ] as const;
    for (const [kind, extra, type] of kinds) {
      const vendor = fakeVendor({
        results: [{ errorId: 0, status: 'ready', solution: { gRecaptchaResponse: TOKEN } }],
      });
      const answer = await capSolver(vendor).solver.solve({ kind, siteKey: SITE_KEY, pageUrl: PAGE_URL, ...extra });
      should(answer).eql({ token: TOKEN });
      should(vendor.seen[0]?.body.task?.type).equal(type);
    }
    const proxied = fakeVendor();
    await capSolver(proxied).solver.solve({ kind: 'recaptcha-v2', siteKey: SITE_KEY, pageUrl: PAGE_URL, proxy });
    should(proxied.seen[0]?.body.task).eql({
      type: 'ReCaptchaV2Task',
      websiteURL: PAGE_URL,
      websiteKey: SITE_KEY,
      proxyType: 'http',
      proxyAddress: '203.0.113.9',
      proxyPort: 8080,
      proxyLogin: 'u',
      proxyPassword: 'p',
    });
    const bare = fakeVendor();
    await capSolver(bare).solver.solve({
      kind: 'hcaptcha',
      siteKey: SITE_KEY,
      pageUrl: PAGE_URL,
      proxy: { type: 'socks5', host: 'h', port: 1 },
    });
    should(bare.seen[0]?.body.task?.proxyLogin).be.undefined();
  });

  it('should refuse past the monthly cap with a plain sentence, call the vendor not at all, and start a new month at zero', async () => {
    const full = memoryState({ month: '2026-11', micros: CAPTCHA_MONTHLY_CAP_MICROS - 100 });
    const vendor = fakeVendor();
    const { solver } = capSolver(vendor, { state: full });

    const refused = await solver.solve(TURNSTILE);

    should(refused).eql({
      refused: 'cap',
      reason: 'The captcha solver has used its $5.00 for this month; it starts again on the 1st.',
    });
    should(vendor.seen).eql([]);
    should(full.box.value?.micros).equal(CAPTCHA_MONTHLY_CAP_MICROS - 100);
    should(await solver.ready()).be.undefined();
    should(
      await capSolver(vendor, {
        state: memoryState({ month: '2026-11', micros: CAPTCHA_MONTHLY_CAP_MICROS }),
      }).solver.ready(),
    ).eql({
      refused: 'cap',
      reason: 'The captcha solver has used its $5.00 for this month; it starts again on the 1st.',
    });

    const lastMonth = capSolver(fakeVendor(), {
      state: memoryState({ month: '2026-10', micros: CAPTCHA_MONTHLY_CAP_MICROS }),
    });
    should(await lastMonth.solver.ready()).be.undefined();
    should(await lastMonth.solver.solve(TURNSTILE)).eql({ token: TOKEN });
    should(lastMonth.state.box.value).eql({
      month: '2026-11',
      micros: SOLVE_COST_MICROS.turnstile,
      earlier: { '2026-10': CAPTCHA_MONTHLY_CAP_MICROS },
    });
  });

  it('should refuse plainly, naming the fix and no value, when there is no key, and call the vendor not at all', async () => {
    for (const why of ['not_declared', 'not_configured', 'unknown'] as const) {
      const vendor = fakeVendor();
      const { solver } = capSolver(vendor, { secret: { refused: why } });
      const answer = await solver.solve(TURNSTILE);
      should(answer).have.property('refused', 'no-key');
      should(String((answer as { reason: string }).reason)).match(/solver/);
      should(await solver.ready()).have.property('refused', 'no-key');
      should(vendor.seen).eql([]);
    }
    const unset = await capSolver(fakeVendor(), { secret: { refused: 'not_configured' } }).solver.solve(TURNSTILE);
    should((unset as { reason: string }).reason).containEql('${secret:CAPSOLVER_API_KEY}');
  });

  it('should give a failed task’s spend back and say why in the vendor’s code only', async () => {
    const cases: [ReturnType<typeof fakeVendor>, string][] = [
      [
        fakeVendor({ create: { errorId: 1, errorCode: 'ERROR_KEY_DENIED_ACCESS' } }),
        'The solver did not take the check (ERROR_KEY_DENIED_ACCESS).',
      ],
      [
        fakeVendor({ create: { errorId: 1, errorCode: `bad ${KEY}!` } }),
        'The solver did not take the check (UNKNOWN).',
      ],
      [
        fakeVendor({ results: [{ errorId: 1, errorCode: 'ERROR_CAPTCHA_UNSOLVABLE' }] }),
        'The solver could not solve the check (ERROR_CAPTCHA_UNSOLVABLE).',
      ],
      [fakeVendor({ fail: 'status' }), 'The solver could not be reached.'],
      [fakeVendor({ fail: 'throw' }), 'The solver could not be reached.'],
    ];
    for (const [vendor, reason] of cases) {
      const { solver, state } = capSolver(vendor);
      should(await solver.solve(TURNSTILE)).eql({ refused: 'failed', reason });
      should(state.box.value?.micros).equal(0);
    }
  });

  it('should keep the reservation once the vendor has a task id: it may still finish and charge', async () => {
    const processing = Array.from({ length: 5 }, () => ({ errorId: 0, status: 'processing' }));
    const cases: [ReturnType<typeof fakeVendor>, string, number?][] = [
      [fakeVendor({ results: processing }), 'The solver did not answer in time.', 2_000],
      [
        fakeVendor({ results: [{ errorId: 0, status: 'ready', solution: {} }] }),
        'The solver answered without a token.',
      ],
      [
        fakeVendor({ results: [{ errorId: 0, status: 'processing' }], fail: 'poll-status' }),
        'The solver could not be reached.',
      ],
      [
        fakeVendor({ results: [{ errorId: 0, status: 'processing' }], fail: 'poll-throw' }),
        'The solver could not be reached.',
      ],
    ];
    for (const [vendor, reason, deadline] of cases) {
      const { solver, state } = capSolver(vendor, deadline === undefined ? {} : { deadlineMilliseconds: deadline });
      should(await solver.solve(TURNSTILE)).eql({ refused: 'failed', reason });
      should(state.box.value?.micros).equal(SOLVE_COST_MICROS.turnstile);
      should(vendor.seen[0]?.path).equal('/createTask');
    }
  });

  it('should refuse, not spend, when the spending record cannot be read', async () => {
    const solver = new CapSolver({
      fetch: fakeVendor().fetch,
      secret: async () => new OwnSecret('CAPSOLVER_API_KEY', KEY),
      ledger: new SpendLedger({ update: async () => ({ ok: false }) } as never, () => NOW),
      sleep: async () => undefined,
    });
    should(await solver.solve(TURNSTILE)).have.property('refused', 'cap');
  });

  it('should never put the key in a refusal, the secret’s printed form or its JSON', () => {
    const secret = new OwnSecret('CAPSOLVER_API_KEY', KEY);
    for (const shown of [String(secret), JSON.stringify(secret), `${secret.toString()}`])
      should(shown).not.containEql(KEY);
  });
});

describe('the spend ledger', () => {
  it('should keep every month’s spend when the clock moves back and forward again', async () => {
    const state = memoryState();
    const clock = { now: '2026-11-24T10:00:00.000Z' };
    const ledger = new SpendLedger(state as never, () => clock.now);
    should(await ledger.reserve(500, 1_000)).equal('reserved');
    clock.now = '2026-10-31T23:00:00.000Z';
    should(await ledger.spent()).equal(0);
    should(await ledger.reserve(100, 1_000)).equal('reserved');
    should(await ledger.spent()).equal(100);
    await ledger.release(40);
    clock.now = '2026-11-24T10:00:01.000Z';
    should(await ledger.spent()).equal(500);
    clock.now = '2026-10-31T23:00:00.000Z';
    should(await ledger.spent()).equal(60);
  });

  it('should still read a file written before months were kept, and keep a year of them', async () => {
    const state = memoryState({ month: '2026-11', micros: 300 });
    const clock = { now: '2026-11-24T10:00:00.000Z' };
    const ledger = new SpendLedger(state as never, () => clock.now);
    should(await ledger.spent()).equal(300);
    for (let month = 1; month <= 12; month += 1) {
      clock.now = `2027-${String(month).padStart(2, '0')}-02T10:00:00.000Z`;
      await ledger.reserve(1, 1_000);
    }
    const kept = Object.keys({ ...state.box.value?.earlier, [state.box.value?.month ?? '']: 0 });
    should(kept).have.length(12);
    should(kept).not.containEql('2026-11');
  });

  it('should hold a reservation, give it back, and count only the current month', async () => {
    const state = memoryState();
    const ledger = new SpendLedger(state as never, () => NOW);
    should(await ledger.reserve(900, 1_000)).equal('reserved');
    should(await ledger.reserve(200, 1_000)).equal('cap');
    should(await ledger.spent()).equal(900);
    await ledger.release(400);
    should(await ledger.spent()).equal(500);
    await ledger.release(10_000);
    should(await ledger.spent()).equal(0);
    state.box.value = { month: '2026-10', micros: 700 };
    should(await ledger.spent()).equal(0);
    await ledger.release(5);
    should(state.box.value).eql({ month: '2026-11', micros: 0, earlier: { '2026-10': 700 } });
  });
});

// ─── what triggers it ────────────────────────────────────────────────────────────────────────────────────────

const WIDGET = { kind: 'turnstile', siteKey: SITE_KEY, pageUrl: PAGE_URL, action: 'login' } as const;

function harness(options: {
  readonly stealth?: boolean;
  readonly widget?:
    | { readonly kind: 'turnstile'; readonly siteKey: string; readonly pageUrl: string; readonly action?: string }
    | undefined
    | Error;
  readonly solver?: Partial<CaptchaSolverPort>;
  readonly taken?: boolean;
  readonly auditFails?: boolean;
  readonly proxy?: ReturnType<typeof captchaProxyOf>;
}) {
  const injected: { page: string; kind: string; token: string }[] = [];
  const injectedAt: string[] = [];
  const audits: AuditDraft[] = [];
  const failures: string[] = [];
  const asked: CaptchaSolveRequest[] = [];
  const clock = { now: 1_000_000 };
  let probes = 0;
  const state = { widget: options.widget };
  const page: CaptchaPagePort = {
    captchaProbe: async () => {
      probes += 1;
      if (state.widget instanceof Error) throw state.widget;
      return state.widget;
    },
    captchaInject: async (pageId, answer) => {
      injected.push({ page: pageId, kind: answer.kind, token: answer.token });
      injectedAt.push(answer.pageUrl);
      return options.taken ?? true;
    },
  };
  const solver: CaptchaSolverPort = {
    vendor: 'capsolver',
    ready: async () => undefined,
    solve: async request => {
      asked.push(request);
      return { token: TOKEN };
    },
    ...options.solver,
  };
  const solving = new CaptchaSolving({
    stealth: () => options.stealth ?? true,
    solver,
    onPage: async (_session, pageId, work) => await work(page, pageId),
    proxy: () => options.proxy,
    audit: async draft => {
      if (options.auditFails === true) throw new Error('the log is full');
      audits.push(draft);
    },
    nowMs: () => clock.now,
    failed: message => failures.push(message),
  });
  return { solving, injected, injectedAt, audits, failures, asked, clock, state, probes: () => probes };
}

/** Waits for the background solve the way a tool call that comes later would find it done. */
const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
  await new Promise(resolve => setTimeout(resolve, 5));
};

describe('solving a check a page shows', () => {
  it('should do nothing at all when stealth is not in effect', async () => {
    const { solving, injected, asked } = harness({ stealth: false });
    should(await solving.begin('s1', 'p1')).eql({ kind: 'off' });
    await settle();
    should(injected).eql([]);
    should(asked).eql([]);
  });

  it('should solve in the background, hand the token to the page, and audit the outcome with no secret in it', async () => {
    const { solving, injected, audits, asked, clock } = harness({
      widget: WIDGET,
      proxy: { type: 'socks5', host: '203.0.113.7', port: 1080 },
    });

    should(await solving.begin('s1', 'p1')).eql({ kind: 'solving' });
    should(await solving.begin('s1', 'p1')).eql({ kind: 'solving' });
    clock.now += 4_200;
    await settle();

    should(asked).eql([
      {
        kind: 'turnstile',
        siteKey: SITE_KEY,
        pageUrl: PAGE_URL,
        action: 'login',
        proxy: { type: 'socks5', host: '203.0.113.7', port: 1080 },
      },
    ]);
    should(injected).eql([{ page: 'p1', kind: 'turnstile', token: TOKEN }]);
    should(audits).have.length(1);
    const record = audits[0] as AuditDraft;
    should(record.event).equal(AUDIT.captchaSolve);
    should(record.outcome).equal('succeeded');
    should(record.detail).eql({
      identity: 'agent',
      siteHost: 'app.example.com',
      kind: 'turnstile',
      vendor: 'capsolver',
      outcome: 'solved',
      ms: 4200,
      estimatedCostMicros: SOLVE_COST_MICROS.turnstile,
    });
    should(AuditDetailSchema.safeParse(record.detail).success).be.true();
    const text = JSON.stringify(audits);
    for (const secret of [TOKEN, SITE_KEY, KEY, '#/login', 'code=abc']) should(text).not.containEql(secret);
  });

  it('should hand the token only for the address it was solved for', async () => {
    const { solving, injectedAt } = harness({ widget: WIDGET });
    await solving.begin('s1', 'p1');
    await settle();
    should(injectedAt).eql([PAGE_URL]);
  });

  it('should not solve a page again while it still shows the widget it was solved for, however long it has been', async () => {
    const { solving, injected, asked, audits, clock } = harness({ widget: WIDGET });
    should(await solving.begin('s1', 'p1')).eql({ kind: 'solving' });
    await settle();
    should(asked).have.length(1);
    for (let call = 0; call < 3; call += 1) {
      should(await solving.begin('s1', 'p1')).eql({ kind: 'solved' });
      await settle();
    }
    should(asked).have.length(1);
    should(injected).have.length(1);
    should(audits).have.length(1);
    // Another page of the same session is its own check.
    should(await solving.begin('s1', 'p2')).eql({ kind: 'solving' });
    await settle();
    should(asked).have.length(2);
    clock.now += 6 * 60_000;
    should(await solving.begin('s1', 'p1')).eql({ kind: 'solved' });
    await settle();
    should(asked).have.length(2);
    clock.now += 24 * 60 * 60_000;
    should(await solving.begin('s1', 'p1')).eql({ kind: 'solved' });
    should(asked).have.length(2);
  });

  it('should treat a different widget on the same page as a new check, and solve it', async () => {
    const { solving, asked, clock, state } = harness({ widget: WIDGET });
    await solving.begin('s1', 'p1');
    await settle();
    should(asked).have.length(1);
    state.widget = { ...WIDGET, pageUrl: 'https://app.example.com/#/other' };
    clock.now += 6 * 60_000;
    should(await solving.begin('s1', 'p1')).eql({ kind: 'solving' });
    await settle();
    should(asked).have.length(2);
  });

  it('should say a page it cannot solve is the owner’s, and leave that page alone for a while', async () => {
    const { solving, clock, asked } = harness({ widget: undefined });
    const first = await solving.begin('s1', 'p1');
    should(first).have.property('kind', 'not-solving');
    should(await solving.begin('s1', 'p1')).eql(first);
    should(asked).eql([]);
    clock.now += 6 * 60_000;
    should(await solving.begin('s1', 'p1')).have.property('kind', 'not-solving');
    should(await harness({ widget: new Error('page gone') }).solving.begin('s1', 'p1')).have.property(
      'kind',
      'not-solving',
    );
  });

  it('should keep the takeover and say why when the key is missing or the month is spent, and say the cap once', async () => {
    const noKey = harness({
      widget: WIDGET,
      solver: { ready: async () => ({ refused: 'no-key', reason: 'The captcha solver has no key yet.' }) },
    });
    should(await noKey.solving.begin('s1', 'p1')).eql({
      kind: 'not-solving',
      reason: 'The captcha solver has no key yet.',
    });
    should(noKey.audits).eql([]);

    const capped = harness({
      widget: WIDGET,
      solver: {
        ready: async () => ({ refused: 'cap', reason: 'The captcha solver has used its $5.00 for this month.' }),
      },
    });
    should(await capped.solving.begin('s1', 'p1')).have.property('kind', 'not-solving');
    should(await capped.solving.begin('s1', 'p2')).have.property('kind', 'not-solving');
    should(capped.audits.map(draft => draft.event)).eql([AUDIT.captchaCapReached]);
    should(capped.audits[0]?.detail).eql({ vendor: 'capsolver', capMicros: CAPTCHA_MONTHLY_CAP_MICROS });
  });

  it('should record a refused or failed solve, an answer the page did not take, and a solve that throws', async () => {
    const refused = harness({
      widget: WIDGET,
      solver: {
        solve: async () => ({ refused: 'cap', reason: 'The captcha solver has used its $5.00 for this month.' }),
      },
    });
    await refused.solving.begin('s1', 'p1');
    await settle();
    should(refused.injected).eql([]);
    should(refused.audits.map(draft => draft.event)).eql([AUDIT.captchaSolve, AUDIT.captchaCapReached]);
    should(refused.audits[0]?.detail).have.properties({ outcome: 'refused', estimatedCostMicros: 0 });

    const failed = harness({
      widget: WIDGET,
      solver: { solve: async () => ({ refused: 'failed', reason: 'The solver could not be reached.' }) },
    });
    await failed.solving.begin('s1', 'p1');
    await settle();
    should(failed.audits[0]?.detail).have.property('outcome', 'failed');

    const untaken = harness({ widget: WIDGET, taken: false });
    await untaken.solving.begin('s1', 'p1');
    await settle();
    should(untaken.audits[0]?.outcome).equal('failed');
    should(untaken.audits[0]?.detail).have.properties({
      outcome: 'failed',
      estimatedCostMicros: SOLVE_COST_MICROS.turnstile,
    });
    should(await untaken.solving.begin('s1', 'p1')).eql({
      kind: 'not-solving',
      reason: 'The page did not take the solver’s answer.',
    });

    const thrown = harness({
      widget: WIDGET,
      solver: {
        solve: async () => {
          throw new Error(`boom ${KEY}`);
        },
      },
    });
    await thrown.solving.begin('s1', 'p1');
    await settle();
    should(JSON.stringify(thrown.audits)).not.containEql(KEY);
    should(thrown.audits[0]?.detail).have.property('outcome', 'failed');
  });

  it('should say a failed audit write plainly, without the error’s words, and write nothing for a page with no host', async () => {
    const { solving, failures } = harness({ widget: WIDGET, auditFails: true });
    await solving.begin('s1', 'p1');
    await settle();
    should(failures).eql(['a captcha audit record was not written']);

    const odd = harness({ widget: { ...WIDGET, pageUrl: 'not a url' } });
    await odd.solving.begin('s1', 'p1');
    await settle();
    should(odd.audits).eql([]);
    should(odd.injected).have.length(1);
    const bare = harness({ widget: { ...WIDGET, pageUrl: 'https://[::1]/x' } });
    await bare.solving.begin('s1', 'p1');
    await settle();
    should(bare.audits).eql([]);
  });

  it('should leave a bounded memory of pages it has given up on', async () => {
    const { solving } = harness({ widget: undefined });
    for (let page = 0; page < 300; page += 1) await solving.begin('s1', `p${String(page)}`);
    should(await solving.begin('s1', 'p299')).have.property('kind', 'not-solving');
  });

  it('should drop only the oldest page when its memory is full, not every page it has given up on', async () => {
    const { solving, probes } = harness({ widget: undefined });
    for (let page = 0; page < 257; page += 1) await solving.begin('s1', `p${String(page)}`);
    should(probes()).equal(257);
    await solving.begin('s1', 'p1');
    await solving.begin('s1', 'p256');
    should(probes()).equal(257);
    await solving.begin('s1', 'p0');
    should(probes()).equal(258);
  });
});

describe('what an agent is told', () => {
  const answer = { summary: `Opened %browser:app at https://x.test.${HUMAN_CHECK_NOTE}`, extra: 1 };
  const agent = { kind: 'agent', sessionId: 's1' };
  const page = { surface: 'browser', id: 'p1' };
  const solverSaying = (start: Awaited<ReturnType<CaptchaSolving['begin']>>) => ({ begin: async () => start });

  it('should say "wait" while it is being solved, and keep every other field of the answer', async () => {
    const told = await solveCheck(solverSaying({ kind: 'solving' }), agent, page, answer);
    should(told.summary).containEql('The browser is solving this check now');
    should(told.summary).not.containEql('Do not try to solve');
    should(told.extra).equal(1);
    should(SOLVING_NOTE).containEql('ask your owner');
  });

  it('should say "carry on" for a page the browser has already solved, and not ask the agent to wait', async () => {
    const told = await solveCheck(solverSaying({ kind: 'solved' }), agent, page, answer);
    should(told.summary).containEql('already solved');
    should(told.summary).not.containEql('wait a few seconds');
    should(told.summary).not.containEql('Do not try to solve');
    should(told.extra).equal(1);
  });

  it('should keep the takeover and add the reason when nothing can solve it', async () => {
    const told = await solveCheck(
      solverSaying({ kind: 'not-solving', reason: 'The captcha solver has no key yet.' }),
      agent,
      page,
      answer,
    );
    should(told.summary).containEql('ask your owner to take the page over');
    should(told.summary).endWith('Automatic solving is not running: The captcha solver has no key yet.');
  });

  it('should return the answer as it was when stealth is off, for a person, with no check, or without a solver', async () => {
    should(await solveCheck(solverSaying({ kind: 'off' }), agent, page, answer)).equal(answer);
    should(await solveCheck(undefined, agent, page, answer)).equal(answer);
    should(
      await solveCheck(solverSaying({ kind: 'solving' }), { kind: 'person', sessionId: 's1' }, page, answer),
    ).equal(answer);
    should(await solveCheck(solverSaying({ kind: 'solving' }), agent, { surface: 'terminal', id: 't' }, answer)).equal(
      answer,
    );
    should(await solveCheck(solverSaying({ kind: 'solving' }), agent, undefined, answer)).equal(answer);
    const quiet = { summary: 'Opened.' };
    should(await solveCheck(solverSaying({ kind: 'solving' }), agent, page, quiet)).equal(quiet);
    const broken = { begin: async () => Promise.reject(new Error('x')) };
    should(await solveCheck(broken, agent, page, answer)).equal(answer);
  });
});

describe('the browser’s proxy, as the solver is given it', () => {
  it('should pass a proxy with no login, and none that has one or that it cannot read', () => {
    should(captchaProxyOf({ url: 'socks5://203.0.113.7:1080' })).eql({
      type: 'socks5',
      host: '203.0.113.7',
      port: 1080,
    });
    should(captchaProxyOf({ url: 'http://proxy.example.net:8080' })).eql({
      type: 'http',
      host: 'proxy.example.net',
      port: 8080,
    });
    should(captchaProxyOf({ url: 'socks5://203.0.113.7:1080', username: '${secret:PROXY_USER}' })).be.undefined();
    should(captchaProxyOf({ url: 'http://proxy.example.net' })).be.undefined();
    should(captchaProxyOf({ url: 'ftp://proxy.example.net:21' })).be.undefined();
    should(captchaProxyOf({ url: 'not a url' })).be.undefined();
    should(captchaProxyOf(undefined)).be.undefined();
  });
});

describe('the solver in browsers.yaml', () => {
  const parse = (value: unknown) => BrowsersConfigSchema.safeParse(value);

  it('should take only the reference to the one declared secret, never a value', () => {
    should(parse({ captcha: { apiKey: '${secret:CAPSOLVER_API_KEY}' } }).success).be.true();
    should(parse({ captcha: { apiKey: KEY } }).success).be.false();
    should(parse({ captcha: { apiKey: '${secret:SOMETHING_ELSE}' } }).success).be.false();
    should(parse({ captcha: { apiKey: '${secret:CAPSOLVER_API_KEY}', capUsd: 500 } }).success).be.false();
  });

  it('should hold naming the key for the owner, because it spends their balance', () => {
    const after = BrowsersConfigSchema.parse({ captcha: { apiKey: '${secret:CAPSOLVER_API_KEY}' } });
    const before = BrowsersConfigSchema.parse({});
    should(browsersLoosens(before, after)).eql([
      'the agent browser may now spend your CapSolver balance on solving captchas, up to $5 a month',
    ]);
    should(browsersLoosens(after, after)).eql([]);
    should(browsersLoosens(after, before)).eql([]);
  });
});

describe('the page-side answers a worker gives', () => {
  const request = (answer: unknown) => workerInputFields(async () => answer);

  it('should believe a widget only in its exact shape', async () => {
    const good = { kind: 'recaptcha-v3', siteKey: SITE_KEY, pageUrl: PAGE_URL, action: 'submit form' };
    should(await request({ widget: good }).captchaProbe('p1')).eql(good);
    should(await request({ widget: { ...good, action: '<script>' } }).captchaProbe('p1')).eql({
      kind: 'recaptcha-v3',
      siteKey: SITE_KEY,
      pageUrl: PAGE_URL,
    });
    for (const widget of [
      null,
      undefined,
      { ...good, kind: 'arkose' },
      { ...good, siteKey: 'short' },
      { ...good, siteKey: 'has space in the key 123' },
      { ...good, siteKey: 4 },
      { ...good, pageUrl: 'javascript:alert(1)' },
      { ...good, pageUrl: `https://x.test/${'a'.repeat(5_000)}` },
    ])
      should(await request({ widget }).captchaProbe('p1')).be.undefined();
    should(await request(null).captchaProbe('p1')).be.undefined();
  });

  it('should send the token to the worker and believe only a plain yes', async () => {
    const sent: Record<string, unknown>[] = [];
    const port = workerInputFields(async (method, params) => {
      sent.push({ method, ...params });
      return { taken: true };
    });
    const answer = { kind: 'turnstile', token: TOKEN, pageUrl: PAGE_URL } as const;
    should(await port.captchaInject('p1', answer)).be.true();
    should(sent).eql([{ method: 'captchaInject', pageId: 'p1', kind: 'turnstile', token: TOKEN, pageUrl: PAGE_URL }]);
    should(await request({ taken: 'yes' }).captchaInject('p1', answer)).be.false();
    should(await request(null).captchaInject('p1', answer)).be.false();
  });
});
