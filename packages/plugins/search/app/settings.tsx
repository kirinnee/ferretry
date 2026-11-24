/**
 * Settings › Web search: the providers this machine searches with, in the order they are tried, each with its own key;
 * add, remove and reorder them, Test one, and set the one daily limit.
 *
 * WRITE-ONLY, LIKE EVERY SECRET. A pasted key goes to the Vault's `POST /v1/secrets` under the name the table gives and
 * the field clears; the daemon answers "named" and a count, never a value. Naming the keys in `search.yaml` is the
 * owner's act (`PUT /v1/web-search/setup`, the whole ordered list): in effect when this device may confirm it,
 * otherwise held, and the screen says so. Reordering is plain buttons, so it works by keyboard and by touch.
 */
import { SettingGroup, SettingRow } from '@ferretry/app';
import { SecretInput, SelectBox, useSecretField } from '@ferretry/app/ui';
import type { PluginClient } from '@ferretry/kernel/manifest';
import {
  ArrowDown,
  ArrowUp,
  CircleAlert,
  CircleCheck,
  ExternalLink,
  FlaskConical,
  KeyRound,
  Plus,
  Trash2,
} from 'lucide-react';
import { type FormEvent, useCallback, useEffect, useState } from 'react';
import {
  SEARCH_PROVIDER_IDS,
  SEARCH_PROVIDERS,
  type SearchProviderId,
  type SearchProviderView,
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

const KEY_LINK_CLASS = '[overflow-wrap:anywhere] text-accent underline';
const INPUT_CLASS =
  'kt-input min-h-[44px] min-w-0 flex-[1_1_14rem] rounded-control border border-border bg-surface-2 px-2 text-fg';

/** Where to make a key, as text AND a link (a link alone can be blocked). */
function KeyLink({ provider }: { readonly provider: SearchProviderId }) {
  const info = SEARCH_PROVIDERS[provider];
  return (
    <>
      Get a key:{' '}
      <a href={info.keyUrl} target="_blank" rel="noreferrer noopener" className={KEY_LINK_CLASS}>
        {info.keyUrl.replace(/^https:\/\//u, '')}
        <ExternalLink size={12} aria-hidden="true" className="ml-1 inline align-baseline" />
      </a>
      . Saved as <code>{info.secretName}</code>.
    </>
  );
}

interface ProviderRowProps {
  readonly entry: SearchProviderView;
  readonly index: number;
  readonly count: number;
  readonly idle: boolean;
  readonly busy: string | null;
  readonly onSaveKey: (provider: SearchProviderId, value: string) => void;
  readonly onMove: (index: number, by: -1 | 1) => void;
  readonly onTest: (provider: SearchProviderId) => void;
  readonly onRemove: (provider: SearchProviderId) => void;
}

/** One listed provider: its place in the order, its own key to replace, Test and Remove. */
function ProviderRow({ entry, index, count, idle, busy, onSaveKey, onMove, onTest, onRemove }: ProviderRowProps) {
  const info = SEARCH_PROVIDERS[entry.provider];
  const key = useSecretField(typed => typed.trim().length);
  const [replacing, setReplacing] = useState(false);
  const typed = key.length >= MIN_KEY_LENGTH;
  const line = testLine(entry.lastTest);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!typed || !idle) return;
    onSaveKey(entry.provider, key.read().trim());
    key.clear();
    setReplacing(false);
  };
  return (
    <SettingRow
      name={`${String(index + 1)}. ${info.label}`}
      hint={
        <span className="inline-flex flex-wrap items-center gap-x-2">
          <span className="font-medium text-fg" data-search-named="">
            {index === 0 ? 'Tried first' : `Tried ${ordinal(index + 1)}`}
          </span>
          <span>{info.priceNote}</span>
        </span>
      }
      wide
      dataAttributes={{ 'data-search-provider': entry.provider }}
    >
      <div className="flex min-w-0 flex-col gap-2 px-3 pb-3">
        {replacing && (
          <form
            className="flex min-w-0 flex-wrap items-center gap-2"
            onSubmit={submit}
            aria-label={`Replace the ${info.label} key`}
          >
            <SecretInput
              id={`search-key-${entry.provider}`}
              field={key}
              aria-label={`${info.label} key (${info.secretName})`}
              className={INPUT_CLASS}
              placeholder="paste the new key"
            />
            <button type="submit" className="kt-btn" data-variant="primary" disabled={!idle || !typed}>
              <KeyRound size={14} aria-hidden="true" /> {busy === `key:${entry.provider}` ? 'Saving…' : 'Save key'}
            </button>
            <p className="m-0 basis-full text-meta text-muted">
              <KeyLink provider={entry.provider} />
            </p>
          </form>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="kt-btn min-w-[44px]"
            title="Move up"
            aria-label={`Move ${info.label} up`}
            disabled={!idle || index === 0}
            onClick={() => onMove(index, -1)}
          >
            <ArrowUp size={14} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="kt-btn min-w-[44px]"
            title="Move down"
            aria-label={`Move ${info.label} down`}
            disabled={!idle || index === count - 1}
            onClick={() => onMove(index, 1)}
          >
            <ArrowDown size={14} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="kt-btn"
            aria-label={`Test ${info.label}`}
            disabled={!idle}
            onClick={() => onTest(entry.provider)}
          >
            <FlaskConical size={14} aria-hidden="true" /> {busy === `test:${entry.provider}` ? 'Testing…' : 'Test'}
          </button>
          <button
            type="button"
            className="kt-btn"
            aria-label={`Remove ${info.label}`}
            disabled={!idle}
            onClick={() => onRemove(entry.provider)}
          >
            <Trash2 size={14} aria-hidden="true" /> Remove
          </button>
          <button
            type="button"
            className="kt-btn"
            aria-label={`Replace the ${info.label} key`}
            aria-expanded={replacing}
            disabled={!idle}
            onClick={() => setReplacing(value => !value)}
          >
            <KeyRound size={14} aria-hidden="true" /> {replacing ? 'Cancel' : 'Replace key'}
          </button>
        </div>
        {entry.lastTest !== undefined && line !== undefined && (
          <p
            className={`m-0 inline-flex items-start gap-1 text-cell ${entry.lastTest.ok ? 'text-ok' : 'text-err'}`}
            role="status"
            data-search-last-test=""
          >
            {entry.lastTest.ok ? (
              <CircleCheck size={14} aria-hidden="true" className="mt-0.5 shrink-0" />
            ) : (
              <CircleAlert size={14} aria-hidden="true" className="mt-0.5 shrink-0" />
            )}
            <span>{line}</span>
          </p>
        )}
      </div>
    </SettingRow>
  );
}

const ordinal = (n: number): string =>
  ['', '', 'second', 'third', 'fourth', 'fifth', 'sixth'][n] ?? `number ${String(n)}`;

export function SearchSettings({ client }: { readonly client: Client }) {
  const [view, setView] = useState<SearchView | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [picked, setPicked] = useState<SearchProviderId | null>(null);
  const [capDraft, setCapDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const addKey = useSecretField(typed => typed.trim().length);

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

  const listed = view.providers.map(entry => entry.provider);
  const unlisted = SEARCH_PROVIDER_IDS.filter(id => !listed.includes(id));
  const idle = busy === null;
  const addTyped = addKey.length >= MIN_KEY_LENGTH;
  const info = picked === null ? null : SEARCH_PROVIDERS[picked];

  const act = async (kind: string, work: () => Promise<string | null>) => {
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

  /** The whole ordered list, as one setup: the order is what the daemon tries. */
  const putList = async (ids: readonly SearchProviderId[]): Promise<string | null> =>
    heldLine(await client.call<SearchSetupResult>('PUT /v1/web-search/setup', { body: { providers: ids } })) ?? null;

  const add = (event: FormEvent) => {
    event.preventDefault();
    if (info === null || picked === null || !idle) return;
    void act('adding', async () => {
      if (addTyped)
        await client.call('POST /v1/secrets', { body: { name: info.secretName, value: addKey.read().trim() } });
      addKey.clear();
      const result = await putList([...listed, picked]);
      setPicked(null);
      return result;
    });
  };

  const saveKey = (provider: SearchProviderId, value: string) =>
    void act(`key:${provider}`, async () => {
      await client.call('POST /v1/secrets', { body: { name: SEARCH_PROVIDERS[provider].secretName, value } });
      return null;
    });

  const move = (index: number, by: -1 | 1) => {
    const next = [...listed];
    const [moved] = next.splice(index, 1);
    if (moved === undefined) return;
    next.splice(index + by, 0, moved);
    void act('moving', () => putList(next));
  };

  const remove = (provider: SearchProviderId) =>
    void act('removing', () => putList(listed.filter(id => id !== provider)));

  const test = (provider: SearchProviderId) =>
    void act(`test:${provider}`, async () => {
      await client.call<SearchTestResult>('POST /v1/web-search/test', { body: { provider } });
      return null;
    });

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
                <code>web_search</code> tool answered by the providers you set up, with your own keys.
              </p>
              <p className="m-0">
                There is no default provider: it is off until you add one. A search goes to the first provider on the
                list and, if that one fails (the network, a refused key, a limit), to the next. A valid answer with no
                results is an answer and does not move on. A ferret’s search text goes only to the providers you list.
                Your keys are stored on this machine and never shown again.
              </p>
            </div>
          }
        />
        <SettingRow
          name="Providers"
          explanation={
            <p className="m-0">
              Test runs one real search on that provider alone (it counts toward today’s limit). Remove takes a provider
              off the list; its key stays in the Vault. Replace key stores a new key under the same name.
            </p>
          }
          hint={
            listed.length === 0
              ? 'None set up: web search is off'
              : `${String(listed.length)} set up. Tried in this order; the first that answers wins`
          }
        />
        {view.providers.map((entry, index) => (
          <ProviderRow
            key={entry.provider}
            entry={entry}
            index={index}
            count={view.providers.length}
            idle={idle}
            busy={busy}
            onSaveKey={saveKey}
            onMove={move}
            onTest={test}
            onRemove={remove}
          />
        ))}
        {unlisted.length > 0 && (
          <SettingRow
            name="Add a provider"
            hint={info === null ? 'It joins the end of the list' : info.priceNote}
            wide
            control={() => (
              <SelectBox
                className="min-h-[44px]"
                id="search-provider"
                label="Search provider"
                value={picked ?? ''}
                placeholder="Choose a provider…"
                onChange={chosen => setPicked(chosen as SearchProviderId)}
                options={unlisted.map(id => ({ value: id, label: SEARCH_PROVIDERS[id].label }))}
              />
            )}
          >
            {info !== null && picked !== null && (
              <form
                className="flex min-w-0 flex-wrap items-center gap-2 px-3 pb-3"
                onSubmit={add}
                aria-label={`Add ${info.label}`}
              >
                <SecretInput
                  id="search-key"
                  field={addKey}
                  aria-label={`${info.label} key (${info.secretName})`}
                  className={INPUT_CLASS}
                  placeholder="paste it here — it is never shown again"
                />
                <button type="submit" className="kt-btn" data-variant="primary" disabled={!idle}>
                  <Plus size={14} aria-hidden="true" />{' '}
                  {busy === 'adding' ? 'Adding…' : addTyped ? 'Add with this key' : 'Add provider'}
                </button>
                <p className="m-0 basis-full text-meta text-muted">
                  <KeyLink provider={picked} /> Without a pasted key it uses the one already stored under that name.
                </p>
              </form>
            )}
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
              One limit over every provider: a search that moves on to the next provider counts as a search at each.
              Past it, ferrets are told web search is used up until tomorrow. It is not part of any other spend cap.
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
      {error !== null && (
        <p role="alert" className="mt-2 text-cell text-warn">
          {error}
        </p>
      )}
    </div>
  );
}
