/**
 * Copy settings from another machine (docs/design/account-model.md §4.7): **Source** → **Review** → **Done**.
 *
 * The browser reads the source's export and settings through the Runtimes client it holds on that machine, asks THIS
 * machine to review them, and sends ONE reviewed change (`clone.import`) that the daemon describes again when it is
 * staged. What a copy would RUN (an MCP server's command, a hook, a launch flag) is listed in full and each can be left
 * out; a sign-in never travels (it becomes an empty slot to sign in to), and an API key is named, never carried.
 */

import { daemonOfClient, type DaemonReach, useEveryDaemon } from '@ferretry/app';
import { RadioChoices, SetupNote, SetupSection } from '@ferretry/app/ui';
import { useCallback, useMemo, useState } from 'react';
import {
  type AccountChangeView,
  type CloneBundle,
  CloneBundleSchema,
  type CloneReview,
  CloneReviewSchema,
  type MachineView,
} from '../../../../contract/index.ts';
import type { RuntimesClient } from '../../../lib/client.ts';
import { readConfigFile } from '../../../lib/config-files.ts';
import { Button } from '../../../ui.ts';
import { ChangeApplyPanel, type AccountChanges } from '../shell/apply-change-panel.tsx';
import { changeRefusalSentence, readMachine } from '../shell/apply-change.ts';
import {
  type CopyMode,
  copyChange,
  outcomeCounts,
  reviewRequest,
  runnableRefs,
  SETTINGS_FILES,
  settingsTexts,
  type SourceSettingsRead,
} from './copy-model.ts';

export interface CopySettingsProps {
  readonly client: RuntimesClient;
  readonly machineName: string;
  /** This machine already has runtimes: the copy goes next to them, or in their place. */
  readonly hasSetup: boolean;
  readonly changes: AccountChanges;
  /** The copy landed: the step is set and setup continues. */
  readonly onDone?: () => void;
  readonly doneLabel?: string;
}

type Phase =
  | { readonly kind: 'source' }
  | { readonly kind: 'reading'; readonly source: string }
  | {
      readonly kind: 'review';
      readonly source: { readonly daemonId: string; readonly name: string };
      readonly bundle: CloneBundle;
      readonly review: CloneReview;
      readonly request: ReturnType<typeof reviewRequest>;
      readonly leftOut: readonly string[];
    }
  | { readonly kind: 'confirm'; readonly staged: AccountChangeView; readonly source: string }
  | { readonly kind: 'done'; readonly source: string; readonly summary: string };

const plural = (count: number, word: string): string => `${String(count)} ${word}${count === 1 ? '' : 's'}`;

/** The source's settings files and controls: what a copy merges key by key. */
const readSource = async (reach: DaemonReach) => {
  const client = reach.client as RuntimesClient;
  const [bundle, machine, ...files] = await Promise.all([
    client.call('GET /v1/runtimes/export').then(answer => CloneBundleSchema.parse(answer)),
    readMachine(client),
    ...SETTINGS_FILES.map(async (path): Promise<SourceSettingsRead> => {
      const file = await readConfigFile(client, path).catch(() => null);
      return file === null
        ? { path, exists: false, text: '', issues: [] }
        : { path, exists: file.exists, text: file.text, issues: file.issues ?? [] };
    }),
  ]);
  return { bundle, machine: machine as MachineView, files };
};

export function CopySettings({ client, machineName, hasSetup, changes, onDone, doneLabel }: CopySettingsProps) {
  const own = daemonOfClient(client);
  const everyone = useEveryDaemon();
  const sources = useMemo(() => everyone.filter(row => row.daemon !== own), [everyone, own]);
  const [phase, setPhase] = useState<Phase>({ kind: 'source' });
  const [picked, setPicked] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [mode, setMode] = useState<CopyMode>('alongside');
  const [skipped, setSkipped] = useState<ReadonlySet<string>>(new Set());

  const read = useCallback(
    async (reach: DaemonReach): Promise<void> => {
      setProblem(null);
      setPhase({ kind: 'reading', source: reach.machine });
      try {
        const { bundle, machine, files } = await readSource(reach);
        const { settings, leftOut } = settingsTexts(files, machine);
        const source = { daemonId: reach.daemon, name: reach.machine };
        const request = reviewRequest({ bundle, source, targetName: machineName, settings });
        const review = CloneReviewSchema.parse(await client.call('POST /v1/runtimes/clone/review', { body: request }));
        setSkipped(new Set());
        setPhase({ kind: 'review', source, bundle, review, request, leftOut });
      } catch (error) {
        setProblem(changeRefusalSentence(error));
        setPhase({ kind: 'source' });
      }
    },
    [client, machineName],
  );

  if (phase.kind === 'done')
    return (
      <div className="flex min-w-0 flex-col gap-3" data-copy-done="">
        <SetupNote live tone="ok" name="copy-done" title={`Copied from ${phase.source}`}>
          <span>{phase.summary}</span>
        </SetupNote>
        {onDone === undefined ? null : (
          <div>
            <Button type="button" variant="primary" data-copy-continue="" onClick={onDone}>
              {doneLabel ?? 'Continue'}
            </Button>
          </div>
        )}
      </div>
    );

  if (phase.kind === 'confirm')
    return (
      <div className="flex min-w-0 flex-col gap-3" data-copy-confirm="">
        <SetupNote tone="pend" name="copy-confirm" title={phase.staged.summary}>
          {phase.staged.consequences.map(line => (
            <span key={line}>{line}</span>
          ))}
        </SetupNote>
        <ChangeApplyPanel
          machineName={machineName}
          authority={changes.authority}
          busy={changes.busy}
          refusal={changes.refusal}
          submitLabel={`Copy from ${phase.source}`}
          onSubmit={() => {
            void changes.applyStaged(phase.staged).then(result => {
              if (result.kind !== 'applied') return;
              setPhase({ kind: 'done', source: phase.source, summary: phase.staged.summary });
            });
          }}
        >
          <Button type="button" data-copy-back="" onClick={() => setPhase({ kind: 'source' })}>
            Back
          </Button>
        </ChangeApplyPanel>
      </div>
    );

  if (phase.kind === 'review') {
    const { review, request, source, leftOut } = phase;
    const counts = outcomeCounts(review);
    const runnable = new Set(runnableRefs(review));
    const stage = (): void => {
      const made = copyChange({ review, request, choices: { skip: [...skipped], mode } });
      if (made.kind === 'undecided') {
        changes.refuse(
          `Something differs on both machines and needs a choice this screen can’t make yet: ${made.refs.join(', ')}. Copy from the command line (fy machine clone) to decide each one.`,
        );
        return;
      }
      void changes.stage(made.change).then(result => {
        if (result.kind === 'staged') setPhase({ kind: 'confirm', staged: result.staged, source: source.name });
      });
    };
    return (
      <div className="flex min-w-0 flex-col gap-4" data-copy-review="">
        <SetupSection title={`What ${source.name} brings`} name="copy-summary">
          <p className="m-0 text-cell leading-base text-muted" data-copy-counts="">
            {plural(review.items.length, 'item')}
            {Object.entries(counts).length === 0
              ? ''
              : ` (${Object.entries(counts)
                  .map(([outcome, count]) => `${String(count)} ${outcome}`)
                  .join(', ')})`}
            , {plural(review.same.count, 'thing')} already the same here.
          </p>
        </SetupSection>
        {review.logins.length === 0 ? null : (
          <SetupNote tone="warn" name="copy-logins" title="Sign-ins stay behind">
            <span>
              A sign-in never leaves {source.name}: {plural(review.logins.length, 'login')} arrive as an empty slot to
              sign in to here.
            </span>
          </SetupNote>
        )}
        {review.keys.length === 0 ? null : (
          <SetupNote tone="pend" name="copy-keys" title="API keys are named, never carried">
            <span className="font-mono [overflow-wrap:anywhere]">{review.keys.map(key => key.name).join(', ')}</span>
          </SetupNote>
        )}
        {leftOut.length === 0 ? null : (
          <SetupNote tone="warn" name="copy-left-out" title="Not copied">
            <span className="[overflow-wrap:anywhere]">
              {leftOut.join(', ')}: {source.name} does not show the whole file, so it is left out rather than sent with
              a gap.
            </span>
          </SetupNote>
        )}
        {review.mode === 'first' && runnable.size > 0 ? (
          <SetupSection title="What would run here" name="copy-runnable">
            <p className="m-0 text-meta leading-base text-muted">
              These start programs on {machineName}. Untick any you don’t want; the profiles that name it leave it out
              too.
            </p>
            <ul className="m-0 flex list-none flex-col gap-2 p-0">
              {review.items
                .filter(item => item.runnable !== undefined)
                .map(item => (
                  <li key={item.ref} className="kt-panel flex min-w-0 flex-col gap-1 p-3" data-copy-runnable={item.ref}>
                    <label className="flex min-w-0 items-center gap-2 text-cell font-semibold text-fg">
                      <input
                        type="checkbox"
                        checked={!skipped.has(item.ref)}
                        onChange={event =>
                          setSkipped(current => {
                            const next = new Set(current);
                            if (event.target.checked) next.delete(item.ref);
                            else next.add(item.ref);
                            return next;
                          })
                        }
                      />
                      <span className="[overflow-wrap:anywhere]">{item.ref}</span>
                    </label>
                    {item.runnable?.entries.map(entry => (
                      <p
                        key={`${entry.label}:${entry.text}`}
                        className="m-0 text-meta text-muted [overflow-wrap:anywhere]"
                      >
                        {entry.label}: <span className="font-mono">{entry.document ? '(document)' : entry.text}</span>
                      </p>
                    ))}
                  </li>
                ))}
            </ul>
          </SetupSection>
        ) : null}
        {review.mode === 'first' && hasSetup ? (
          <SetupSection title="Existing setup" name="copy-existing">
            <RadioChoices
              legend="Existing setup"
              legendHidden
              name="copy-mode"
              value={mode}
              onChoose={setMode}
              options={[
                {
                  id: 'alongside',
                  title: 'Add alongside',
                  detail: `Keep what ${machineName} has and add the copy next to it.`,
                },
                { id: 'replace', title: 'Replace', detail: `Replace what ${machineName} has with the copy.` },
              ]}
            />
          </SetupSection>
        ) : null}
        {changes.refusal === null ? null : (
          <p role="alert" className="m-0 text-cell leading-base text-warn" data-copy-refusal="">
            {changes.refusal}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="primary" data-copy-stage="" disabled={changes.busy} onClick={stage}>
            {changes.busy ? 'Checking…' : 'Preview the copy'}
          </Button>
          <Button type="button" data-copy-back="" onClick={() => setPhase({ kind: 'source' })}>
            Back
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-4" data-copy-source="">
      <p className="m-0 text-cell leading-base text-muted">
        {machineName} receives a copy of the instructions, skills, settings and hooks of the machine you pick, so only
        pick one whose setup you’re happy for {machineName} to see. A sign-in never leaves it, and no API key is
        carried.
      </p>
      {sources.length === 0 ? (
        <p className="m-0 text-cell text-muted" data-copy-no-sources="">
          Pair another machine first: a copy is made from a machine this browser is paired with.
        </p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-2 p-0">
          {sources.map(row => (
            <li key={row.daemon} className="kt-panel flex min-w-0 items-center justify-between gap-2 p-3">
              <label className="flex min-w-0 flex-1 items-center gap-2 text-cell font-semibold text-fg">
                <input
                  type="radio"
                  name="copy-source"
                  disabled={!row.online || row.locked}
                  checked={picked === row.daemon}
                  onChange={() => setPicked(row.daemon)}
                />
                <span className="[overflow-wrap:anywhere]">{row.machine}</span>
                {row.online ? null : <span className="text-meta font-normal text-muted">asleep or offline</span>}
                {row.locked ? <span className="text-meta font-normal text-muted">locked — unlock it first</span> : null}
              </label>
            </li>
          ))}
        </ul>
      )}
      {problem === null ? null : (
        <SetupNote live tone="err" name="copy-failed" title="Couldn’t read that machine">
          <span>{problem}</span>
        </SetupNote>
      )}
      <div>
        <Button
          type="button"
          variant="primary"
          data-copy-read=""
          disabled={picked === null || phase.kind === 'reading'}
          onClick={() => {
            const row = sources.find(candidate => candidate.daemon === picked);
            if (row !== undefined) void read(row);
          }}
        >
          {phase.kind === 'reading' ? `Reading ${phase.source}…` : 'Review the copy'}
        </Button>
      </div>
    </div>
  );
}
