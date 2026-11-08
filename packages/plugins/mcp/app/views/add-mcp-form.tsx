/**
 * Add MCP server… — from a ferret's Actions ▾ menu (offered through Ferrets' `ferrets.actions-row` slot) and from the
 * MCP panel's "Add…" link, which opens this same form.
 *
 * THE FLOW:
 *   1. Scope: This project (the repo's `.mcp.json`, shown as a diff) or This login (every ferret on it).
 *   2. Type: a command (stdio) or a URL (HTTP); a name; the command line or the address; environment lines, where a
 *      secret is a reference and never a value.
 *   3. The daemon's preview — the diff for a project, the profile it lands in for a login — appears under the form as soon
 *      as the draft is complete, and Add sends exactly what was previewed (a project add carries the previewed etag, so a
 *      file that changed meanwhile is refused).
 *   4. Added: Reload this ferret (its CLI restarts with its conversation and picks the server up), and for a URL server
 *      on a login, Sign in through the daemon's MCP OAuth.
 *
 * Nothing here decides what is allowed: the contract's refusal rule runs as the person types, and the daemon runs it again.
 */
import { Button, cn } from '@ferretry/app/ui';
import { CheckCircle2, Plus, RotateCw } from 'lucide-react';
import { type FormEvent, type ReactNode, useEffect, useId, useMemo, useRef, useState } from 'react';
import type {
  McpOAuthFlow,
  SessionMcpAdded,
  SessionMcpDiffLine,
  SessionMcpListing,
  SessionMcpPreview,
  SessionMcpScope,
} from '../../contract/index.ts';
import { draftRequest, EMPTY_MCP_DRAFT, type McpDraft, projectFolderName, reloadOutcome } from '../lib/add-model.ts';
import {
  addFerretMcp,
  type McpClient,
  previewFerretMcp,
  readFerretMcpListing,
  restartFerrets,
  startMcpSignIn,
} from '../lib/client.ts';
import { changeRefusalSentence } from '../lib/refusal.ts';
import { mcpRedirectUri } from '../lib/sign-in-model.ts';
import { FormFailure, FormField, FormFoot } from './form-parts.tsx';
import { type McpSignInChannelFactory, McpSignInSheet } from './sign-in-sheet.tsx';

/** A half talks to ONE daemon and does not know its label. */
const MACHINE_NAME = 'This machine';

/** What the form may ask of the surface around it. */
interface AddMcpHost {
  readonly close: () => void;
}

/** `${inner}` spelled without a template literal the linter would read as a mistake. */
const reference = (inner: string): string => ['$', `{${inner}}`].join('');

/** How long typing must pause before the daemon is asked for a preview. */
const PREVIEW_DEBOUNCE_MS = 350;

type Preview =
  | { readonly kind: 'idle' }
  | { readonly kind: 'loading'; readonly key: string }
  | { readonly kind: 'ready'; readonly key: string; readonly preview: SessionMcpPreview }
  | { readonly kind: 'failed'; readonly key: string; readonly reason: string };

interface AddMcpFormProps {
  readonly client: McpClient;
  readonly host: AddMcpHost;
  /** The ferret the server is added for. */
  readonly ferretId: string;
  /** The ferret's name, for the words. */
  readonly agentName: string;
  /** The ferret's runtime (login), when known, for the words. */
  readonly login?: string;
  readonly initialScope?: SessionMcpScope;
  readonly previewDebounceMs?: number;
  readonly origin?: string;
  readonly channel?: McpSignInChannelFactory;
}

export function AddMcpForm({
  client,
  host,
  ferretId,
  agentName,
  login,
  initialScope,
  previewDebounceMs = PREVIEW_DEBOUNCE_MS,
  origin = window.location.origin,
  channel,
}: AddMcpFormProps) {
  const id = useId();
  const [draft, setDraft] = useState<McpDraft>({ ...EMPTY_MCP_DRAFT, scope: initialScope ?? 'project' });
  const [listing, setListing] = useState<SessionMcpListing | null>(null);
  const [preview, setPreview] = useState<Preview>({ kind: 'idle' });
  const [submitting, setSubmitting] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [added, setAdded] = useState<SessionMcpAdded | null>(null);
  const live = useRef('');

  // Whether a project write is possible here at all: read once.
  useEffect(() => {
    const controller = new AbortController();
    readFerretMcpListing(client, ferretId, controller.signal)
      .then(read => {
        setListing(read);
        if (read.project === null) setDraft(current => ({ ...current, scope: 'login' }));
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setListing({ project: null, projectUnavailable: 'Ferretry could not read this ferret’s project.' });
      });
    return () => controller.abort();
  }, [client, ferretId]);

  const result = draftRequest(draft);
  const key = result.kind === 'ready' ? JSON.stringify([draft.scope, result.request]) : '';
  live.current = key;

  // The preview follows the draft, debounced, and a stale answer is dropped.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` is the identity of the request, scope and draft
  useEffect(() => {
    if (result.kind !== 'ready') {
      setPreview({ kind: 'idle' });
      return;
    }
    const request = result.request;
    const scope = draft.scope;
    const timer = setTimeout(() => {
      setPreview({ kind: 'loading', key });
      previewFerretMcp(client, ferretId, scope, request).then(
        answer => {
          if (live.current === key) setPreview({ kind: 'ready', key, preview: answer });
        },
        (reason: unknown) => {
          if (live.current === key) setPreview({ kind: 'failed', key, reason: changeRefusalSentence(reason) });
        },
      );
    }, previewDebounceMs);
    return () => clearTimeout(timer);
  }, [key, client, ferretId, previewDebounceMs]);

  const update = (patch: Partial<McpDraft>): void => {
    setFailure(null);
    setDraft(current => ({ ...current, ...patch }));
  };

  const fresh = preview.kind === 'ready' && preview.key === key ? preview.preview : null;

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (result.kind !== 'ready' || fresh === null || submitting) return;
    setSubmitting(true);
    setFailure(null);
    try {
      setAdded(
        await addFerretMcp(client, ferretId, draft.scope, {
          ...result.request,
          ...(fresh.scope === 'project' ? { etag: fresh.etag } : {}),
        }),
      );
    } catch (reason) {
      setFailure(changeRefusalSentence(reason));
    } finally {
      setSubmitting(false);
    }
  };

  if (added !== null)
    return (
      <AddedStep
        added={added}
        agentName={agentName}
        client={client}
        ferretId={ferretId}
        host={host}
        oauth={draft.transport === 'url' && draft.oauth}
        origin={origin}
        {...(channel === undefined ? {} : { channel })}
      />
    );

  const projectUnavailable = listing === null ? null : listing.project === null ? listing.projectUnavailable : null;
  const reason = result.kind === 'incomplete' ? result.reason : null;
  const projectFolder = listing?.project == null ? null : projectFolderName(listing.project.path);

  return (
    <form className="fy-action-form__body" data-add-mcp="" noValidate onSubmit={event => void submit(event)}>
      <fieldset className="fy-action-form__fieldset">
        <legend className="fy-action-form__label">Scope</legend>
        <div className="fy-choice-cards">
          <ChoiceCard
            checked={draft.scope === 'project'}
            disabled={projectUnavailable !== null && projectUnavailable !== undefined}
            name={`${id}-scope`}
            onChange={() => update({ scope: 'project' })}
            title="This project"
            value="project"
          >
            {projectUnavailable ?? (
              <>
                Writes <span className="font-mono">.mcp.json</span>
                {projectFolder === null ? '' : ` in ${projectFolder}`}; shared with everyone on the repo.
              </>
            )}
          </ChoiceCard>
          <ChoiceCard
            checked={draft.scope === 'login'}
            name={`${id}-scope`}
            onChange={() => update({ scope: 'login' })}
            title="This login"
            value="login"
          >
            Every ferret on <span className="font-mono">{login ?? 'this login'}</span>.
          </ChoiceCard>
        </div>
      </fieldset>
      <fieldset className="fy-action-form__fieldset">
        <legend className="fy-action-form__label">Type</legend>
        <div className="fy-segmented">
          {(['command', 'url'] as const).map(transport => (
            <label className="fy-segmented__option" key={transport}>
              <input
                checked={draft.transport === transport}
                name={`${id}-type`}
                onChange={() => update({ transport })}
                type="radio"
                value={transport}
              />
              <span>{transport === 'command' ? 'Command (stdio)' : 'URL (HTTP)'}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <FormField id={`${id}-name`} label="Name">
        <input
          autoCapitalize="none"
          autoComplete="off"
          className="kt-input w-full"
          id={`${id}-name`}
          onChange={event => update({ name: event.target.value })}
          placeholder="sentry"
          spellCheck={false}
          value={draft.name}
        />
      </FormField>
      {draft.transport === 'url' ? (
        <>
          <FormField id={`${id}-url`} label="URL">
            <input
              autoCapitalize="none"
              className="kt-input w-full"
              id={`${id}-url`}
              inputMode="url"
              onChange={event => update({ url: event.target.value })}
              placeholder="https://mcp.sentry.dev/mcp"
              spellCheck={false}
              value={draft.url}
            />
          </FormField>
          {draft.scope === 'login' ? (
            <label className="fy-action-form__check">
              <input
                checked={draft.oauth}
                onChange={event => update({ oauth: event.target.checked })}
                type="checkbox"
              />
              <span>Sign in through Ferretry (OAuth); the token goes to the secret store.</span>
            </label>
          ) : (
            <p className="fy-action-form__note">
              If it asks for a sign-in, sign in from Info › Context › MCP once it is added: Ferretry keeps the token for
              this project.
            </p>
          )}
        </>
      ) : (
        <>
          <FormField id={`${id}-command`} label="Command">
            <input
              autoCapitalize="none"
              className="kt-input w-full font-mono"
              id={`${id}-command`}
              onChange={event => update({ command: event.target.value })}
              placeholder="npx -y @sentry/mcp-server"
              spellCheck={false}
              value={draft.command}
            />
          </FormField>
          <FormField
            help={
              draft.scope === 'login' ? (
                <>
                  One NAME=value per line. A secret is <span className="font-mono">{reference('secret:NAME')}</span>,
                  never the value.
                </>
              ) : (
                <>
                  One NAME=value per line. A secret is <span className="font-mono">{reference('NAME')}</span>, filled in
                  from the ferret’s environment.
                </>
              )
            }
            id={`${id}-env`}
            label="Environment"
          >
            <textarea
              className="kt-input w-full font-mono"
              id={`${id}-env`}
              onChange={event => update({ env: event.target.value })}
              placeholder={`SENTRY_TOKEN=${reference(draft.scope === 'login' ? 'secret:SENTRY_TOKEN' : 'SENTRY_TOKEN')}`}
              rows={2}
              spellCheck={false}
              value={draft.env}
            />
          </FormField>
        </>
      )}
      {reason === null ? null : (
        <p className="fy-action-form__error" data-add-mcp-refusal="" role="alert">
          {reason}
        </p>
      )}
      <PreviewView preview={preview} currentKey={key} />
      <FormFailure message={failure} />
      <FormFoot
        disabled={fresh === null}
        icon={<Plus aria-hidden="true" size={14} />}
        onCancel={host.close}
        submitLabel="Add server"
        submitting={submitting}
      />
    </form>
  );
}

function ChoiceCard({
  name,
  value,
  title,
  checked,
  disabled = false,
  onChange,
  children,
}: {
  readonly name: string;
  readonly value: string;
  readonly title: string;
  readonly checked: boolean;
  readonly disabled?: boolean;
  readonly onChange: () => void;
  readonly children: ReactNode;
}) {
  return (
    <label className={cn('fy-choice-card', disabled && 'fy-choice-card--disabled')} data-choice={value}>
      <input checked={checked} disabled={disabled} name={name} onChange={onChange} type="radio" value={value} />
      <span className="fy-choice-card__text">
        <strong>{title}</strong>
        <small>{children}</small>
      </span>
    </label>
  );
}

/** A diff repeats lines, so a line's position is the only identity it has. */
const numbered = (diff: readonly SessionMcpDiffLine[]) =>
  diff.map((line, position) => ({ id: `line-${position}`, line }));

function PreviewView({ preview, currentKey }: { readonly preview: Preview; readonly currentKey: string }) {
  if (preview.kind === 'idle' || currentKey === '') return null;
  if (preview.kind === 'loading' || preview.key !== currentKey)
    return (
      <p className="fy-action-form__note" role="status">
        Reading what this would change…
      </p>
    );
  if (preview.kind === 'failed')
    return (
      <p className="fy-action-form__failure" data-add-mcp-preview-failed="" role="alert">
        {preview.reason}
      </p>
    );
  const shown = preview.preview;
  if (shown.scope === 'login')
    return (
      <p className="fy-action-form__note" data-add-mcp-preview="login">
        {shown.replaces ? 'Replaces' : 'Adds'} the server in profile <span className="font-mono">{shown.profile}</span>,
        used by <span className="font-mono">{shown.runtime}</span>
        {shown.ferrets > 1 ? ` — ${shown.ferrets} ferrets run on it` : ''}.
      </p>
    );
  return (
    <div className="fy-action-form__field" data-add-mcp-preview="project">
      <span className="fy-action-form__label">Preview of the repo change</span>
      <div className="fy-diff">
        <div className="fy-diff__file">
          <span className="font-mono">{shown.path}</span>
          <span>{shown.etag === null ? 'new file' : shown.replaces ? 'replaces 1 server' : '+1 server'}</span>
        </div>
        <pre className="fy-diff__body">
          {numbered(shown.diff).map(({ id, line }) => (
            <span className="fy-diff__line" data-kind={line.kind} key={id}>
              {line.kind === 'add' ? '+ ' : line.kind === 'remove' ? '- ' : '  '}
              {line.text}
            </span>
          ))}
        </pre>
      </div>
    </div>
  );
}

function AddedStep({
  added,
  agentName,
  client,
  ferretId,
  oauth,
  origin,
  channel,
  host,
}: {
  readonly added: SessionMcpAdded;
  readonly agentName: string;
  readonly client: McpClient;
  readonly ferretId: string;
  readonly oauth: boolean;
  readonly origin: string;
  readonly channel?: McpSignInChannelFactory;
  readonly host: AddMcpHost;
}) {
  const [busy, setBusy] = useState<'reload' | 'sign-in' | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [flow, setFlow] = useState<McpOAuthFlow | null>(null);
  const [signedIn, setSignedIn] = useState(false);
  const [queued, setQueued] = useState<string | null>(null);
  const redirectUri = useMemo(() => mcpRedirectUri(origin), [origin]);

  const reload = async (): Promise<void> => {
    setBusy('reload');
    setFailure(null);
    try {
      const outcome = reloadOutcome(await restartFerrets(client, [ferretId]), ferretId, agentName);
      if (outcome.kind === 'restarted') host.close();
      else if (outcome.kind === 'queued') setQueued(outcome.sentence);
      else setFailure(outcome.sentence);
    } catch (reason) {
      setFailure(changeRefusalSentence(reason));
    } finally {
      setBusy(null);
    }
  };

  const startSignIn = async (): Promise<void> => {
    setBusy('sign-in');
    setFailure(null);
    try {
      setFlow(await startMcpSignIn(client, added.name, { redirectUri }));
    } catch (reason) {
      setFailure(changeRefusalSentence(reason));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="fy-action-form__body" data-add-mcp-added={added.scope}>
      <p className="fy-action-form__ok" role="status">
        <CheckCircle2 aria-hidden="true" size={16} />
        <span>
          Added <strong className="font-mono">{added.name}</strong> to{' '}
          {added.scope === 'project' ? (
            <span className="font-mono">{added.path}</span>
          ) : (
            <>
              login <span className="font-mono">{added.runtime}</span>
            </>
          )}
          .
        </span>
      </p>
      <p className="fy-action-form__note">
        {agentName} picks it up after a reload: its CLI restarts with its conversation.{' '}
        {added.scope === 'project'
          ? 'Other ferrets on this repo get it on their next start. Claude Code asks once to trust a new project server; answer it in the Console.'
          : 'Other ferrets on this login get it on their next start.'}
      </p>
      {oauth ? (
        <div className="fy-action-form__row">
          <span className="fy-action-form__note">
            {signedIn ? 'Signed in; the token is in the secret store.' : 'This server signs in through Ferretry.'}
          </span>
          {signedIn ? null : (
            <Button
              data-add-mcp-sign-in=""
              disabled={busy !== null}
              onClick={() => void startSignIn()}
              size="sm"
              type="button"
            >
              {busy === 'sign-in' ? 'Opening sign-in…' : 'Sign in'}
            </Button>
          )}
        </div>
      ) : null}
      {queued === null ? null : (
        <p className="fy-action-form__note" data-add-mcp-queued="" role="status">
          {queued}
        </p>
      )}
      <FormFailure message={failure} />
      <div className="fy-action-form__foot">
        <Button disabled={busy !== null} onClick={host.close} size="sm" type="button" variant="ghost">
          {queued === null ? 'Later' : 'Close'}
        </Button>
        {queued === null ? (
          <Button
            data-add-mcp-reload=""
            disabled={busy !== null}
            onClick={() => void reload()}
            size="sm"
            type="button"
            variant="primary"
          >
            <RotateCw aria-hidden="true" size={14} />
            {busy === 'reload' ? 'Reloading…' : 'Reload this ferret'}
          </Button>
        ) : null}
      </div>
      {flow === null ? null : (
        <McpSignInSheet
          client={client}
          component={flow.component}
          flow={flow}
          machineName={MACHINE_NAME}
          onClose={() => setFlow(null)}
          onSignedIn={() => setSignedIn(true)}
          redirectUri={redirectUri}
          {...(channel === undefined ? {} : { channel })}
        />
      )}
    </div>
  );
}
