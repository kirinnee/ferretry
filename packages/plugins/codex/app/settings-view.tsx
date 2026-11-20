/** The current Agent CLIs panel, narrowed to Codex and bound to the plugin client. */
import { Badge, Button, SettingGroup, SettingRow } from '@ferretry/app';
import { cn, Loading } from '@ferretry/app/ui';
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

/** When the last check ran, in the reader's own clock (the raw instant when it cannot be read). */
const checkedWords = (instant: string): string => {
  const when = new Date(instant);
  return Number.isNaN(when.getTime()) ? instant : when.toLocaleString();
};

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
    return <Loading kind="page" label="Reading which Codex this machine runs, and checking for newer versions…" />;
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
  const located = view.location.state === 'located';
  const latest = knownLatest(view.check);
  const detail = 'm-0 -mt-1 break-words pb-2 pl-panel pr-1 text-meta leading-tight text-muted';
  return (
    <section aria-labelledby="codex-heading" className="flex min-w-0 flex-col">
      <SettingGroup label="Codex">
        <SettingRow
          name={headline(view)}
          hint={
            <span id="codex-heading">
              {located ? badge.text : 'Not found'}
              {view.available ? ' · Update available' : ''}
            </span>
          }
          control={() => (
            <Badge tone={!located ? 'err' : view.available ? 'warn' : badge.tone}>
              {located ? (view.available ? 'Update' : 'Installed') : 'Not found'}
            </Badge>
          )}
        />
        <SettingRow name="Runs" hint={locationWords(view.location)}>
          <p className={cn(detail, 'text-ui text-fg')}>
            {view.location.state === 'absent' ? 'nothing' : view.location.path}
          </p>
        </SettingRow>
        {install === undefined ? null : (
          <SettingRow name="Installed with">
            <p className={cn(detail, '-mt-3 text-ui text-fg')}>{install}</p>
          </SettingRow>
        )}
        {view.installed?.state === 'unreadable' ? <SettingRow name="Version" hint={view.installed.reason} /> : null}
        <SettingRow name="Verified" control={() => <span className="text-ui text-fg">{view.verified.version}</span>} />
        <SettingRow
          name="Latest"
          hint={view.check.state === 'never' ? 'Not checked yet.' : `Checked ${checkedWords(view.check.checkedAt)}`}
          {...(view.check.state === 'never'
            ? {}
            : { control: () => <span className="text-ui text-fg">{latest ?? 'Unknown'}</span> })}
        >
          {view.check.state === 'failed' ? <p className={detail}>{view.check.reason}</p> : null}
        </SettingRow>
      </SettingGroup>
      {view.job === null ? null : (
        <p className="m-0 mb-6 text-ui text-fg" role="status">
          {jobWords(view.job).text}
        </p>
      )}
      {plan?.kind === undefined && confirming === null ? null : (
        <SettingGroup label="Update">
          {confirming === null ? (
            <>
              {plan?.kind === 'manual' ? (
                <li className="flex min-w-0 flex-col gap-2 py-3 pl-panel pr-1 text-ui text-fg">
                  <p className="m-0">{plan.explanation}</p>
                  <ol className="m-0 flex flex-col gap-1 pl-5">
                    {plan.steps.map(step => (
                      <li key={step.command}>
                        <code>{step.command}</code>
                        {step.note === undefined ? null : <p className="m-0 text-meta text-muted">{step.note}</p>}
                      </li>
                    ))}
                  </ol>
                </li>
              ) : null}
              {updateChoices(view).length === 0 ? null : (
                <SettingRow
                  name="Update"
                  wide
                  control={() => (
                    <span className="flex flex-wrap items-center gap-2">
                      {updateChoices(view).map(choice => (
                        <Button
                          key={choice.key}
                          variant={choice.primary ? 'primary' : 'outline'}
                          disabled={busy || polling}
                          onClick={() => {
                            if (choice.unverified) setConfirming({ target: choice.target });
                            else void send({ target: choice.target });
                          }}
                        >
                          {choice.label}
                        </Button>
                      ))}
                    </span>
                  )}
                />
              )}
              {plan?.kind === 'self' ? (
                <li className={cn(detail, 'pt-2')}>
                  Runs {plan.steps.map(step => step.command).join(', then ')}.{' '}
                  {plan.rollback === 'automatic'
                    ? 'If the new version does not start, the old one is put back.'
                    : 'This install method keeps no previous version, so a failed update cannot be undone on its own.'}
                </li>
              ) : null}
            </>
          ) : (
            <li className="min-w-0">
              <fieldset
                aria-label="Not yet verified by Ferretry"
                className="m-0 flex min-w-0 flex-col gap-2 border-0 border-l-2 border-warn py-2 pl-panel pr-1 text-ui text-fg"
              >
                <p className="m-0">{unverifiedQuestion(view, confirming.target)}</p>
                <a href={view.verified.url} target="_blank" rel="noreferrer noopener" className="text-accent">
                  What Ferretry verifies, and the known risks
                </a>
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="primary"
                    disabled={busy}
                    onClick={() => {
                      void send({ ...confirming, confirmUnverified: true });
                    }}
                  >
                    Update anyway
                  </Button>
                  <Button disabled={busy} onClick={() => setConfirming(null)}>
                    Cancel
                  </Button>
                </div>
              </fieldset>
            </li>
          )}
        </SettingGroup>
      )}
      {refusal === null ? null : (
        <p className="m-0 mb-6 text-meta text-err" role="alert">
          {refusal}
        </p>
      )}
      <p className="m-0 text-meta text-muted">
        Updating replaces Codex for new ferrets. Running ferrets keep their current version until they are restarted.
      </p>
    </section>
  );
}
