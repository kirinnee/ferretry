/**
 * Add MCP server… — in the Actions popover (desktop) or sheet (phone), and from Info › Folder › MCP's
 * "Add…" link, which opens this same form.
 *
 * THE FLOW (spec R3):
 *   1. Scope: This project (the repo's `.mcp.json`, shown as a diff) or This login (every ferret on it).
 *   2. Type: a command (stdio) or a URL (HTTP); a name; the command line or the address; environment
 *      lines, where a secret is a reference and never a value.
 *   3. The daemon's preview — the diff for a project, the profile it lands in for a login — appears
 *      under the form as soon as the draft is complete, and Add sends exactly what was previewed (a
 *      project add carries the previewed etag, so a file that changed meanwhile is refused).
 *   4. Added: Reload this ferret (its CLI restarts with its conversation and picks the server up), and
 *      for a URL server on a login, Sign in through the daemon's MCP OAuth.
 *
 * Nothing here decides what is allowed: the protocol's refusal rule runs as the person types, and the
 * daemon runs it again.
 */

import type {
  McpOAuthFlow,
  SessionMcpAdded,
  SessionMcpAddRequest,
  SessionMcpDiffLine,
  SessionMcpListing,
  SessionMcpPreview,
  SessionMcpPreviewRequest,
  SessionMcpScope,
} from '@ferretry/protocol';
import { CheckCircle2, Plus, RotateCw } from 'lucide-react';
import { type FormEvent, type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { cn } from '../../lib/class-names.ts';
import { Button } from '../../shell/primitives.tsx';
import type { ContextMcpSignInHost } from '../context-rail/context-rail-mcp.tsx';
import { mcpRedirectUri } from '../fleet/components/mcp-sign-in-model.ts';
import { McpSignInSheet } from '../fleet/components/mcp-sign-in-sheet.tsx';
import { startMcpSignIn } from '../fleet/mcp-auth-api.ts';
import { changeRefusalSentence } from '../fleet/shell/apply-change.ts';
import { draftRequest, EMPTY_MCP_DRAFT, type McpDraft } from './add-mcp-model.ts';
import { FormFailure, FormField, FormFoot, failureMessage } from './form-parts.tsx';
import type { SessionActionFormHost } from './registry.ts';

export interface AddMcpPorts {
  readonly listing: (signal: AbortSignal) => Promise<SessionMcpListing>;
  readonly preview: (scope: SessionMcpScope, request: SessionMcpPreviewRequest) => Promise<SessionMcpPreview>;
  readonly add: (scope: SessionMcpScope, request: SessionMcpAddRequest) => Promise<SessionMcpAdded>;
  /** Restarts this ferret's CLI with its conversation. */
  readonly reload: () => Promise<void>;
  /** Restarts the OTHER ferrets on this login, for "Reload all on this login". */
  readonly reloadOthers?: () => Promise<void>;
  /** Signs a URL server in through the daemon's MCP OAuth. Absent: no Sign in is offered. */
  readonly signIn?: ContextMcpSignInHost;
}

/** `${inner}` spelled without a template literal the linter would read as a mistake. */
const reference = (inner: string): string => ['$', `{${inner}}`].join('');

/** How long typing must pause before the daemon is asked for a preview. */
export const PREVIEW_DEBOUNCE_MS = 350;

type Preview =
  | { readonly kind: 'idle' }
  | { readonly kind: 'loading'; readonly key: string }
  | { readonly kind: 'ready'; readonly key: string; readonly preview: SessionMcpPreview }
  | { readonly kind: 'failed'; readonly key: string; readonly reason: string };

export function AddMcpForm({
  host,
  ports,
  agentName,
  login,
  project,
  initialScope,
  previewDebounceMs = PREVIEW_DEBOUNCE_MS,
}: {
  readonly host: SessionActionFormHost;
  readonly ports: AddMcpPorts;
  /** The ferret's name, for the words. */
  readonly agentName: string;
  /** The login (runtime) this ferret runs on. */
  readonly login: string;
  /** The project's name, for the words, or null. */
  readonly project: string | null;
  readonly initialScope?: SessionMcpScope;
  readonly previewDebounceMs?: number;
}) {
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
    ports
      .listing(controller.signal)
      .then(read => {
        setListing(read);
        if (read.project === null) setDraft(current => ({ ...current, scope: 'login' }));
      })
      .catch(() => setListing({ project: null, projectUnavailable: 'Ferretry could not read this ferret’s project.' }));
    return () => controller.abort();
  }, [ports]);

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
      ports.preview(scope, request).then(
        answer => {
          if (live.current === key) setPreview({ kind: 'ready', key, preview: answer });
        },
        (reason: unknown) => {
          if (live.current === key) setPreview({ kind: 'failed', key, reason: failureMessage(reason) });
        },
      );
    }, previewDebounceMs);
    return () => clearTimeout(timer);
  }, [key, ports, previewDebounceMs]);

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
        await ports.add(draft.scope, {
          ...result.request,
          ...(fresh.scope === 'project' ? { etag: fresh.etag } : {}),
        }),
      );
    } catch (reason) {
      setFailure(failureMessage(reason));
    } finally {
      setSubmitting(false);
    }
  };

  if (added !== null)
    return (
      <AddedStep
        added={added}
        agentName={agentName}
        host={host}
        oauth={draft.transport === 'url' && draft.oauth}
        others={fresh?.scope === 'login' ? Math.max(0, fresh.ferrets - 1) : 0}
        ports={ports}
      />
    );

  const projectUnavailable = listing === null ? null : listing.project === null ? listing.projectUnavailable : null;
  const reason = result.kind === 'incomplete' ? result.reason : null;

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
                {project === null ? '' : ` in ${project}`}; shared with everyone on the repo.
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
            Every ferret on <span className="font-mono">{login}</span>.
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
  others,
  oauth,
  ports,
  host,
}: {
  readonly added: SessionMcpAdded;
  readonly agentName: string;
  readonly others: number;
  readonly oauth: boolean;
  readonly ports: AddMcpPorts;
  readonly host: SessionActionFormHost;
}) {
  const [reloadAll, setReloadAll] = useState(false);
  const [busy, setBusy] = useState<'reload' | 'sign-in' | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [flow, setFlow] = useState<McpOAuthFlow | null>(null);
  const [signedIn, setSignedIn] = useState(false);
  const signIn = ports.signIn;
  const origin = signIn?.origin ?? (typeof window === 'undefined' ? '' : window.location.origin);

  const reload = async (): Promise<void> => {
    setBusy('reload');
    setFailure(null);
    try {
      await ports.reload();
      if (reloadAll) await ports.reloadOthers?.();
      host.close();
    } catch (reason) {
      setFailure(failureMessage(reason));
    } finally {
      setBusy(null);
    }
  };

  const startSignIn = async (host: ContextMcpSignInHost): Promise<void> => {
    setBusy('sign-in');
    setFailure(null);
    try {
      const client = await host.createClient(host.connection);
      setFlow(await startMcpSignIn(client, added.name, { redirectUri: mcpRedirectUri(origin) }));
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
      {oauth && signIn !== undefined ? (
        <div className="fy-action-form__row">
          <span className="fy-action-form__note">
            {signedIn ? 'Signed in; the token is in the secret store.' : 'This server signs in through Ferretry.'}
          </span>
          {signedIn ? null : (
            <Button
              data-add-mcp-sign-in=""
              disabled={busy !== null}
              onClick={() => void startSignIn(signIn)}
              size="sm"
              type="button"
            >
              {busy === 'sign-in' ? 'Opening sign-in…' : 'Sign in'}
            </Button>
          )}
        </div>
      ) : null}
      {added.scope === 'login' && others > 0 && ports.reloadOthers !== undefined ? (
        <label className="fy-action-form__check">
          <input checked={reloadAll} onChange={event => setReloadAll(event.target.checked)} type="checkbox" />
          <span>
            Also reload the other {others} ferret{others === 1 ? '' : 's'} on this login now
          </span>
        </label>
      ) : null}
      <FormFailure message={failure} />
      <div className="fy-action-form__foot">
        <Button disabled={busy !== null} onClick={host.close} size="sm" type="button" variant="ghost">
          Later
        </Button>
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
      </div>
      {flow === null || signIn === undefined ? null : (
        <McpSignInSheet
          component={flow.component}
          connection={signIn.connection}
          createClient={signIn.createClient}
          flow={flow}
          machineName={signIn.machineName}
          onClose={() => setFlow(null)}
          onSignedIn={() => setSignedIn(true)}
          redirectUri={mcpRedirectUri(origin)}
          {...(signIn.channel === undefined ? {} : { channel: signIn.channel })}
        />
      )}
    </div>
  );
}
