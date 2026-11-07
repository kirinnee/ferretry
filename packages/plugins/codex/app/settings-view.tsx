/** The current Agent CLIs panel, narrowed to Codex and bound to the plugin client. */
import { useEffect, useState } from 'react';
import type { HarnessCliView } from '../contract/index.ts';
import type { CodexSettings } from './codex-settings.ts';
import {
  headline,
  installWords,
  jobWords,
  knownLatest,
  locationWords,
  shouldPoll,
  unverifiedQuestion,
  updateChoices,
  verificationBadge,
} from './lib/model.ts';

type Loaded = { kind: 'loading' } | { kind: 'view'; view: HarnessCliView } | { kind: 'failed'; reason: string };
interface Confirmation {
  readonly target?: string;
}

export function CodexSettingsView({ settings }: { readonly settings: CodexSettings }) {
  const [loaded, setLoaded] = useState<Loaded>({ kind: 'loading' });
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState<Confirmation | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    setLoaded({ kind: 'loading' });
    const load = () =>
      settings
        .load()
        .then(view => {
          if (current) setLoaded({ kind: 'view', view });
        })
        .catch((cause: unknown) => {
          if (current) setLoaded({ kind: 'failed', reason: cause instanceof Error ? cause.message : String(cause) });
        });
    const cancel = settings.watch(() => {
      void load();
    });
    void load();
    return () => {
      current = false;
      cancel();
    };
  }, [settings]);
  const polling = loaded.kind === 'view' && shouldPoll(loaded.view);

  const send = async (request: { target?: string; confirmUnverified?: boolean }) => {
    setBusy(true);
    setRefusal(null);
    try {
      const result = await settings.update(request);
      if (result.started) {
        setLoaded({ kind: 'view', view: result.view });
        setConfirming(null);
      } else if (result.refusal.kind === 'unverified') setConfirming({ target: result.refusal.target });
      else {
        setRefusal(result.refusal.text);
        setConfirming(null);
      }
    } finally {
      setBusy(false);
    }
  };

  if (loaded.kind === 'loading')
    return (
      <section aria-label="Codex" role="status">
        Reading which Codex this machine runs, and checking for newer versions…
      </section>
    );
  if (loaded.kind === 'failed')
    return (
      <section aria-label="Codex">
        <h3>Codex unavailable</h3>
        <p role="alert">{loaded.reason}</p>
      </section>
    );
  const view = loaded.view;
  const badge = verificationBadge(view.verification);
  const install = installWords(view.method);
  const plan = view.plan;
  return (
    <section aria-labelledby="codex-heading" className="kt-panel p-panel">
      <h3 id="codex-heading">{headline(view)}</h3>
      <p>
        {view.location.state === 'located' ? badge.text : 'Not found'}
        {view.available ? ' · Update available' : ''}
      </p>
      <dl>
        <dt>Runs</dt>
        <dd>
          {view.location.state === 'absent' ? 'nothing' : view.location.path}
          <small style={{ display: 'block' }}>{locationWords(view.location)}</small>
        </dd>
        {install === undefined ? null : (
          <>
            <dt>Installed with</dt>
            <dd>{install}</dd>
          </>
        )}
        {view.installed?.state === 'unreadable' ? (
          <>
            <dt>Version</dt>
            <dd>{view.installed.reason}</dd>
          </>
        ) : null}
        <dt>Verified</dt>
        <dd>{view.verified.version}</dd>
        <dt>Latest</dt>
        <dd>
          {view.check.state === 'never' ? (
            'Not checked yet.'
          ) : (
            <>
              {knownLatest(view.check) ?? 'Unknown'} · Checked {view.check.checkedAt}
              {view.check.state === 'failed' ? ': ' + view.check.reason : ''}
            </>
          )}
        </dd>
      </dl>
      {view.job === null ? null : <p role="status">{jobWords(view.job).text}</p>}
      {confirming === null ? (
        <>
          {plan?.kind === 'manual' ? (
            <>
              <p>{plan.explanation}</p>
              <ol>
                {plan.steps.map(step => (
                  <li key={step.command}>
                    <code>{step.command}</code>
                    {step.note === undefined ? null : <p>{step.note}</p>}
                  </li>
                ))}
              </ol>
            </>
          ) : null}
          {updateChoices(view).map(choice => (
            <button
              type="button"
              key={choice.key}
              disabled={busy || polling}
              onClick={() => {
                if (choice.unverified) setConfirming({ target: choice.target });
                else void send({ target: choice.target });
              }}
            >
              {choice.label}
            </button>
          ))}
          {plan?.kind === 'self' ? (
            <p>
              Runs {plan.steps.map(step => step.command).join(', then ')}.{' '}
              {plan.rollback === 'automatic'
                ? 'If the new version does not start, the old one is put back.'
                : 'This install method keeps no previous version, so a failed update cannot be undone on its own.'}
            </p>
          ) : null}
        </>
      ) : (
        <fieldset aria-label="Not yet verified by Ferretry">
          <p>{unverifiedQuestion(view, confirming.target)}</p>
          <a href={view.verified.url} target="_blank" rel="noreferrer noopener">
            What Ferretry verifies, and the known risks
          </a>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              void send({ ...confirming, confirmUnverified: true });
            }}
          >
            Update anyway
          </button>
          <button type="button" disabled={busy} onClick={() => setConfirming(null)}>
            Cancel
          </button>
        </fieldset>
      )}
      {refusal === null ? null : <p role="alert">{refusal}</p>}
      <p>
        Updating replaces Codex for new ferrets. Running ferrets keep their current version until they are restarted.
      </p>
    </section>
  );
}
