/**
 * Settings › Web search: pick a provider, paste its key, Test, and set the daily limit.
 *
 * WRITE-ONLY, LIKE EVERY SECRET. A pasted key goes to the Vault's `POST /v1/secrets` under the name the table gives and
 * the field clears; the daemon answers "named" and a count, never a value. Naming the key in `search.yaml` is the
 * owner's act (`PUT /v1/web-search/setup`): in effect when this device may confirm it, otherwise held, and the screen says so.
 */
import { SettingGroup, SettingRow } from '@ferretry/app';
import { SecretInput, SelectBox, useSecretField } from '@ferretry/app/ui';
import type { PluginClient } from '@ferretry/kernel/manifest';
import { Check, ExternalLink, FlaskConical, KeyRound } from 'lucide-react';
import { type FormEvent, useCallback, useEffect, useState } from 'react';
import {
  SEARCH_PROVIDER_IDS,
  SEARCH_PROVIDERS,
  type SearchProviderId,
  type SearchSetupResult,
  type SearchTestResult,
  type SearchView,
} from '../contract/index.ts';

/** The shortest value the Vault keeps as a secret; a shorter one is refused there. */
const MIN_KEY_LENGTH = 8;

type Client = Pick<PluginClient, 'call'>;

const reason = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

/** One line about a Test, or nothing when there was none. */
const testLine = (test: SearchTestResult | undefined): string | undefined =>
  test === undefined ? undefined : `${test.ok ? 'Worked' : 'Failed'}. ${test.message}`;

/** What a setup that did not take effect says, in the owner's words. */
const heldLine = (result: SearchSetupResult): string | undefined =>
  result.outcome === 'applied' && result.held.length === 0
    ? undefined
    : `Saved, but not in effect until you confirm it: ${result.held.join('; ')}.`;

export function SearchSettings({ client }: { readonly client: Client }) {
  const [view, setView] = useState<SearchView | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [picked, setPicked] = useState<SearchProviderId | null>(null);
  const [capDraft, setCapDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState<'saving' | 'testing' | 'limit' | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const key = useSecretField(typed => typed.trim().length);

  const read = useCallback(async () => {
    try {
      setView(await client.call<SearchView>('GET /v1/web-search', { quiet: true }));
      setFailure(null);
    } catch (cause) {
      setFailure(reason(cause));
    }
  }, [client]);

  useEffect(() => {
    void read();
  }, [read]);

  if (failure !== null)
    return (
      <p role="status" className="m-0 text-cell text-muted">
        This browser could not read this machine’s web search settings: {failure}
      </p>
    );
  if (view === null) return <p className="m-0 text-cell text-muted">Reading this machine’s web search settings…</p>;

  const provider = picked ?? view.provider ?? null;
  const info = provider === null ? null : SEARCH_PROVIDERS[provider];
  const typed = key.length >= MIN_KEY_LENGTH;
  const idle = busy === null;

  const act = async (kind: 'saving' | 'testing' | 'limit', work: () => Promise<string | null>) => {
    setBusy(kind);
    setError(null);
    setNote(null);
    try {
      setNote(await work());
      await read();
    } catch (cause) {
      setError(reason(cause));
    } finally {
      setBusy(null);
    }
  };

  const save = (event: FormEvent) => {
    event.preventDefault();
    if (info === null || provider === null || !idle) return;
    void act('saving', async () => {
      if (typed) await client.call('POST /v1/secrets', { body: { name: info.secretName, value: key.read().trim() } });
      key.clear();
      const result = await client.call<SearchSetupResult>('PUT /v1/web-search/setup', { body: { provider } });
      setPicked(null);
      return heldLine(result) ?? null;
    });
  };

  const saveLimit = (event: FormEvent) => {
    event.preventDefault();
    const value = Number(capDraft);
    if (capDraft === null || !Number.isInteger(value) || value < 1 || !idle) return;
    void act('limit', async () => {
      const result = await client.call<SearchSetupResult>('PUT /v1/web-search/setup', { body: { dailyCap: value } });
      setCapDraft(null);
      return heldLine(result) ?? null;
    });
  };

  const test = () =>
    void act('testing', async () => {
      await client.call<SearchTestResult>('POST /v1/web-search/test');
      return null;
    });

  const named = view.provider === provider && view.keyNamed;
  const line = testLine(view.lastTest);

  return (
    <div className="min-w-0" data-testid="search-settings">
      <SettingGroup label="Web search">
        <SettingRow
          name="What web search is"
          hint="For ferrets whose runtime has no search of its own"
          explanation={
            <div className="flex flex-col gap-2">
              <p className="m-0">
                Ferrets on a runtime with its own search keep using it. For the rest, this gives them a{' '}
                <code>web_search</code> tool answered by the provider you pick, with your own key.
              </p>
              <p className="m-0">
                It is off until you pick a provider and save a key. A ferret’s search text goes to that provider and
                nowhere else. Your key is stored on this machine and never shown again.
              </p>
            </div>
          }
        />
        <SettingRow
          name="Provider"
          hint={info === null ? 'None picked: web search is off' : info.priceNote}
          wide
          control={() => (
            <SelectBox
              className="min-h-[44px]"
              id="search-provider"
              label="Search provider"
              value={provider ?? ''}
              placeholder="Choose a provider…"
              onChange={chosen => setPicked(chosen as SearchProviderId)}
              options={SEARCH_PROVIDER_IDS.map(id => ({ value: id, label: SEARCH_PROVIDERS[id].label }))}
            />
          )}
        />
        {info !== null && provider !== null && (
          <SettingRow
            name={`${info.label} key`}
            hint={
              named ? (
                <span className="inline-flex items-center gap-1 text-ok" data-search-named="">
                  <Check size={12} aria-hidden="true" /> In use
                </span>
              ) : (
                'Not set up yet'
              )
            }
            wide
            dataAttributes={{ 'data-search-provider': provider }}
          >
            <form
              className="flex min-w-0 flex-wrap items-center gap-2 px-3 pb-3"
              onSubmit={save}
              aria-label={`Save the ${info.label} key`}
            >
              <SecretInput
                id="search-key"
                field={key}
                aria-label={`${info.label} key (${info.secretName})`}
                className="kt-input min-h-[44px] min-w-0 flex-[1_1_14rem] rounded-control border border-border bg-surface-2 px-2 text-fg"
                placeholder={named ? 'paste a new key to replace it' : 'paste it here — it is never shown again'}
              />
              <button type="submit" className="kt-btn" data-variant="primary" disabled={!idle || (named && !typed)}>
                <KeyRound size={14} aria-hidden="true" />{' '}
                {busy === 'saving' ? 'Saving…' : typed ? 'Save key' : 'Use this provider'}
              </button>
              <button type="button" className="kt-btn" disabled={!idle || !named} onClick={test}>
                <FlaskConical size={14} aria-hidden="true" /> {busy === 'testing' ? 'Testing…' : 'Test'}
              </button>
              <p className="m-0 basis-full text-meta text-muted">
                Get a key:{' '}
                <a
                  href={info.keyUrl}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="break-all text-accent underline"
                >
                  {info.keyUrl}
                  <ExternalLink size={12} aria-hidden="true" className="ml-1 inline align-baseline" />
                </a>
                . Test runs one real search (it counts toward today’s limit). Saved as <code>{info.secretName}</code>.
              </p>
            </form>
          </SettingRow>
        )}
        <SettingRow
          name="Daily limit"
          hint={`${String(view.usedToday)} of ${String(view.dailyCap)} searches used today`}
          wide
        >
          <form
            className="flex flex-wrap items-center gap-2 px-3 pb-3"
            onSubmit={saveLimit}
            aria-label="Daily search limit"
          >
            <input
              type="number"
              inputMode="numeric"
              min={1}
              aria-label="Searches a day"
              className="kt-input min-h-[44px] w-32 max-w-[8rem] rounded-control border border-border bg-surface-2 px-2 text-fg"
              value={capDraft ?? String(view.dailyCap)}
              onChange={event => setCapDraft(event.target.value)}
            />
            <button type="submit" className="kt-btn" disabled={!idle || capDraft === null}>
              {busy === 'limit' ? 'Saving…' : 'Save limit'}
            </button>
            <p className="m-0 basis-full text-meta text-muted">
              Past it, ferrets are told web search is used up until tomorrow. This limit is its own: it is not part of
              any other spend cap.
            </p>
          </form>
        </SettingRow>
      </SettingGroup>
      {view.held.length > 0 && (
        <p role="status" className="mt-2 text-cell text-warn" data-search-held="">
          Waiting for your approval: {view.held.join('; ')}.
        </p>
      )}
      {note !== null && view.held.length === 0 && (
        <p role="status" className="mt-2 text-cell text-warn">
          {note}
        </p>
      )}
      {line !== undefined && (
        <p role="status" className="mt-2 text-cell text-muted" data-search-last-test="">
          {line}
        </p>
      )}
      {error !== null && (
        <p role="alert" className="mt-2 text-cell text-warn">
          {error}
        </p>
      )}
    </div>
  );
}
