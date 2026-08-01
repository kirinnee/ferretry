import { describe, expect, it } from 'bun:test';
import type { ProposalView } from '@ferretry/protocol';
import { daemonConnection } from '../../../src/lib/daemon-connection.ts';
import {
  LearningPage,
  LearningReview,
  ProposalCard,
  absoluteTime,
  learningErrorMessage,
  learningStrength,
} from '../../../src/features/learning/learning-page.tsx';
import type { MediaQueryListLike } from '../../../src/features/learning/use-touch-affected.ts';
import { render, run, runAsync } from '../../support/react.ts';
import { proposal, status } from '../learning-api.test.ts';

/** Pins the pointer modality so `autoFocus` is a decision, not an accident. */
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
const makeProposal = (state: ProposalView['state'], occurrences: number, id: string): ProposalView => ({
  ...proposal,
  id,
  state,
  occurrences,
  title: `${state} ${id}`,
});

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

  it('autofocuses the rule editor on a pointer device and never on a touch one', () => {
    const openEditor = (desktop: boolean) =>
      withModality(desktop, () => {
        const renderer = render(
          <ProposalCard
            connection={connection}
            proposal={makeProposal('pending', 2, 'focus')}
            busy={false}
            accepted={false}
            onAction={() => undefined}
          />,
        );
        run(() => renderer.root.findByProps({ 'aria-label': 'Edit pending focus' }).props.onClick());
        return renderer.root.findByType('textarea').props.autoFocus;
      });

    expect(openEditor(true)).toBe(true);
    expect(openEditor(false)).toBe(false);
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
});
