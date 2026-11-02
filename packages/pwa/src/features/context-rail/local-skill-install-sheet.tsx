/**
 * Install one skill from another account or project on this machine (docs/catalogs.md, "Copying a skill
 * from this machine"): pick the place, read the whole review, confirm with a passkey.
 *
 * The review is the machine's: every file in full with hidden characters marked, and the warnings it wrote.
 * A source the machine will not copy (a password in a file, too many files) is a refusal said plainly, and
 * the sheet then has no Install button at all. Nothing is written until the person presses Install and
 * confirms the passkey the carrier asks for.
 */

import { type LocalSkillInstall, type LocalSkillPreview, revealHidden } from '@ferretry/protocol';
import { CircleCheck } from 'lucide-react';
import { useState } from 'react';
import type { DaemonConnection } from '../../lib/daemon-connection.ts';
import { Button } from '../../shell/primitives.tsx';
import {
  EXPIRY_NOTE,
  INSTALL_BUTTON,
  type TargetDraft,
  type TargetOptions,
  targetProblem,
  toTarget,
} from '../catalogs/catalog-install-model.ts';
import { CatalogSheet, FailureLine } from '../catalogs/catalog-parts.tsx';
import { MarkedText, ReviewBody, WarningList } from '../catalogs/catalog-review-view.tsx';
import type { CatalogClientFactory } from '../catalogs/catalogs-api.ts';
import { Fact, TargetPicker } from '../catalogs/install-from-file-sheet.tsx';
import { applyLocalSkillInstall, previewLocalSkillInstall } from '../catalogs/local-skill-installs-api.ts';
import {
  COPY_NOTE,
  type LocalRefusal,
  localRefusal,
  type MachineSkillRow,
  NOT_COPIED_HEADING,
  originLine,
  previewRequest,
  REPLACES_NOTE,
  CHECK_AGAIN,
  REVIEW_BEFORE_INSTALLING,
  rowFromLine,
  skippedLines,
  copiedLine,
} from './machine-skills-model.ts';

export interface LocalSkillInstallSheetProps {
  readonly row: MachineSkillRow;
  readonly connection: DaemonConnection;
  readonly createClient: CatalogClientFactory;
  /** Where Install goes unless the person picks another place. */
  readonly initial: TargetDraft;
  readonly options: TargetOptions;
  /** Closes the sheet; the copy that landed, when one did. */
  readonly onClose: (installed: LocalSkillInstall | null) => void;
}

export function LocalSkillInstallSheet({
  row,
  connection,
  createClient,
  initial,
  options,
  onClose,
}: LocalSkillInstallSheetProps) {
  const [draft, setDraft] = useState<TargetDraft>(initial);
  const [preview, setPreview] = useState<LocalSkillPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<LocalRefusal | null>(null);
  const [landed, setLanded] = useState<{
    readonly install: LocalSkillInstall;
    readonly notes: readonly string[];
  } | null>(null);
  const problem = targetProblem(draft, options);
  const name = revealHidden(row.name);

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
      const read = await previewLocalSkillInstall(
        await createClient(connection),
        target.scope,
        previewRequest(row, target),
      );
      setPreview(read);
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
      const done = await applyLocalSkillInstall(await createClient(connection), preview.target.scope, {
        previewId: preview.previewId,
      });
      setLanded({ install: done.install, notes: done.notes });
    } catch (error) {
      setFailure(localRefusal(error));
    } finally {
      setBusy(false);
    }
  };

  if (landed !== null)
    return (
      <CatalogSheet
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
      </CatalogSheet>
    );

  return (
    <CatalogSheet
      name="local-skill"
      title={`Install ${name}`}
      closeLabel="Close Install from this machine"
      onClose={() => onClose(null)}
    >
      <section className="flex min-w-0 flex-col gap-sm" aria-label="This skill" data-local-source="">
        <div className="flex min-w-0 flex-col gap-0.5">
          <p className="m-0 break-words text-cell font-semibold text-fg">{name}</p>
          <p className="m-0 break-words text-meta text-muted">{rowFromLine(row)}</p>
          <p className="m-0 break-words text-meta text-muted">{row.description}</p>
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
          {...(failure.previewAgain ? { again: true, onAgain: () => void runPreview() } : {})}
        />
      )}
      {preview === null ? null : <Review preview={preview} busy={busy} onInstall={() => void install()} />}
    </CatalogSheet>
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
        <Fact label="From">{originLine(preview.origin)}</Fact>
        <Fact label="Into">{preview.destination}</Fact>
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
      <ReviewBody entries={preview.review} warnings={preview.warnings} audience="installer" />
      <p className="m-0 text-meta text-muted">{EXPIRY_NOTE}</p>
      <Button type="button" variant="primary" disabled={busy} onClick={onInstall} data-local-install="">
        {busy ? 'Installing…' : INSTALL_BUTTON}
      </Button>
    </section>
  );
}
