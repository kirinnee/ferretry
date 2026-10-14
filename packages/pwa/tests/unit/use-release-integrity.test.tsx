import { describe, it } from 'bun:test';
import should from 'should';

import {
  RELEASE_ASK_TIMEOUT_MS,
  type ReleaseChannelLike,
  type ReleaseContainerLike,
  type ReleaseIntegrity,
  type ReleaseIntegrityEnvironment,
  type ReleaseNotice,
  type ReleaseRegistrationLike,
  type ReleaseWorkerLike,
  askReleaseWorker,
  browserReleaseAsk,
  nextReleaseNotice,
  noticeForOutcome,
  releaseContainer,
  startReleaseIntegrity,
  useReleaseIntegrity,
} from '../../src/hooks/use-release-integrity.ts';
import type { VisibilityTarget } from '../../src/hooks/use-service-worker-update.ts';
import type { ReleaseReplyMessage, ReleaseRequestMessage } from '../../src/lib/release-keeper.ts';
import { render, run, runAsync } from '../support/react.ts';

const listeners = () => {
  const map = new Map<string, Set<(event: Event) => void>>();
  return {
    target: {
      addEventListener: (type: string, listener: (event: Event) => void) => {
        const set = map.get(type) ?? new Set();
        set.add(listener);
        map.set(type, set);
      },
      removeEventListener: (type: string, listener: (event: Event) => void) => {
        map.get(type)?.delete(listener);
      },
    },
    fire: (type: string) => {
      for (const listener of [...(map.get(type) ?? [])]) listener({} as Event);
    },
    count: (type: string) => map.get(type)?.size ?? 0,
  };
};

const worker = (scriptURL: string): ReleaseWorkerLike => ({ scriptURL, postMessage: () => undefined });

const registration = (parts: {
  active?: ReleaseWorkerLike | null;
  installing?: ReleaseWorkerLike | null;
  waiting?: ReleaseWorkerLike | null;
}) => {
  const events = listeners();
  const value = {
    ...events.target,
    active: parts.active ?? null,
    installing: parts.installing ?? null,
    waiting: parts.waiting ?? null,
  };
  return {
    registration: value as ReleaseRegistrationLike & { installing: ReleaseWorkerLike | null },
    fire: events.fire,
    count: events.count,
  };
};

const doc = (state = 'visible') => {
  const events = listeners();
  const value: VisibilityTarget & { visibilityState: string } = { ...events.target, visibilityState: state };
  return { doc: value, fire: events.fire, count: events.count };
};

type Answer = (worker: ReleaseWorkerLike, message: ReleaseRequestMessage) => ReleaseReplyMessage | null;

const asker = (answer: Answer) => {
  const asked: { worker: string; message: ReleaseRequestMessage }[] = [];
  return {
    asked,
    ask: async (target: ReleaseWorkerLike, message: ReleaseRequestMessage) => {
      asked.push({ worker: target.scriptURL, message });
      return answer(target, message);
    },
  };
};

const settle = async () => {
  for (let index = 0; index < 6; index += 1) await Promise.resolve();
};

const outcome = (status: string, extra: Record<string, unknown> = {}): ReleaseReplyMessage =>
  ({ type: 'fy-release-outcome', outcome: { status, ...extra } }) as ReleaseReplyMessage;

describe('askReleaseWorker', () => {
  const channel = () => {
    let closed = 0;
    const value: ReleaseChannelLike & { port1: { onmessage: ((event: MessageEvent) => void) | null } } = {
      port1: {
        onmessage: null,
        close: () => {
          closed += 1;
        },
      },
      port2: 'port-2',
    };
    return { value, closed: () => closed };
  };

  it('posts the request with the reply port and resolves with the parsed reply', async () => {
    // Arrange
    const pipe = channel();
    const posted: unknown[] = [];
    const cleared: unknown[] = [];
    const target: ReleaseWorkerLike = {
      scriptURL: '/sw.verified.js',
      postMessage: (message, transfer) => posted.push([message, transfer]),
    };

    // Act
    const pending = askReleaseWorker(
      target,
      { type: 'fy-release-check' },
      {
        channel: () => pipe.value,
        setTimer: () => 'timer',
        clearTimer: timer => cleared.push(timer),
      },
    );
    pipe.value.port1.onmessage?.({ data: { type: 'fy-release-outcome', outcome: null } } as MessageEvent);

    // Assert
    should(await pending).eql({ type: 'fy-release-outcome', outcome: null });
    should(posted).eql([[{ type: 'fy-release-check' }, ['port-2']]]);
    should(cleared).eql(['timer']);
    should(pipe.closed()).equal(1);
    should(pipe.value.port1.onmessage).be.null();
  });

  it('resolves null when the worker never answers', async () => {
    // Arrange
    const pipe = channel();
    let fire: (() => void) | undefined;
    let delay = 0;

    // Act
    const pending = askReleaseWorker(
      worker('/sw.verified.js'),
      { type: 'fy-release-status' },
      {
        channel: () => pipe.value,
        setTimer: (run, ms) => {
          fire = run;
          delay = ms;
        },
        clearTimer: () => undefined,
      },
    );
    fire?.();

    // Assert
    should(await pending).be.null();
    should(delay).equal(RELEASE_ASK_TIMEOUT_MS);
  });

  it('is bound to the browser channel and timers by browserReleaseAsk', async () => {
    // Arrange
    class Channel {
      readonly port1 = { onmessage: null as ((event: MessageEvent) => void) | null, close: () => undefined };
      readonly port2 = 'p2';
    }
    const target: ReleaseWorkerLike = {
      scriptURL: '/sw.verified.js',
      postMessage: () =>
        queueMicrotask(() =>
          created?.port1.onmessage?.({ data: { type: 'fy-release-worker-audit', signed: true } } as MessageEvent),
        ),
    };
    let created: Channel | undefined;
    class Tracking extends Channel {
      constructor() {
        super();
        created = this;
      }
    }

    // Act
    const actual = await browserReleaseAsk(Tracking)(target, { type: 'fy-release-check' });

    // Assert
    should(actual).eql({ type: 'fy-release-worker-audit', signed: true });
  });
});

describe('the notice rules', () => {
  it.each([
    [null, null],
    [{ status: 'current' }, null],
    [
      { status: 'refused', refusal: 'older', hadRelease: true },
      { kind: 'refused', refusal: 'older', hadRelease: true },
    ],
  ] as const)('maps the outcome %j to %j', (input, expected) => {
    should(noticeForOutcome(input as Parameters<typeof noticeForOutcome>[0])).eql(expected);
  });

  const refused: ReleaseNotice = { kind: 'refused', refusal: 'older', hadRelease: true };
  const alarm: ReleaseNotice = { kind: 'unsigned-worker' };

  it.each([
    [null, refused, refused],
    [refused, null, refused],
    [alarm, refused, alarm],
    [alarm, null, alarm],
    [refused, alarm, alarm],
  ])('keeps the right notice (%j then %j)', (previous, next, expected) => {
    should(nextReleaseNotice(previous, next)).eql(expected);
  });
});

describe('releaseContainer', () => {
  const sw = { controller: null, ready: Promise.resolve(registration({}).registration) };
  class Channel {}

  it.each([
    ['an insecure page', { navigator: { serviceWorker: sw }, secure: false, MessageChannel: Channel }, false],
    ['no service worker API', { navigator: {}, secure: true, MessageChannel: Channel }, false],
    ['a null container', { navigator: { serviceWorker: null }, secure: true, MessageChannel: Channel }, false],
    ['no navigator', { navigator: undefined, secure: true, MessageChannel: Channel }, false],
    ['no MessageChannel', { navigator: { serviceWorker: sw }, secure: true, MessageChannel: undefined }, false],
    ['a secure page with both', { navigator: { serviceWorker: sw }, secure: true, MessageChannel: Channel }, true],
  ])('answers for %s', (_name, input, expected) => {
    should(releaseContainer(input as unknown as Parameters<typeof releaseContainer>[0]) !== null).equal(expected);
  });
});

describe('startReleaseIntegrity', () => {
  const start = (options: {
    controller?: unknown;
    parts?: Parameters<typeof registration>[0];
    answer: Answer;
    visibility?: string;
    unsigned?: boolean;
  }) => {
    const reg = registration(options.parts ?? { active: worker('/sw.verified.js') });
    const controller = 'controller' in options ? options.controller : {};
    const container: ReleaseContainerLike = { controller, ready: Promise.resolve(reg.registration) };
    const page = doc(options.visibility);
    const asking = asker(options.answer);
    const notices: ReleaseNotice[] = [];
    const updates: string[] = [];
    const unsigned: string[] = [];
    const stop = startReleaseIntegrity({
      container,
      doc: page.doc,
      ask: asking.ask,
      onNotice: notice => notices.push(notice),
      onUpdateReady: reason => updates.push(reason),
      ...(options.unsigned === false ? {} : { onUnsignedWorker: event => unsigned.push(event.scriptUrl) }),
    });
    return { reg, page, asking, notices, updates, unsigned, stop };
  };

  it('asks for a check on start and raises the update chip for an installed release', async () => {
    // Arrange + Act
    const subject = start({ answer: () => outcome('updated') });
    await settle();

    // Assert
    should(subject.asking.asked).eql([{ worker: '/sw.verified.js', message: { type: 'fy-release-check' } }]);
    should(subject.updates).eql(['update']);
    should(subject.notices).eql([]);
    subject.stop();
  });

  it('offers no update on a first install, which has no controller', async () => {
    const subject = start({ controller: null, answer: () => outcome('updated') });
    await settle();
    should(subject.updates).eql([]);
    subject.stop();
  });

  it('raises the notice for a refused release', async () => {
    const subject = start({ answer: () => outcome('refused', { refusal: 'bad-signature', hadRelease: true }) });
    await settle();
    should(subject.notices).eql([{ kind: 'refused', refusal: 'bad-signature', hadRelease: true }]);
    should(subject.updates).eql([]);
    subject.stop();
  });

  it('ignores a silent worker and an answer of the wrong kind', async () => {
    const silent = start({ answer: () => null });
    const confused = start({ answer: () => ({ type: 'fy-release-worker-audit', signed: true }) });
    await settle();
    should([...silent.notices, ...silent.updates, ...confused.notices, ...confused.updates]).eql([]);
    silent.stop();
    confused.stop();
  });

  it('checks again only when the tab becomes visible', async () => {
    // Arrange
    const subject = start({ answer: () => outcome('current') });
    await settle();

    // Act
    subject.page.doc.visibilityState = 'hidden';
    subject.page.fire('visibilitychange');
    subject.page.doc.visibilityState = 'visible';
    subject.page.fire('visibilitychange');
    await settle();

    // Assert
    should(subject.asking.asked.filter(entry => entry.message.type === 'fy-release-check')).have.length(2);
    subject.stop();
  });

  it('asks nothing while no worker is active', async () => {
    const subject = start({ parts: {}, answer: () => outcome('current') });
    await settle();
    subject.page.fire('visibilitychange');
    await settle();
    should(subject.asking.asked).eql([]);
    subject.stop();
  });

  it('audits a new worker the moment the browser starts installing it, and stays quiet when it is signed', async () => {
    // Arrange
    const subject = start({
      answer: (_target, message) =>
        message.type === 'fy-release-audit-worker'
          ? { type: 'fy-release-worker-audit', signed: true }
          : outcome('current'),
    });
    await settle();

    // Act
    subject.reg.registration.installing = worker('/sw.verified.js?next');
    subject.reg.fire('updatefound');
    await settle();

    // Assert
    should(subject.asking.asked).containEql({
      worker: '/sw.verified.js',
      message: { type: 'fy-release-audit-worker', scriptUrl: '/sw.verified.js?next' },
    });
    should(subject.notices).eql([]);
    subject.stop();
  });

  it.each([
    ['an unsigned worker', { type: 'fy-release-worker-audit', signed: false } as ReleaseReplyMessage],
    ['an audit nobody answers', null],
  ])('raises the alarm and calls the audit seam for %s', async (_name, reply) => {
    // Arrange: a worker already waiting when the page opened.
    const subject = start({
      parts: { active: worker('/sw.verified.js'), waiting: worker('https://ferretry.example/sw.verified.js') },
      answer: (_target, message) => (message.type === 'fy-release-audit-worker' ? reply : outcome('current')),
    });

    // Act
    await settle();

    // Assert
    should(subject.notices).eql([{ kind: 'unsigned-worker' }]);
    should(subject.unsigned).eql(['https://ferretry.example/sw.verified.js']);
    subject.stop();
  });

  it('raises the alarm without a seam, and audits each script once at a time', async () => {
    // Arrange
    const installing = worker('/sw.evil.js');
    const subject = start({
      parts: { active: worker('/sw.verified.js'), installing, waiting: installing },
      unsigned: false,
      answer: (_target, message) =>
        message.type === 'fy-release-audit-worker'
          ? { type: 'fy-release-worker-audit', signed: false }
          : outcome('current'),
    });

    // Act
    await settle();

    // Assert
    should(subject.notices).eql([{ kind: 'unsigned-worker' }]);
    should(subject.asking.asked.filter(entry => entry.message.type === 'fy-release-audit-worker')).have.length(1);
    subject.stop();
  });

  it('never audits the active worker itself, or no worker', async () => {
    const active = worker('/sw.verified.js');
    const subject = start({ parts: { active, installing: active }, answer: () => outcome('current') });
    await settle();
    subject.reg.registration.installing = null;
    subject.reg.fire('updatefound');
    await settle();
    should(subject.asking.asked.filter(entry => entry.message.type === 'fy-release-audit-worker')).eql([]);
    subject.stop();
  });

  it('drops answers that arrive after the cleanup, and removes its listeners', async () => {
    // Arrange
    let release: (() => void) | undefined;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const reg = registration({ active: worker('/sw.verified.js'), waiting: worker('/sw.evil.js') });
    const page = doc();
    const notices: ReleaseNotice[] = [];
    const stop = startReleaseIntegrity({
      container: { controller: {}, ready: Promise.resolve(reg.registration) },
      doc: page.doc,
      ask: async (_target, message) => {
        await gate;
        return message.type === 'fy-release-audit-worker'
          ? { type: 'fy-release-worker-audit', signed: false }
          : outcome('refused', { refusal: 'older', hadRelease: true });
      },
      onNotice: notice => notices.push(notice),
      onUpdateReady: () => undefined,
    });
    await settle();

    // Act
    stop();
    release?.();
    await settle();

    // Assert
    should(notices).eql([]);
    should(reg.count('updatefound')).equal(0);
    should(page.count('visibilitychange')).equal(0);
  });

  it('attaches nothing when stopped before the worker is ready', async () => {
    // Arrange
    const reg = registration({ active: worker('/sw.verified.js') });
    const asking = asker(() => outcome('current'));

    // Act
    const stop = startReleaseIntegrity({
      container: { controller: {}, ready: Promise.resolve(reg.registration) },
      doc: doc().doc,
      ask: asking.ask,
      onNotice: () => undefined,
      onUpdateReady: () => undefined,
    });
    stop();
    await settle();

    // Assert
    should(reg.count('updatefound')).equal(0);
    should(asking.asked).eql([]);
  });
});

describe('useReleaseIntegrity', () => {
  const mount = (environment: ReleaseIntegrityEnvironment) => {
    let latest: ReleaseIntegrity | undefined;
    function Probe() {
      latest = useReleaseIntegrity(environment);
      return null;
    }
    const renderer = render(<Probe />);
    return {
      hook: () => {
        if (latest === undefined) throw new Error('the hook did not run');
        return latest;
      },
      unmount: () => run(() => renderer.unmount()),
    };
  };

  it('shows the alarm over a later refusal, and dismisses on request', async () => {
    // Arrange
    const reg = registration({ active: worker('/sw.verified.js'), waiting: worker('/sw.evil.js') });
    const unsigned: string[] = [];
    const probe = mount({
      container: { controller: {}, ready: Promise.resolve(reg.registration) },
      doc: doc().doc,
      ask: async (_target, message) =>
        message.type === 'fy-release-audit-worker'
          ? { type: 'fy-release-worker-audit', signed: false }
          : outcome('refused', { refusal: 'older', hadRelease: true }),
      onUpdateReady: () => undefined,
      onUnsignedWorker: event => unsigned.push(event.scriptUrl),
    });

    // Act
    await runAsync(settle);

    // Assert
    should(probe.hook().notice).eql({ kind: 'unsigned-worker' });
    should(unsigned).eql(['/sw.evil.js']);
    run(() => probe.hook().dismiss());
    should(probe.hook().notice).be.null();
    probe.unmount();
  });

  it('does nothing where there is no worker to ask', async () => {
    const probe = mount({ container: null, doc: doc().doc, ask: async () => null, onUpdateReady: () => undefined });
    await runAsync(settle);
    should(probe.hook().notice).be.null();
    probe.unmount();
  });

  it('runs without an audit seam', async () => {
    const probe = mount({
      container: {
        controller: {},
        ready: Promise.resolve(registration({ active: worker('/sw.verified.js') }).registration),
      },
      doc: doc().doc,
      ask: async () => outcome('refused', { refusal: 'older', hadRelease: false }),
      onUpdateReady: () => undefined,
    });
    await runAsync(settle);
    should(probe.hook().notice).eql({ kind: 'refused', refusal: 'older', hadRelease: false });
    probe.unmount();
  });
});

describe('startReleaseIntegrity · every machine’s push worker is audited too', () => {
  const ORIGIN = 'https://app.example.test';
  const pushRegistration = (daemon: string, parts: Parameters<typeof registration>[0]) => {
    const made = registration(parts);
    return { ...made, registration: { ...made.registration, scope: `${ORIGIN}/push/${daemon}/` } };
  };

  const begin = (registrations: unknown[] | (() => Promise<readonly unknown[]>), answer: Answer) => {
    const root = registration({ active: worker(`${ORIGIN}/sw.verified.js`) });
    const container: ReleaseContainerLike = {
      controller: {},
      ready: Promise.resolve(root.registration),
      getRegistrations: typeof registrations === 'function' ? registrations : async () => registrations,
    };
    const page = doc();
    const asking = asker(answer);
    const notices: ReleaseNotice[] = [];
    const stop = startReleaseIntegrity({
      container,
      doc: page.doc,
      ask: asking.ask,
      onNotice: notice => notices.push(notice),
      onUpdateReady: () => undefined,
    });
    return { page, asking, notices, stop };
  };

  const audits = (asked: { worker: string; message: ReleaseRequestMessage }[]) =>
    asked.filter(entry => entry.message.type === 'fy-release-audit-worker').map(entry => entry.message);

  it('audits each push worker’s scripts, alarms on an unsigned one, and skips the app-wide registration', async () => {
    const work = pushRegistration('work', { active: worker(`${ORIGIN}/sw.verified.js?machine=Work`) });
    const home = pushRegistration('home', { waiting: worker(`${ORIGIN}/evil.js?machine=Home`) });
    const app = { ...registration({ active: worker(`${ORIGIN}/sw.verified.js`) }).registration, scope: `${ORIGIN}/` };
    const subject = begin([work.registration, home.registration, app, 'nonsense', null], (_worker, message) =>
      message.type === 'fy-release-audit-worker'
        ? { type: 'fy-release-worker-audit', signed: !message.scriptUrl.includes('evil') }
        : null,
    );
    await settle();

    should(audits(subject.asking.asked)).eql([
      { type: 'fy-release-audit-worker', scriptUrl: `${ORIGIN}/sw.verified.js?machine=Work` },
      { type: 'fy-release-audit-worker', scriptUrl: `${ORIGIN}/evil.js?machine=Home` },
    ]);
    should(subject.notices).eql([{ kind: 'unsigned-worker' }]);
    should(work.count('updatefound')).equal(1);

    // A new install in a machine's worker is audited the moment it starts.
    work.registration.installing = worker(`${ORIGIN}/sw.verified.js?machine=Work%202`);
    work.fire('updatefound');
    await settle();
    should(audits(subject.asking.asked).at(-1)).eql({
      type: 'fy-release-audit-worker',
      scriptUrl: `${ORIGIN}/sw.verified.js?machine=Work%202`,
    });

    // Seen again when the tab returns: audited, not listened to twice.
    subject.page.fire('visibilitychange');
    await settle();
    should(work.count('updatefound')).equal(1);

    subject.stop();
    should(work.count('updatefound')).equal(0);
  });

  it('carries on when the browser will not list its registrations, or has no such call', async () => {
    const refusing = begin(
      async () => {
        throw new Error('denied');
      },
      () => null,
    );
    await settle();
    should(refusing.notices).eql([]);
    refusing.stop();

    const root = registration({ active: worker(`${ORIGIN}/sw.verified.js`) });
    const stop = startReleaseIntegrity({
      container: { controller: {}, ready: Promise.resolve(root.registration) },
      doc: doc().doc,
      ask: async () => null,
      onNotice: () => undefined,
      onUpdateReady: () => undefined,
    });
    await settle();
    stop();
  });

  it('stops listing once it is stopped', async () => {
    let release: (value: readonly unknown[]) => void = () => undefined;
    const work = pushRegistration('work', { active: worker(`${ORIGIN}/sw.verified.js?machine=Work`) });
    const subject = begin(
      () =>
        new Promise(resolve => {
          release = resolve;
        }),
      () => null,
    );
    await settle();
    subject.stop();
    release([work.registration]);
    await settle();
    should(work.count('updatefound')).equal(0);
  });
});
