import { describe, expect, it } from 'bun:test';
import type { ProposalView } from '@ferretry/protocol';
import {
  absoluteTime,
  LearningPage,
  LearningReview,
  learningErrorMessage,
  learningStrength,
  ProposalCard,
} from '../../../src/features/learning/learning-page.tsx';
import type { MediaQueryListLike } from '../../../src/features/learning/use-touch-affected.ts';
import { daemonConnection } from '../../../src/lib/daemon-connection.ts';
import { render, run, runAsync } from '../../support/react.ts';
import { proposal, status } from '../learning-api.test.ts';

/** Pins pointer modality so editor focus is a deliberate desktop-only choice. */
const withModality = <T,>(desktop: boolean, body: () => T): T => {
  const ambient = Object.getOwnPropertyDescriptor(globalThis, 'matchMedia');
  Object.defineProperty(globalThis, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string): MediaQueryListLike => ({
      matches: desktop ? query === '(pointer: fine)' || query === '(hover: hover)' : true,
    }),
  });
  try {
    return body();
  } finally {
    if (ambient) Object.defineProperty(globalThis, 'matchMedia', ambient);
    else Reflect.deleteProperty(globalThis, 'matchMedia');
  }
};

const connection = daemonConnection({
  daemonId: 'daemon/a',
  baseUrl: 'https://a.example.test',
  deviceToken: 'token-a',
});
const connectionB = daemonConnection({
  daemonId: 'daemon/b',
  baseUrl: 'https://b.example.test',
  deviceToken: 'token-b',
});
const makeProposal = (state: ProposalView['state'], occurrences: number, id: string): ProposalView => ({
  ...proposal,
  id,
  state,
  occurrences,
  title: `${state} ${id}`,
});

/** A promise the test holds the resolve/reject of, so a fetch can be parked until the race says so. */
type Deferred = {
  readonly promise: Promise<Response>;
  readonly resolve: (value: Response) => void;
  readonly reject: (reason: unknown) => void;
};
const deferred = (): Deferred => {
  let resolve!: (value: Response) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<Response>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

describe('LearningReview', () => {
  it('keeps proposal groups, evidence links, touch targets, and daemon routing visible', () => {
    const actions: unknown[] = [];
    const renderer = render(
      <LearningReview
        connection={connection}
        status={status}
        proposals={[
          makeProposal('pending', 5, 'strong'),
          makeProposal('pending', 2, 'normal'),
          makeProposal('pending', 1, 'weak'),
          makeProposal('accepted', 2, 'accepted'),
          makeProposal('rejected', 2, 'rejected'),
        ]}
        error={null}
        busy={false}
        now={Date.parse('2026-07-31T12:01:00.000Z')}
        onRun={() => undefined}
        onAction={(...action) => actions.push(action)}
      />,
    );
    const text = JSON.stringify(renderer.toJSON());
    expect(text).toContain('Strong signals');
    expect(text).toContain('Weak signals');
    expect(text).toContain('Accepted — apply by hand');
    expect(text).toContain('Rejected (permanent)');
    expect(text).toContain('/d/daemon%2Fa/session/session%2Fa');
    expect(
      renderer.root
        .findByProps({ 'aria-label': 'Learning status' })
        .findAllByType('span')
        .map(span => span.children.join(''))
        .join(''),
    ).toContain('last run');
    const [, accept] = renderer.root.findAllByType('button');
    if (accept === undefined) throw new Error('accept action missing');
    run(() => accept.props.onClick());
    expect(actions).toEqual([['strong', { action: 'accept' }]]);
  });

  it('makes loading, unavailable, editing, copy, and patch actions explicit', async () => {
    const clipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => undefined } });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ path: 'AGENTS.md', contents: 'patch' }))) as unknown as typeof fetch;
    const originalCreate = URL.createObjectURL;
    const originalRevoke = URL.revokeObjectURL;
    const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'document');
    URL.createObjectURL = () => 'blob:patch';
    URL.revokeObjectURL = () => undefined;
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: { createElement: () => ({ click: () => undefined }) },
    });
    try {
      const loading = render(
        <LearningReview
          connection={connection}
          status={null}
          proposals={[]}
          error={null}
          busy={false}
          now={0}
          onRun={() => undefined}
          onAction={() => undefined}
        />,
      );
      expect(JSON.stringify(loading.toJSON())).toContain('Reading learning proposals');
      const renderer = render(
        <LearningReview
          connection={connection}
          status={status}
          proposals={[proposal]}
          error="offline"
          busy={false}
          now={0}
          onRun={() => undefined}
          onAction={() => undefined}
        />,
      );
      expect(JSON.stringify(renderer.toJSON())).toContain('offline');
      const buttons = renderer.root.findAllByType('button');
      const [, , edit, , copy, patch] = buttons;
      if (!edit || !copy || !patch) throw new Error('proposal actions missing');
      run(() => edit.props.onClick());
      expect(JSON.stringify(renderer.toJSON())).toContain('Save');
      const input = renderer.root.findByType('textarea');
      run(() => input.props.onChange({ target: { value: 'Edited rule.' } }));
      const [, save] = renderer.root.findAllByType('button');
      if (!save) throw new Error('save action missing');
      run(() => save.props.onClick());
      run(() => renderer.root.findAllByType('button')[2]?.props.onClick());
      run(() => renderer.root.findAllByType('button')[2]?.props.onClick());
      await runAsync(async () => {
        copy.props.onClick();
        await new Promise(resolve => queueMicrotask(resolve));
      });
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText: async () => Promise.reject(new Error('denied')) },
      });
      await runAsync(async () => {
        copy.props.onClick();
        await new Promise(resolve => queueMicrotask(resolve));
      });
      await runAsync(async () => {
        patch.props.onClick();
        await new Promise(resolve => queueMicrotask(resolve));
        await new Promise(resolve => queueMicrotask(resolve));
        await new Promise(resolve => queueMicrotask(resolve));
      });
      expect(JSON.stringify(renderer.toJSON())).toContain('Copy rule');
    } finally {
      Object.defineProperty(navigator, 'clipboard', clipboard ?? { configurable: true, value: undefined });
      globalThis.fetch = originalFetch;
      URL.createObjectURL = originalCreate;
      URL.revokeObjectURL = originalRevoke;
      if (documentDescriptor) Object.defineProperty(globalThis, 'document', documentDescriptor);
      else Reflect.deleteProperty(globalThis, 'document');
    }
  });

  it('renders the shared learning header, with its label, separators and hour-scale ages', () => {
    const renderer = render(
      <LearningReview
        connection={connection}
        status={status}
        proposals={[]}
        error={null}
        busy={false}
        // Three hours after the recorded run: the header must say `3h ago`,
        // which the minute-only formatter this replaced rendered as `180m ago`.
        now={Date.parse('2026-07-31T15:00:00.000Z')}
        onRun={() => undefined}
        onAction={() => undefined}
      />,
    );
    const header = renderer.root.findByProps({ 'aria-label': 'Learning status' });
    const spans = header.findAllByType('span');
    const text = spans.map(span => span.children.join('')).join(' ');
    expect(text).toContain('Learning');
    expect(text).toContain('enabled');
    expect(text).toContain('last run 3h ago');
    expect(text).toContain('1 pending');
    expect(text).toContain('1 strong');
    const separators = spans.filter(span => span.children.join('') === '·');
    expect(separators.length).toBeGreaterThan(0);
    expect(separators.every(span => span.props['aria-hidden'] === 'true')).toBe(true);
  });

  it('names the teammate the way a reader reads it and stamps evidence with an exact time', () => {
    const renderer = render(
      <ProposalCard
        connection={connection}
        proposal={{
          ...proposal,
          evidence: [{ ...proposal.evidence[0]!, teammate: 'ms-98', source: 'teammate' }],
        }}
        busy={false}
        accepted={false}
        onAction={() => undefined}
      />,
    );
    const meta = renderer.root
      .findByType('a')
      .findAllByType('span')
      .map(span => span.children.join(''))
      .join('');
    expect(meta).toContain('teammate steer');
    expect(meta).toContain('Ms-98');
    expect(meta).not.toContain('ms-98');
    // Local-zone rendering, so assert the shape rather than a fixed instant —
    // what matters is that the raw ISO string never reaches the reader.
    expect(meta).toMatch(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/u);
    expect(meta).not.toContain('2026-07-31T12:00:00.000Z');
  });

  it('formats, refuses and passes through evidence instants predictably', () => {
    expect(absoluteTime('2026-07-31T12:00:00.000Z', 'UTC')).toBe('2026-07-31 12:00:00');
    expect(absoluteTime('2026-07-31T12:00:00.000Z', 'Asia/Singapore')).toBe('2026-07-31 20:00:00');
    expect(absoluteTime(undefined)).toBe('—');
    expect(absoluteTime('')).toBe('—');
    // An unparseable stamp is shown verbatim: hiding it would hide the defect.
    expect(absoluteTime('not-an-instant')).toBe('not-an-instant');
  });

  it('makes a strong signal look strong and a weak one look weak', () => {
    const renderer = render(
      <LearningReview
        connection={connection}
        status={status}
        proposals={[makeProposal('pending', 5, 'strong'), makeProposal('pending', 1, 'weak')]}
        error={null}
        busy={false}
        now={0}
        onRun={() => undefined}
        onAction={() => undefined}
      />,
    );
    const strongCard = renderer.root.findByProps({ 'aria-label': 'Learning proposal pending strong' });
    const weakCard = renderer.root.findByProps({ 'aria-label': 'Learning proposal pending weak' });
    const badge = (card: typeof strongCard) => card.findAllByType('span').find(span => span.props.title !== undefined);

    expect(String(strongCard.props.className)).not.toContain('opacity-80');
    expect(String(weakCard.props.className)).toContain('opacity-80');
    expect(badge(strongCard)?.props.title).toBe('5 distinct sessions');
    expect(String(badge(strongCard)?.props.className)).toContain('font-semibold');
    expect(badge(weakCard)?.props.title).toBe('1 distinct session');
    expect(String(badge(weakCard)?.props.className)).not.toContain('font-semibold');
    expect(strongCard.findAllByType('span').some(span => span.props.title === 'distinct repos this was seen in')).toBe(
      true,
    );
  });

  it('focuses the rule editor on a pointer device and never on a touch one', () => {
    const openEditor = (desktop: boolean) =>
      withModality(desktop, () => {
        let focusCalls = 0;
        const renderer = render(
          <ProposalCard
            connection={connection}
            proposal={makeProposal('pending', 2, 'focus')}
            busy={false}
            accepted={false}
            onAction={() => undefined}
          />,
          {
            createNodeMock: element => (element.type === 'textarea' ? { focus: () => (focusCalls += 1) } : null),
          },
        );
        run(() => renderer.root.findByProps({ 'aria-label': 'Edit pending focus' }).props.onClick());
        return { focusCalls, autoFocus: renderer.root.findByType('textarea').props.autoFocus };
      });

    expect(openEditor(true)).toEqual({ focusCalls: 1, autoFocus: undefined });
    expect(openEditor(false)).toEqual({ focusCalls: 0, autoFocus: undefined });
  });

  it('classifies strength and unknown errors without pretending they are healthy', () => {
    expect([learningStrength(1), learningStrength(2), learningStrength(5)]).toEqual(['weak', 'normal', 'strong']);
    expect(learningErrorMessage('bad')).toContain('unavailable');
    expect(learningErrorMessage(new Error('bad'))).toBe('bad');
  });

  it('keeps every proposal action touch-safe and names it for assistive technology', () => {
    const renderer = render(
      <ProposalCard
        connection={connection}
        proposal={makeProposal('pending', 5, 'accessible')}
        busy={false}
        accepted={false}
        onAction={() => undefined}
      />,
    );
    const buttons = renderer.root.findAllByType('button');
    expect(buttons.map(button => button.props['aria-label'])).toEqual([
      'Accept pending accessible',
      'Edit pending accessible',
      'Reject pending accessible permanently',
      'Copy rule text for pending accessible',
      'Save a patch file for pending accessible',
    ]);
    expect(buttons.every(button => String(button.props.className).includes('min-h-[44px]'))).toBe(true);
    expect(JSON.stringify(renderer.toJSON())).toContain('verified quote');
  });

  it('shows a patch download failure and clears its transient feedback on unmount', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: 'patch unavailable' }), { status: 503 })) as unknown as typeof fetch;
    const renderer = render(
      <ProposalCard
        connection={connection}
        proposal={makeProposal('pending', 5, 'patch-failure')}
        busy={false}
        accepted={false}
        onAction={() => undefined}
      />,
    );
    try {
      const patch = renderer.root.findByProps({ 'aria-label': 'Save a patch file for pending patch-failure' });
      await runAsync(async () => {
        patch.props.onClick();
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(JSON.stringify(renderer.toJSON())).toContain('patch unavailable');
    } finally {
      run(() => renderer.unmount());
      globalThis.fetch = originalFetch;
    }
  });

  it('loads and refreshes only through the supplied daemon connection', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request) => {
      const path = String(url);
      if (path.endsWith('/status')) return new Response(JSON.stringify(status));
      if (path.endsWith('/proposals')) return new Response(JSON.stringify([proposal]));
      if (path.endsWith('/run'))
        return new Response(
          JSON.stringify({
            runId: 'run',
            startedAt: '2026-07-31T12:00:00.000Z',
            sessionsScanned: 0,
            sessionsWithSignal: 0,
            minerSessions: [],
            observationsProposed: 0,
            observationsVerified: 0,
            rejectedQuotes: 0,
            malformedFiles: 0,
            proposalsCreated: 0,
            proposalsStrengthened: 0,
            proposalsSuppressedByTombstone: 0,
            perHarness: { claude: 0, codex: 0 },
          }),
        );
      return new Response(JSON.stringify(proposal));
    }) as typeof fetch;
    try {
      const renderer = render(<LearningPage connection={connection} now={0} />);
      await runAsync(async () => await Promise.resolve());
      const runButton = renderer.root.findAllByType('button')[0];
      if (!runButton) throw new Error('run button missing');
      await runAsync(async () => {
        runButton.props.onClick();
        await new Promise(resolve => queueMicrotask(resolve));
        await new Promise(resolve => queueMicrotask(resolve));
      });
      expect(JSON.stringify(renderer.toJSON())).toContain('Use the paired daemon');
      const accept = renderer.root.findAllByType('button')[1];
      if (!accept) throw new Error('accept button missing');
      await runAsync(async () => {
        accept.props.onClick();
        await new Promise(resolve => queueMicrotask(resolve));
        await new Promise(resolve => queueMicrotask(resolve));
        await new Promise(resolve => queueMicrotask(resolve));
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('makes daemon load and action failures visible instead of carrying on with stale data', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: 'offline' }), { status: 503 })) as unknown as typeof fetch;
    try {
      const renderer = render(<LearningPage connection={connection} now={0} />);
      await runAsync(async () => await Promise.resolve());
      expect(JSON.stringify(renderer.toJSON())).toContain('offline');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('surfaces failures from both proposal actions and manual scans', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request) => {
      const path = String(url);
      if (path.endsWith('/status')) return new Response(JSON.stringify(status));
      if (path.endsWith('/proposals')) return new Response(JSON.stringify([proposal]));
      return new Response(JSON.stringify({ error: 'mutation refused' }), { status: 503 });
    }) as typeof fetch;
    try {
      const renderer = render(<LearningPage connection={connection} now={0} />);
      await runAsync(async () => await Promise.resolve());
      const [runButton, acceptButton] = renderer.root.findAllByType('button');
      if (!runButton || !acceptButton) throw new Error('learning controls missing');
      await runAsync(async () => {
        acceptButton.props.onClick();
        await new Promise(resolve => queueMicrotask(resolve));
      });
      await runAsync(async () => {
        runButton.props.onClick();
        await new Promise(resolve => queueMicrotask(resolve));
      });
      expect(JSON.stringify(renderer.toJSON())).toContain('mutation refused');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  // A parked fetch records every request as its OWN deferred (not deduped by
  // URL), so two loads of the same endpoint — daemon A's first and second load
  // across an A→B→A round trip — can be settled independently. `nth(url, i)`
  // resolves the i-th request issued against that URL, making order explicit.
  const installParkedFetch = () => {
    const originalFetch = globalThis.fetch;
    const requests: { url: string; deferred: Deferred }[] = [];
    globalThis.fetch = (async (url: string | URL | Request) => {
      const entry = { url: String(url), deferred: deferred() };
      requests.push(entry);
      return entry.deferred.promise;
    }) as typeof fetch;
    return {
      nth: (url: string, index: number): Deferred => {
        const match = requests.filter(request => request.url === url)[index];
        if (match === undefined) throw new Error(`no parked request #${index} for ${url}`);
        return match.deferred;
      },
      restore: () => {
        globalThis.fetch = originalFetch;
      },
    };
  };
  const drain = () => new Promise<void>(resolve => setTimeout(resolve, 0));
  const json = (body: unknown) => new Response(JSON.stringify(body));
  const statusUrl = (c: { baseUrl: string }) => `${c.baseUrl}/v1/learning/status`;
  const proposalsUrl = (c: { baseUrl: string }) => `${c.baseUrl}/v1/learning/proposals`;
  const actionUrl = (c: { baseUrl: string }, id: string) =>
    `${c.baseUrl}/v1/learning/proposals/${encodeURIComponent(id)}`;
  const runUrl = (c: { baseUrl: string }) => `${c.baseUrl}/v1/learning/run`;
  const runButton = (renderer: ReturnType<typeof render>) =>
    renderer.root.findByProps({ 'aria-label': 'Run a learning scan now' });
  const acceptButton = (renderer: ReturnType<typeof render>) =>
    renderer.root.findByProps({ 'aria-label': 'Accept Use the paired daemon' });

  it('keeps the new daemon visible when a superseded daemon load resolves late', async () => {
    const parked = installParkedFetch();
    try {
      const renderer = render(<LearningPage connection={connection} now={0} />);
      await runAsync(async () => {
        await Promise.resolve();
      });
      // Switch to daemon B; its load parks alongside A's still-in-flight load.
      run(() => renderer.update(<LearningPage connection={connectionB} now={0} />));
      await runAsync(async () => {
        await Promise.resolve();
      });
      // Resolve B first, so the view belongs to it before A settles.
      await runAsync(async () => {
        parked.nth(statusUrl(connectionB), 0).resolve(json(status));
        parked
          .nth(proposalsUrl(connectionB), 0)
          .resolve(json([{ ...proposal, id: 'proposal/b', title: 'Daemon B proposal' }]));
        await drain();
      });
      expect(JSON.stringify(renderer.toJSON())).toContain('Daemon B proposal');
      // A's Promise.all now resolves — late. It must not overwrite B.
      await runAsync(async () => {
        parked.nth(statusUrl(connection), 0).resolve(json(status));
        parked
          .nth(proposalsUrl(connection), 0)
          .resolve(json([{ ...proposal, id: 'proposal/a', title: 'Daemon A proposal' }]));
        await drain();
      });
      const after = JSON.stringify(renderer.toJSON());
      expect(after).toContain('Daemon B proposal');
      expect(after).not.toContain('Daemon A proposal');
      expect(after).not.toContain('"role":"alert"');
    } finally {
      parked.restore();
    }
  });

  it('drops a superseded daemon rejection so no stale error reaches the new daemon', async () => {
    const parked = installParkedFetch();
    try {
      const renderer = render(<LearningPage connection={connection} now={0} />);
      await runAsync(async () => {
        await Promise.resolve();
      });
      run(() => renderer.update(<LearningPage connection={connectionB} now={0} />));
      await runAsync(async () => {
        await Promise.resolve();
      });
      // Clearing belongs to the re-scoped render itself. While B is still
      // parked, no committed frame may retain A's proposal or busy state.
      const whileBLoads = JSON.stringify(renderer.toJSON());
      expect(whileBLoads).toContain('Reading learning proposals…');
      expect(whileBLoads).not.toContain(proposal.title);
      expect(runButton(renderer).props.disabled).toBe(false);
      await runAsync(async () => {
        parked.nth(statusUrl(connectionB), 0).resolve(json(status));
        parked
          .nth(proposalsUrl(connectionB), 0)
          .resolve(json([{ ...proposal, id: 'proposal/b', title: 'Daemon B proposal' }]));
        await drain();
      });
      // A's Promise.all now rejects — late. Its error must not stamp over B.
      await runAsync(async () => {
        parked.nth(statusUrl(connection), 0).reject(new Error('daemon A is offline'));
        await drain();
      });
      const after = JSON.stringify(renderer.toJSON());
      expect(after).toContain('Daemon B proposal');
      expect(after).not.toContain('Daemon A proposal');
      expect(after).not.toContain('offline');
      expect(after).not.toContain('"role":"alert"');
    } finally {
      parked.restore();
    }
  });

  it('drops a stale load even when its daemonId is re-selected (A to B to A)', async () => {
    // The daemonId-equality fence has an ABA hole: after A→B→A the first A's
    // daemonId matches the current connection again, so its late settle would
    // publish over the second A's fresh load. The monotonic epoch closes it.
    const parked = installParkedFetch();
    try {
      const renderer = render(<LearningPage connection={connection} now={0} />); // scope 0, A load #0
      await runAsync(async () => {
        await Promise.resolve();
      });
      run(() => renderer.update(<LearningPage connection={connectionB} now={0} />)); // scope 1, B load
      await runAsync(async () => {
        await Promise.resolve();
      });
      run(() => renderer.update(<LearningPage connection={connection} now={0} />)); // scope 2, A load #1
      await runAsync(async () => {
        await Promise.resolve();
      });
      // B's load and the FIRST A load settle late — both fenced, even though the
      // first A's daemonId now matches the current connection again.
      await runAsync(async () => {
        parked.nth(statusUrl(connectionB), 0).resolve(json(status));
        parked.nth(proposalsUrl(connectionB), 0).resolve(json([{ ...proposal, id: 'b', title: 'B only' }]));
        parked.nth(statusUrl(connection), 0).resolve(json(status)); // first A load
        parked.nth(proposalsUrl(connection), 0).resolve(json([{ ...proposal, id: 'a1', title: 'A first' }]));
        await drain();
      });
      let text = JSON.stringify(renderer.toJSON());
      expect(text).not.toContain('B only');
      expect(text).not.toContain('A first');
      // Only the SECOND A load (current scope) may publish.
      await runAsync(async () => {
        parked.nth(statusUrl(connection), 1).resolve(json(status)); // second A load
        parked.nth(proposalsUrl(connection), 1).resolve(json([{ ...proposal, id: 'a2', title: 'A second' }]));
        await drain();
      });
      text = JSON.stringify(renderer.toJSON());
      expect(text).toContain('A second');
      expect(text).not.toContain('A first');
      expect(text).not.toContain('B only');
      expect(text).not.toContain('"role":"alert"');
    } finally {
      parked.restore();
    }
  });

  it('drops a stale accept and scan so neither their reload nor their failure reaches the switched daemon', async () => {
    // Exercises the render-time epoch capture specifically: the stale `act`
    // re-enters its OWN old `load` after the switch. If `load` read the epoch at
    // invocation it would see the current scope and publish daemon A over B;
    // owning the epoch from its render is what fences it.
    const parked = installParkedFetch();
    try {
      const renderer = render(<LearningPage connection={connection} now={0} />);
      await runAsync(async () => {
        parked.nth(statusUrl(connection), 0).resolve(json(status));
        parked.nth(proposalsUrl(connection), 0).resolve(json([proposal]));
        await drain();
      });
      // Start an accept (mutation parks) and a scan (scan parks) on daemon A.
      await runAsync(async () => {
        acceptButton(renderer).props.onClick();
        runButton(renderer).props.onClick();
        await Promise.resolve();
      });
      // Switch to daemon B: the view clears (busy reset) and B's load parks.
      run(() => renderer.update(<LearningPage connection={connectionB} now={0} />));
      await runAsync(async () => {
        await Promise.resolve();
      });
      await runAsync(async () => {
        parked.nth(statusUrl(connectionB), 0).resolve(json(status));
        parked
          .nth(proposalsUrl(connectionB), 0)
          .resolve(json([{ ...proposal, id: 'proposal/b', title: 'Daemon B proposal' }]));
        await drain();
      });
      // Daemon A's accept mutation succeeds late → its `act` re-enters its old
      // `load` (which fetches A), and daemon A's scan rejects late. Both fenced.
      await runAsync(async () => {
        parked.nth(actionUrl(connection, proposal.id), 0).resolve(json(proposal));
        await drain(); // let the stale act reach its reload and park A status/proposals #1
      });
      await runAsync(async () => {
        parked.nth(statusUrl(connection), 1).resolve(json(status));
        parked
          .nth(proposalsUrl(connection), 1)
          .resolve(json([{ ...proposal, id: 'proposal/a', title: 'Daemon A proposal' }]));
        parked.nth(runUrl(connection), 0).reject(new Error('daemon A scan failed'));
        await drain();
      });
      const after = JSON.stringify(renderer.toJSON());
      expect(after).toContain('Daemon B proposal');
      expect(after).not.toContain('Daemon A proposal');
      expect(after).not.toContain('scan failed');
      expect(after).not.toContain('"role":"alert"');
      // busy was reset on the scope change and the stale finalizers never ran.
      expect(runButton(renderer).props.disabled).toBe(false);
    } finally {
      parked.restore();
    }
  });

  it('keeps the controls busy until every overlapping same-scope operation finishes', async () => {
    // `busy` is a counter, not a boolean: with two ops in flight, finishing one
    // must leave the controls disabled until the other finishes too.
    const parked = installParkedFetch();
    const manifest = {
      runId: 'run-a',
      startedAt: '2026-07-31T12:00:00.000Z',
      sessionsScanned: 1,
      sessionsWithSignal: 1,
      minerSessions: [],
      observationsProposed: 1,
      observationsVerified: 1,
      rejectedQuotes: 0,
      malformedFiles: 0,
      proposalsCreated: 1,
      proposalsStrengthened: 0,
      proposalsSuppressedByTombstone: 0,
      perHarness: { claude: 0, codex: 1 },
    };
    try {
      const renderer = render(<LearningPage connection={connection} now={0} />);
      await runAsync(async () => {
        parked.nth(statusUrl(connection), 0).resolve(json(status));
        parked.nth(proposalsUrl(connection), 0).resolve(json([proposal]));
        await drain();
      });
      expect(runButton(renderer).props.disabled).toBe(false);
      // Two overlapping operations on the same daemon.
      await runAsync(async () => {
        acceptButton(renderer).props.onClick();
        runButton(renderer).props.onClick();
        await Promise.resolve();
      });
      expect(runButton(renderer).props.disabled).toBe(true);
      // The accept finishes (mutation + reload); the scan is still running.
      await runAsync(async () => {
        parked.nth(actionUrl(connection, proposal.id), 0).resolve(json(proposal));
        await drain();
      });
      await runAsync(async () => {
        parked.nth(statusUrl(connection), 1).resolve(json(status));
        parked.nth(proposalsUrl(connection), 1).resolve(json([proposal]));
        await drain();
      });
      expect(runButton(renderer).props.disabled).toBe(true);
      // The scan finishes (scan + reload); busy returns to zero.
      await runAsync(async () => {
        parked.nth(runUrl(connection), 0).resolve(json(manifest));
        await drain();
      });
      await runAsync(async () => {
        parked.nth(statusUrl(connection), 2).resolve(json(status));
        parked.nth(proposalsUrl(connection), 2).resolve(json([proposal]));
        await drain();
      });
      expect(runButton(renderer).props.disabled).toBe(false);
    } finally {
      parked.restore();
    }
  });
});
