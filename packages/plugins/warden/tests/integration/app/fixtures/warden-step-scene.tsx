/**
 * The Warden's first-run page over fake data, drawn the way the setup flow draws a page: inside the shared `StepPageFrame`,
 * with a host whose `commit` the footer's Next runs (contract rule 8). Voice's Jev key row is a STAND-IN here (a package
 * reaches another only through its contract), so THIS scene proves the page's own layout and its commit (one write), not
 * the key row: the REAL Warden page over the REAL registered Voice row, in one Chromium flow, is
 * `packages/app/tests/integration/onboarding-e2e.visual.test.ts` (the Warden segment). The daemon is fake and records what reached it on
 * `window.__fake` (never the key's text).
 *
 *   ?theme=<family>-<mode>   ?key=missing|set|off  (what the machine holds before the page opens)
 *   ?save=fail               the first write of warden.yaml is refused
 */
import { StepPageFrame } from '@ferretry/app';
import { SecretInput, useSecretField } from '@ferretry/app/ui';
import { useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { StepHost } from '@ferretry/kernel/contract';
import { WardenStepPage, type WardenStepDeps } from '../../../../app/features/onboarding/warden-step-page.tsx';
import type { WardenConfig } from '../../../../app/wire.ts';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';
const initial = params.get('key') ?? 'missing';
const failFirstSave = params.get('save') === 'fail';

interface Fake {
  puts: { name: string; length: number }[];
  tests: string[];
  /** Every write of warden.yaml the page asked for; `named`: the SAME write also names the Jev key (never a second one). */
  writes: { enabled: boolean; jev: boolean; llm: boolean; named: boolean }[];
  /** Calls of the separate naming route: the page must make none. */
  names: number;
  done: number;
  advanced: boolean;
  /** The last key typed into the field was exactly what the vault route got (compared in the page, never exposed). */
  putMatchedTyped: boolean[];
}
const fake: Fake = { puts: [], tests: [], writes: [], names: 0, done: 0, advanced: false, putMatchedTyped: [] };
(window as unknown as { __fake: Fake }).__fake = fake;

let stored = initial === 'set';
let named = false;
let refused = failFirstSave;

const config = { enabled: true, layers: { jev: false, llm: false }, accounts: [] } as unknown as WardenConfig;
const view = () => ({
  config,
  accounts: [],
  warnings: [],
  jevKey: named ? ('named' as const) : ('not_named' as const),
});

const speedups = () => ({
  vault: 'ok' as const,
  providers: [
    {
      provider: 'jev' as const,
      label: 'Jev',
      purpose: 'Triage.',
      costNote: 'Cheap.',
      privacyNote: 'A summary.',
      keyUrl: 'https://keys.example.test/',
      testNote: 'One decision.',
      secretName: 'JEV_API_KEY',
      set: stored,
      testStale: false,
    },
  ],
});

const deps: WardenStepDeps = {
  client: {
    config: async () => view(),
    updateConfig: async (
      patch: { enabled?: boolean; layers?: { jev: boolean; llm: boolean } },
      options?: { nameJevKey?: boolean },
    ) => {
      if (refused) {
        refused = false;
        throw new Error('The machine refused the write.');
      }
      fake.writes.push({
        enabled: patch.enabled === true,
        jev: patch.layers?.jev === true,
        llm: patch.layers?.llm === true,
        named: options?.nameJevKey === true,
      });
      if (options?.nameJevKey === true) named = true;
      return view();
    },
    nameJevKey: async () => {
      fake.names += 1;
      named = true;
      return view();
    },
  } as unknown as WardenStepDeps['client'],
  readFile: async () => ({ exists: false }),
  readKey: async () => (initial === 'off' ? 'off' : speedups()),
};

/** The vault route takes the key in and never answers with it; a Test is one provider call. */
const vault = {
  put: (name: string, value: string): void => {
    fake.puts.push({ name, length: value.length });
    stored = true;
  },
  test: (): void => {
    fake.tests.push('/v1/speedups/jev/test');
  },
};

/** The few rules of Voice's `voice-settings.css` the row relies on, copied for the stand-in. */
const VOICE_ROW_CSS = `.fy-vs-field{align-items:center;display:flex;flex-wrap:wrap;gap:8px;min-width:0}
.fy-vs-field>.fy-vs-input{min-height:44px;flex:1 1 14rem;max-width:28rem;min-width:0}
.fy-vs-field>.kt-btn,.fy-vs-field>button{align-items:center;display:inline-flex;flex:none;gap:6px;justify-content:center;min-height:44px}
.fy-vs-body{display:flex;flex-direction:column;gap:8px;min-width:0;padding:4px 4px 12px var(--pad-panel,16px)}
.fy-vs-note{color:var(--muted);font-size:var(--text-sm);line-height:1.4;margin:0}
.fy-vs-note[data-tone=ok]{color:var(--ok)}`;

/** Stand-in for Voice's `speedup-key` panel: write-only field, Save, Test and the last Test's line. */
function FakeVoiceKeyRow() {
  const key = useSecretField(typed => typed.trim().length);
  const [, again] = useState(0);
  const [tested, setTested] = useState(false);
  return (
    <div className="fy-vs" data-speedup-key-row="jev">
      <style>{VOICE_ROW_CSS}</style>
      <div className="fy-vs-body">
        <p className="fy-vs-note text-fg">
          Jev key{' '}
          {stored ? (
            <span data-speedup-set="">Set</span>
          ) : (
            <span className="rounded-control bg-surface-2 px-2 py-0.5 text-meta font-medium text-faint">Not set</span>
          )}
        </p>
      </div>
      <form
        className="fy-vs-body"
        onSubmit={event => {
          event.preventDefault();
          if (key.length < 8) return;
          vault.put('JEV_API_KEY', key.read().trim());
          key.clear();
          again(n => n + 1);
        }}
      >
        <div className="fy-vs-field">
          {stored ? null : (
            <>
              <SecretInput
                field={key}
                aria-label="Jev key (JEV_API_KEY)"
                className="kt-input fy-vs-input min-h-[44px] rounded-control border border-border bg-surface-2 px-2 text-fg"
                placeholder="paste it here — it is never shown again"
              />
              <button type="submit" className="kt-btn" data-variant="primary" disabled={key.length < 8}>
                Save
              </button>
            </>
          )}
          <button
            type="button"
            className="kt-btn"
            aria-label="Test the Jev key"
            disabled={!stored}
            onClick={() => {
              vault.test();
              setTested(true);
            }}
          >
            Test
          </button>
        </div>
        <p className="fy-vs-note">
          <a
            href="https://keys.example.test/"
            target="_blank"
            rel="noreferrer noopener"
            className="text-accent underline"
          >
            Get a key
          </a>
        </p>
        {tested ? (
          <p className="fy-vs-note" data-tone="ok" role="status" data-speedup-last-test="">
            Worked just now. The key works.
          </p>
        ) : null}
      </form>
    </div>
  );
}

function Host() {
  const save = useRef<(() => Promise<void>) | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [moved, setMoved] = useState(false);
  const hostRef = useRef<StepHost | null>(null);
  hostRef.current ??= {
    phase: 'daemon',
    appliesTo: [],
    segment: {},
    remember: () => undefined,
    ready: () => setReady(true),
    skip: () => undefined,
    notNeeded: () => undefined,
    commit: next => {
      save.current = next;
    },
    done: () => {
      fake.done += 1;
    },
    busy: () => undefined,
    next: () => undefined,
    back: () => undefined,
  };
  const press = () => {
    const run = save.current;
    if (run === null || busy) return;
    setBusy(true);
    setError(null);
    new Promise<void>(resolve => resolve(run()))
      .then(
        () => {
          fake.advanced = true;
          setMoved(true);
        },
        (cause: unknown) => setError(cause instanceof Error ? cause.message : 'That could not be saved.'),
      )
      .finally(() => setBusy(false));
  };
  if (moved) return <main data-next-page="">The next page</main>;
  return (
    <div style={{ height: '100vh', overflow: 'auto' }}>
      <StepPageFrame
        title="Let the Warden watch your ferrets?"
        back={{ onClick: () => undefined }}
        next={{ label: 'Next', disabled: !ready, busy, onClick: press }}
        {...(error === null
          ? {}
          : {
              note: (
                <p role="alert" data-flow-commit-error="">
                  {error}
                </p>
              ),
            })}
      >
        <WardenStepPage deps={deps} step={hostRef.current} keyRow={<FakeVoiceKeyRow />} />
      </StepPageFrame>
    </div>
  );
}

const root = document.getElementById('root');
if (root !== null) createRoot(root).render(<Host />);
