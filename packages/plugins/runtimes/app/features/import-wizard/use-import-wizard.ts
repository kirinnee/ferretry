/**
 * The import wizard's state: the scan and each tool's version (the kit's shared read, read again after an install or a sign-in), what the person
 * left out and named, what an install or an import answered. Everything reaches the daemon through the client the shell
 * handed over; nothing here holds a value, a token or a path.
 */
import type { KnownHarnessKey } from '@ferretry/core-ferrets/contract';
import { useCallback, useEffect, useState } from 'react';
import { readMemory, rememberInAddress } from './wizard-memory.ts';
import { type ImportItemId, ToolInstallResultSchema, type ToolInstallOutcome } from '../../../contract/index.ts';
import type { RuntimesClient } from '../../lib/client.ts';
import { changeRefusalSentence } from '../fleet/shell/apply-change.ts';
import { HARNESSES, importChange, nameProblem, stepsSettledBy } from '../import-kit/model.ts';
import { type ApplyImportOptions, useApplyImport } from '../import-kit/use-apply-import.ts';
import { useScan } from '../import-kit/use-harness-scan.ts';

const INSTALL_ROUTE = 'POST /v1/runtimes/machine/tools/install' as const;
const STEP_ROUTE = 'POST /v1/onboarding/steps/:plugin/:stepId' as const;

/** How a tool ended: brought in (with the daemon's sentences) or left alone. */
export type ToolEnd =
  | { readonly kind: 'imported'; readonly sentences: readonly string[]; readonly unmarked: boolean }
  | { readonly kind: 'skipped' };

/** What the install answered: one sentence, then the manager's last lines (the daemon scrubbed them). */
const installSentence = (outcome: ToolInstallOutcome): string => {
  if (outcome.outcome === 'already-installed') return 'It is already installed.';
  const lines = outcome.output.length === 0 ? '' : `\n${outcome.output.join('\n')}`;
  if (outcome.outcome === 'installed') return `Installed with: ${outcome.command}${lines}`;
  return `${outcome.reason} To do it yourself, run: ${outcome.manualCommand}${lines}`;
};

export function useImportWizard(client: RuntimesClient, applyOptions?: ApplyImportOptions) {
  // The scan is the kit's: read once per client and shared, read again here on opening (the machine as it is now).
  const { read, models, look, rescan } = useScan(client, { run: 'settings-import', refresh: true });
  // What a reload keeps (the address): the open tool, the names, what was left out, the ticked tokens.
  const [remembered] = useState(() => readMemory(globalThis.location?.search ?? ''));
  const [tool, setTool] = useState(remembered.tool);
  const [left, setLeft] = useState<Readonly<Record<KnownHarnessKey, ReadonlySet<ImportItemId>>>>(remembered.left);
  const [tickedEnv, setTickedEnv] = useState<Readonly<Record<KnownHarnessKey, ReadonlySet<string>>>>(remembered.ticked);
  const [declined, setDeclined] = useState<Readonly<Record<KnownHarnessKey, ReadonlySet<string>>>>(remembered.declined);
  const [names, setNames] = useState<Partial<Record<KnownHarnessKey, string>>>(remembered.names);
  // A tool that ended before the reload is shown as ended; the daemon's own sentences are not kept in the address.
  const [ends, setEnds] = useState<Partial<Record<KnownHarnessKey, ToolEnd>>>(() =>
    Object.fromEntries(
      Object.entries(remembered.ends).map(([harness, how]) => [
        harness,
        how === 'imported' ? { kind: 'imported', sentences: [], unmarked: false } : { kind: 'skipped' },
      ]),
    ),
  );
  const [finished, setFinished] = useState(remembered.finished);
  const [installing, setInstalling] = useState<KnownHarnessKey | null>(null);
  const [installNote, setInstallNote] = useState<Partial<Record<KnownHarnessKey, string>>>({});
  const { changes, apply, partial } = useApplyImport(client, applyOptions);

  useEffect(() => {
    rememberInAddress({
      tool,
      names,
      left,
      ticked: tickedEnv,
      declined,
      ends: Object.fromEntries(Object.entries(ends).map(([harness, end]) => [harness, end.kind])),
      finished,
    });
  }, [tool, names, left, tickedEnv, declined, ends, finished]);

  const toggle = useCallback((harness: KnownHarnessKey, id: ImportItemId, on: boolean): void => {
    setLeft(current => {
      const next = new Set(current[harness]);
      if (on) next.delete(id);
      else next.add(id);
      return { ...current, [harness]: next };
    });
  }, []);

  const takeUpdate = useCallback((harness: KnownHarnessKey, reference: string, on: boolean): void => {
    setDeclined(current => {
      const next = new Set(current[harness]);
      if (on) next.delete(reference);
      else next.add(reference);
      return { ...current, [harness]: next };
    });
  }, []);

  const tickEnv = useCallback((harness: KnownHarnessKey, name: string, on: boolean): void => {
    setTickedEnv(current => {
      const next = new Set(current[harness]);
      if (on) next.add(name);
      else next.delete(name);
      return { ...current, [harness]: next };
    });
  }, []);

  const nameOf = useCallback(
    (harness: KnownHarnessKey): string => names[harness] ?? models?.[harness].suggestedName ?? `${harness}-default`,
    [names, models],
  );

  const install = useCallback(
    async (harness: KnownHarnessKey): Promise<void> => {
      setInstalling(harness);
      try {
        const result = ToolInstallResultSchema.parse(
          await client.call(INSTALL_ROUTE, { body: { harnesses: [harness] } }),
        );
        const outcome = result.outcomes.find(entry => entry.harness === harness);
        setInstallNote(current => ({
          ...current,
          [harness]: outcome === undefined ? 'Nothing was installed.' : installSentence(outcome),
        }));
        // The person just pressed Install: this re-read is theirs too, and may ask for the passkey.
        await rescan(false);
      } catch (error) {
        setInstallNote(current => ({ ...current, [harness]: changeRefusalSentence(error) }));
      } finally {
        setInstalling(null);
      }
    },
    [client, rescan],
  );

  /** The old first-run steps this tool settles; a failure is told, never blocks. Answers whether any could not be marked. */
  const settleSteps = useCallback(
    async (harness: KnownHarnessKey): Promise<boolean> => {
      const answers = await Promise.all(
        stepsSettledBy(harness).map(step =>
          client
            .call(STEP_ROUTE, {
              params: { plugin: step.plugin, stepId: step.stepId },
              body: { state: step.state, ...(step.linked === undefined ? {} : { linked: true }) },
            })
            .then(() => true)
            .catch(() => false),
        ),
      );
      return answers.includes(false);
    },
    [client],
  );

  const bringIn = useCallback(
    async (harness: KnownHarnessKey): Promise<void> => {
      if (models === null) return;
      const model = models[harness];
      // A retry on the same import has its runtime already: the name is not asked for again.
      if (model.duplicateOf === null && nameProblem(nameOf(harness)) !== null) return;
      const applied = await apply(
        importChange(model, left[harness], nameOf(harness), tickedEnv[harness], declined[harness]),
        model.label,
      );
      if (applied === null) return;
      // The machine now holds this runtime: read the scan again so a Go back sees it (and asks for no new name). It is the person's own press.
      void rescan(false);
      const unmarked = await settleSteps(harness);
      const told = applied.sentences;
      // What happened to each changed source, in words: the daemon names an accepted one; an unticked one is said here.
      const updated = model.updates
        .filter(
          update => !declined[harness].has(update.reference) && !told.some(line => line.includes(update.reference)),
        )
        .map(update => `Updated ${update.reference} from its changed source.`);
      const kept = model.updates
        .filter(update => declined[harness].has(update.reference))
        .map(update => `${update.reference} kept as it was.`);
      setEnds(current => ({
        ...current,
        [harness]: { kind: 'imported', sentences: [...told, ...updated, ...kept], unmarked },
      }));
    },
    [apply, left, models, nameOf, rescan, settleSteps, tickedEnv, declined],
  );

  const skip = useCallback(
    (harness: KnownHarnessKey): void => setEnds(current => ({ ...current, [harness]: { kind: 'skipped' } })),
    [],
  );
  const reopen = useCallback(
    (harness: KnownHarnessKey): void => {
      setEnds(current => {
        const { [harness]: _gone, ...rest } = current;
        return rest;
      });
      // Reopened, the page shows the machine as it is now, not the scan from before the import.
      void rescan(false);
    },
    [rescan],
  );

  return {
    read,
    models,
    harnesses: HARNESSES,
    left,
    tool,
    setTool,
    finished,
    setFinished,
    toggle,
    tickedEnv,
    tickEnv,
    declined,
    takeUpdate,
    nameOf,
    setName: (harness: KnownHarnessKey, name: string): void => setNames(current => ({ ...current, [harness]: name })),
    ends,
    installing,
    installNote,
    install,
    bringIn,
    skip,
    reopen,
    rescan,
    /** The person's own press: may ask for the passkey. */
    look,
    changes,
    /** What the last import left on the machine when it stopped part-way (landed and not landed), else `null`. */
    partial,
  };
}

export type ImportWizard = ReturnType<typeof useImportWizard>;
