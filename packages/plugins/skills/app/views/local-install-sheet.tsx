/**
 * Install one skill from another account or project on this machine (docs/catalogs.md, "Copying a skill from this
 * machine"): pick the place, read the whole review, confirm with a passkey.
 *
 * The review is the machine's: every file in full with hidden characters marked, and the warnings it wrote. A source the
 * machine will not copy (a password in a file, too many files) is a refusal said plainly, and the sheet then has no Install
 * button at all. Nothing is written until the person presses Install and confirms the passkey the carrier asks for.
 */
import { Button } from '@ferretry/app/ui';
import type { PluginClient } from '@ferretry/kernel/manifest';
import { CircleCheck } from 'lucide-react';
import { useId, useState } from 'react';
import type { LocalSkillInstall, LocalSkillPreview } from '../../contract/index.ts';
import { applySkillInstall, previewSkillInstall } from '../lib/client.ts';
import {
  CHECK_AGAIN,
  COPY_NOTE,
  copiedLine,
  EXPIRY_NOTE,
  INSTALL_WITH_PASSKEY,
  type LocalRefusal,
  localRefusal,
  type MachineSkillRow,
  NOT_COPIED_HEADING,
  originLine,
  previewRequest,
  REPLACES_NOTE,
  REVIEW_BEFORE_INSTALLING,
  rowFromLine,
  skippedLines,
  type TargetDraft,
  type TargetOptions,
  targetProblem,
  toTarget,
} from '../lib/skills-model.ts';
import { MarkedText, ReviewBody, WarningList } from './review-view.tsx';
import { Fact, FailureLine, SkillSheet } from './skill-sheet.tsx';

const CHOOSE = 'Choose…';

function TargetPicker({
  draft,
  onDraft,
  options,
  busy,
}: {
  readonly draft: TargetDraft;
  readonly onDraft: (draft: TargetDraft) => void;
  readonly options: TargetOptions;
  readonly busy: boolean;
}) {
  const project = useId();
  const harness = useId();
  return (
    <div className="flex min-w-0 flex-col gap-sm" data-skill-target="">
      <div className="flex min-w-0 flex-col gap-1">
        <label htmlFor={project} className="text-meta font-semibold text-muted">
          Project
        </label>
        <select
          id={project}
          className="kt-input"
          value={draft.projectRoot ?? ''}
          onChange={event =>
            onDraft({
              ...(draft.harness === undefined ? {} : { harness: draft.harness }),
              ...(event.target.value === '' ? {} : { projectRoot: event.target.value }),
            })
          }
          disabled={busy}
          data-skill-project=""
        >
          <option value="">{CHOOSE}</option>
          {options.projects.map(item => (
            <option key={item.root} value={item.root}>
              {item.label}
            </option>
          ))}
        </select>
      </div>
      <div className="flex min-w-0 flex-col gap-1">
        <label htmlFor={harness} className="text-meta font-semibold text-muted">
          For which agent
        </label>
        <select
          id={harness}
          className="kt-input"
          value={draft.harness ?? ''}
          onChange={event => {
            const next = event.target.value;
            onDraft({
              ...(draft.projectRoot === undefined ? {} : { projectRoot: draft.projectRoot }),
              ...(next === 'claude-code' || next === 'codex' ? { harness: next } : {}),
            });
          }}
          disabled={busy}
          data-skill-harness=""
        >
          <option value="">{CHOOSE}</option>
          <option value="claude-code">Claude</option>
          <option value="codex">Codex</option>
        </select>
      </div>
    </div>
  );
}

export function LocalInstallSheet({
  client,
  row,
  options,
  onClose,
}: {
  readonly client: Pick<PluginClient, 'call'>;
  readonly row: MachineSkillRow;
  readonly options: TargetOptions;
  /** Closes the sheet; the copy that landed, when one did. */
  readonly onClose: (installed: LocalSkillInstall | null) => void;
}) {
  const [draft, setDraft] = useState<TargetDraft>({ harness: row.harness });
  const [preview, setPreview] = useState<LocalSkillPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<LocalRefusal | null>(null);
  const [landed, setLanded] = useState<{
    readonly install: LocalSkillInstall;
    readonly notes: readonly string[];
  } | null>(null);
  const problem = targetProblem(draft, options);

  const change = (next: TargetDraft): void => {
    setDraft(next);
    setPreview(null);
    setFailure(null);
  };

  const runPreview = async (): Promise<void> => {
    const target = toTarget(draft);
    if (target === null) return;
    setBusy(true);
    setFailure(null);
    try {
      setPreview(await previewSkillInstall(client, target.scope, previewRequest(row, target)));
    } catch (error) {
      setPreview(null);
      setFailure(localRefusal(error));
    } finally {
      setBusy(false);
    }
  };

  const install = async (): Promise<void> => {
    if (preview === null) return;
    setBusy(true);
    setFailure(null);
    try {
      const done = await applySkillInstall(client, preview.target.scope, { previewId: preview.previewId });
      setLanded({ install: done.install, notes: done.notes });
    } catch (error) {
      setFailure(localRefusal(error));
    } finally {
      setBusy(false);
    }
  };

  if (landed !== null)
    return (
      <SkillSheet
        name="local-skill"
        title="Installed"
        closeLabel="Close Installed"
        onClose={() => onClose(landed.install)}
      >
        <section className="flex min-w-0 flex-col gap-xs" role="status" data-local-installed="">
          <p className="m-0 flex items-start gap-2 break-words text-cell font-semibold text-ok">
            <CircleCheck size={16} aria-hidden="true" className="mt-0.5 shrink-0" />
            {copiedLine(landed.install)}
          </p>
          <p className="m-0 break-all text-cell text-fg" data-local-destination="">
            Put into {landed.install.destination}
          </p>
          {landed.notes.map(note => (
            <p key={note} className="m-0 break-words text-cell text-muted" data-local-note="">
              <MarkedText text={note} />
            </p>
          ))}
          <Button type="button" onClick={() => onClose(landed.install)} data-local-done="">
            Done
          </Button>
        </section>
      </SkillSheet>
    );

  return (
    <SkillSheet
      name="local-skill"
      title={`Install ${row.name}`}
      closeLabel="Close Install from this machine"
      onClose={() => onClose(null)}
    >
      <section className="flex min-w-0 flex-col gap-sm" aria-label="This skill" data-local-source="">
        <div className="flex min-w-0 flex-col gap-0.5">
          <p className="m-0 break-words text-cell font-semibold text-fg">
            <MarkedText text={row.name} />
          </p>
          <p className="m-0 break-words text-meta text-muted">
            <MarkedText text={rowFromLine(row)} />
          </p>
          <p className="m-0 break-words text-meta text-muted">
            <MarkedText text={row.description} />
          </p>
          <p className="m-0 text-meta text-muted">{COPY_NOTE}</p>
        </div>
        <TargetPicker draft={draft} onDraft={change} options={options} busy={busy} />
        {problem === null ? null : (
          <p className="m-0 text-meta text-muted" data-local-choice-problem="">
            {problem}
          </p>
        )}
        <Button
          type="button"
          variant={preview === null ? 'primary' : 'outline'}
          disabled={busy || problem !== null}
          onClick={() => void runPreview()}
          data-local-preview=""
        >
          {busy && preview === null
            ? 'Reading…'
            : failure !== null && preview === null
              ? CHECK_AGAIN
              : REVIEW_BEFORE_INSTALLING}
        </Button>
      </section>
      {failure === null ? null : (
        <FailureLine
          sentence={failure.sentence}
          {...(failure.previewAgain ? { onAgain: () => void runPreview() } : {})}
        />
      )}
      {preview === null ? null : <Review preview={preview} busy={busy} onInstall={() => void install()} />}
    </SkillSheet>
  );
}

function Review({
  preview,
  busy,
  onInstall,
}: {
  readonly preview: LocalSkillPreview;
  readonly busy: boolean;
  readonly onInstall: () => void;
}) {
  const skipped = skippedLines(preview);
  return (
    <section className="flex min-w-0 flex-col gap-sm" aria-label="Confirm" data-local-confirm="">
      <WarningList warnings={preview.warnings} />
      <div className="flex min-w-0 flex-col">
        <Fact label="From">
          <MarkedText text={originLine(preview.origin)} />
        </Fact>
        <Fact label="Into">
          <MarkedText text={preview.destination} />
        </Fact>
        {preview.replaces === undefined ? null : <Fact label="Replaces">{REPLACES_NOTE}</Fact>}
      </div>
      {skipped.length === 0 ? null : (
        <section className="flex min-w-0 flex-col gap-xs" aria-label={NOT_COPIED_HEADING} data-local-skipped="">
          <h4 className="m-0 text-meta font-semibold uppercase text-muted">{NOT_COPIED_HEADING}</h4>
          {skipped.map(line => (
            <p key={line} className="m-0 break-words text-cell text-muted">
              <MarkedText text={line} />
            </p>
          ))}
        </section>
      )}
      <ReviewBody entries={preview.review} warnings={preview.warnings} />
      <p className="m-0 text-meta text-muted">{EXPIRY_NOTE}</p>
      <Button type="button" variant="primary" disabled={busy} onClick={onInstall} data-local-install="">
        {busy ? 'Installing…' : INSTALL_WITH_PASSKEY}
      </Button>
    </section>
  );
}
