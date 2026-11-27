import { relativeTime } from '@ferretry/app';
import { type ChangeAuthority, Button, Loading, SetupNote, SetupSection } from '@ferretry/app/ui';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { BrowserIdentitiesView, BrowserIdentityRow } from '../../../contract/index.ts';
import { readBrowserIdentities, stopBrowserIdentity } from '../../lib/browser-identities.ts';
import { type BrowsersChange, type BrowsersDocument, newIdentityProblem } from '../../lib/browsers-config.ts';
import { type CallClient, reasonOf } from '../../lib/clients.ts';
import { mayChange, type SaveOutcome } from './browser-mode-section.tsx';
import './browser-identities.css';

/** Said on an identity the file names and the daemon does not yet run with: it loosens, so the owner confirms it first. */
export const IDENTITY_WAITS_WORDS = 'Waits for you: saved, but not in effect until you confirm it.';

/** What the section says about what an identity is for, once, above the list. */
const IDENTITIES_INTRO =
  'Each identity is its own Chrome with its own sign-ins, so two accounts on one site can be open at once. Stopping one closes only its pages; everything it signed in to is kept.';

type Reading =
  | { readonly kind: 'reading' }
  | { readonly kind: 'shown'; readonly view: BrowserIdentitiesView }
  | { readonly kind: 'unavailable'; readonly sentence: string };

/** Where an identity's traffic goes, by the proxy's name: never how it signs in. */
const identityProxyWords = (row: BrowserIdentityRow): string =>
  row.proxy === undefined
    ? 'Direct, no proxy'
    : `Via ${row.proxy.name}${row.proxy.own ? '' : ' (the machine’s proxy)'}`;

const stateWords = (row: BrowserIdentityRow): string =>
  row.running ? `Running${row.startedAt === undefined ? '' : ` since ${relativeTime(row.startedAt)}`}` : 'Stopped';

/** Said only for an identity that is stopped: a running one says since when it runs. */
const lastUsedWords = (row: BrowserIdentityRow): string =>
  row.lastUsedAt === undefined ? 'Never opened' : `Last used ${relativeTime(row.lastUsedAt)}`;

/** The facts about an identity on one line; each wraps whole (a proxy name never breaks at its own hyphen) unless it is wider than the row. */
function DetailLine({ parts }: { readonly parts: readonly string[] }) {
  return (
    <p className="fy-browser-identity__line" data-browser-identity-detail="">
      {parts.map((part, at) => (
        <span key={part} className="fy-browser-identity__fact">
          {at < parts.length - 1 ? `${part} · ` : part}
        </span>
      ))}
    </p>
  );
}

/** An identity the file holds for the owner: named in `browsers.yaml`, not yet one the daemon opens. */
function waitingKeys(document: BrowsersDocument, view: BrowserIdentitiesView): readonly string[] {
  if (!document.held) return [];
  const known = new Set(view.identities.map(row => row.identity));
  return Object.keys(document.config.identities ?? {}).filter(key => !known.has(key));
}

/**
 * "Identities" (docs/browser-mode.md): every browser identity the daemon would open, running or not, with the engine
 * and the proxy it goes through by NAME, and when it was last used. Add one (a write of `browsers.yaml` through the
 * config proposal, so a proxy that loosens waits for the owner) or stop one.
 */
export function BrowserIdentitiesSection({
  client,
  document,
  authority,
  save,
}: {
  readonly client: CallClient;
  readonly document: BrowsersDocument;
  readonly authority: ChangeAuthority | null;
  readonly save: (change: BrowsersChange) => Promise<SaveOutcome>;
}) {
  const ids = useId();
  const [reading, setReading] = useState<Reading>({ kind: 'reading' });
  const [key, setKey] = useState('');
  const [proxyUrl, setProxyUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [stopping, setStopping] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<SaveOutcome | null>(null);
  const [stopFailed, setStopFailed] = useState<string | null>(null);
  const load = useCallback((): (() => void) => {
    let current = true;
    readBrowserIdentities(client).then(
      view => {
        if (current) setReading({ kind: 'shown', view });
      },
      (caught: unknown) => {
        if (current) setReading({ kind: 'unavailable', sentence: reasonOf(caught) });
      },
    );
    return () => {
      current = false;
    };
  }, [client]);
  useEffect(() => load(), [load]);
  // The file changed (a write took, or a held one was confirmed): what the daemon opens is read again.
  const readAt = useRef(document.etag);
  useEffect(() => {
    if (readAt.current === document.etag) return undefined;
    readAt.current = document.etag;
    return load();
  }, [document.etag, load]);

  const problem = key === '' ? undefined : newIdentityProblem(document.text, key, proxyUrl);
  const add = (): void => {
    setBusy(true);
    setOutcome(null);
    void save({ identity: { key, ...(proxyUrl.trim() === '' ? {} : { proxyUrl }) } }).then(result => {
      setBusy(false);
      setOutcome(result);
      if (result.kind !== 'refused') {
        setKey('');
        setProxyUrl('');
      }
    });
  };
  const stop = (identity: string): void => {
    setStopping(identity);
    setStopFailed(null);
    stopBrowserIdentity(client, identity).then(
      () => {
        setStopping(null);
        load();
      },
      (caught: unknown) => {
        setStopping(null);
        setStopFailed(reasonOf(caught));
      },
    );
  };

  const waiting = reading.kind === 'shown' ? waitingKeys(document, reading.view) : [];
  return (
    <SetupSection title="Identities" name="browser-identities" saves="on-save">
      <p className="m-0 max-w-xl text-meta leading-base text-muted" data-browser-identities-intro="">
        {IDENTITIES_INTRO}
      </p>
      {reading.kind === 'reading' ? <Loading kind="bar" label="Reading this machine’s identities…" /> : null}
      {reading.kind === 'unavailable' ? (
        <SetupNote tone="warn" name="browser-identities-unavailable" title="This machine’s identities did not load">
          <span data-browser-identities-reason="">{reading.sentence}</span>
        </SetupNote>
      ) : null}
      {reading.kind === 'shown' ? (
        <ul className="fy-browser-identities" data-browser-identities="">
          {reading.view.identities.map(row => (
            <li key={row.identity} className="fy-browser-identity" data-browser-identity={row.identity}>
              <div className="fy-browser-identity__head">
                <code className="fy-browser-identity__name">{row.identity}</code>
                {row.builtIn ? <span className="fy-browser-identity__badge">Built in</span> : null}
                <span
                  className="fy-browser-identity__state"
                  data-browser-identity-running={row.running ? 'true' : 'false'}
                >
                  {stateWords(row)}
                </span>
                {row.running ? (
                  <Button
                    type="button"
                    size="sm"
                    disabled={stopping !== null}
                    aria-label={`Stop the ${row.identity} browser`}
                    data-browser-identity-stop={row.identity}
                    onClick={() => stop(row.identity)}
                  >
                    {stopping === row.identity ? 'Stopping…' : 'Stop'}
                  </Button>
                ) : null}
              </div>
              <DetailLine parts={['Chromium', identityProxyWords(row), ...(row.running ? [] : [lastUsedWords(row)])]} />
            </li>
          ))}
          {waiting.map(waits => (
            <li
              key={waits}
              className="fy-browser-identity fy-browser-identity--waits"
              data-browser-identity={waits}
              data-browser-identity-waits=""
            >
              <div className="fy-browser-identity__head">
                <code className="fy-browser-identity__name">{waits}</code>
                <span className="fy-browser-identity__state">{IDENTITY_WAITS_WORDS}</span>
              </div>
              <DetailLine
                parts={[
                  'Chromium',
                  document.config.identities?.[waits]?.proxy === undefined
                    ? 'Direct, no proxy'
                    : `Via ${new URL(document.config.identities[waits].proxy.url).host}`,
                ]}
              />
            </li>
          ))}
        </ul>
      ) : null}
      {stopFailed === null ? null : (
        <SetupNote live tone="warn" name="browser-identities-stop-refused">
          {stopFailed}
        </SetupNote>
      )}
      <div className="fy-browser-identities__add" data-browser-identity-add="">
        <div className="fy-browser-identities__field">
          <label htmlFor={`${ids}-key`} className="text-ui font-semibold text-fg">
            New identity name
          </label>
          <input
            id={`${ids}-key`}
            className="kt-input min-w-0 font-mono"
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            placeholder="work"
            value={key}
            disabled={busy}
            aria-invalid={problem !== undefined}
            data-browser-identity-key=""
            onChange={event => {
              setKey(event.target.value);
              setOutcome(null);
            }}
          />
        </div>
        <div className="fy-browser-identities__field">
          <label htmlFor={`${ids}-proxy`} className="text-ui font-semibold text-fg">
            Its own proxy (optional)
          </label>
          <input
            id={`${ids}-proxy`}
            className="kt-input min-w-0 font-mono"
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            placeholder="http://proxy.example:8080"
            value={proxyUrl}
            disabled={busy}
            data-browser-identity-proxy=""
            onChange={event => {
              setProxyUrl(event.target.value);
              setOutcome(null);
            }}
          />
        </div>
        {problem === undefined ? null : (
          <p className="m-0 text-meta leading-base text-err" role="alert" data-browser-identity-problem="">
            {problem}
          </p>
        )}
        <p className="m-0 max-w-xl text-meta leading-base text-muted">
          A proxy of its own is held for you to confirm, because it sees every site this identity visits. Leave it empty
          to use the machine’s.
        </p>
        <div>
          <Button
            type="button"
            variant="primary"
            disabled={busy || key === '' || problem !== undefined || !mayChange(authority)}
            data-browser-identity-submit=""
            onClick={add}
          >
            {busy ? 'Adding…' : 'Add identity'}
          </Button>
        </div>
      </div>
      {outcome?.kind === 'refused' ? (
        <SetupNote live tone="warn" name="browser-identities-refusal">
          {outcome.sentence}
        </SetupNote>
      ) : null}
      {outcome?.kind === 'pending' ? (
        <SetupNote live tone="warn" name="browser-identities-held">
          {IDENTITY_WAITS_WORDS}
        </SetupNote>
      ) : null}
    </SetupSection>
  );
}
