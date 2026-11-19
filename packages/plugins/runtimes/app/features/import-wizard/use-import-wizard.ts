/**
 * The import wizard's state: the scan and each tool's version (read again after an install or a sign-in), what the person
 * left out and named, what an install or an import answered. Everything reaches the daemon through the client the shell
 * handed over; nothing here holds a value, a token or a path.
 */
import { isStepUpRefusal } from '@ferretry/app/ui';
import type { HarnessKey } from '@ferretry/core-ferrets/contract';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { readMemory, rememberInAddress } from './wizard-memory.ts';
import {
  type ImportItemId,
  type SetupScan,
  SetupScanSchema,
  ToolInstallResultSchema,
  type ToolInstallOutcome,
} from '../../../contract/index.ts';
import type { RuntimesClient } from '../../lib/client.ts';
import { useAccountChanges } from '../fleet/shell/apply-change-panel.tsx';
import { changeRefusalSentence } from '../fleet/shell/apply-change.ts';
import {
  resultSentences,
  HARNESSES,
  importChange,
  nameProblem,
  stepsSettledBy,
  type ToolModel,
  toolModel,
  versionOf,
} from './model.ts';

/** The daemon's own words for an import that has nothing it does not already hold. */
const NOTHING_NEW = /nothing new to import/iu;

const SCAN_ROUTE = 'GET /v1/runtimes/setup/scan' as const;
const INSTALL_ROUTE = 'POST /v1/runtimes/machine/tools/install' as const;
const STEP_ROUTE = 'POST /v1/onboarding/steps/:plugin/:stepId' as const;
const UPDATE_ROUTE: Readonly<Record<HarnessKey, string>> = {
  'claude-code': 'GET /v1/claude-code/update',
  codex: 'GET /v1/codex/update',
};

type Read =
  | { readonly kind: 'reading' }
  /** The machine wants a passkey before it shows the setup; nothing asks until the person presses the button. */
  | { readonly kind: 'confirm' }
  | { readonly kind: 'failed'; readonly sentence: string }
  | {
      readonly kind: 'ready';
      readonly scan: SetupScan;
      readonly versions: Readonly<Record<HarnessKey, string | null>>;
    };

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

export function useImportWizard(client: RuntimesClient) {
  const [read, setRead] = useState<Read>({ kind: 'reading' });
  // What a reload keeps (the address): the open tool, the names, what was left out, the ticked tokens.
  const [remembered] = useState(() => readMemory(globalThis.location?.search ?? ''));
  const [tool, setTool] = useState(remembered.tool);
  const [left, setLeft] = useState<Readonly<Record<HarnessKey, ReadonlySet<ImportItemId>>>>(remembered.left);
  const [tickedEnv, setTickedEnv] = useState<Readonly<Record<HarnessKey, ReadonlySet<string>>>>(remembered.ticked);
  const [declined, setDeclined] = useState<Readonly<Record<HarnessKey, ReadonlySet<string>>>>(remembered.declined);
  const [names, setNames] = useState<Partial<Record<HarnessKey, string>>>(remembered.names);
  // A tool that ended before the reload is shown as ended; the daemon's own sentences are not kept in the address.
  const [ends, setEnds] = useState<Partial<Record<HarnessKey, ToolEnd>>>(() =>
    Object.fromEntries(
      Object.entries(remembered.ends).map(([harness, how]) => [
        harness,
        how === 'imported' ? { kind: 'imported', sentences: [], unmarked: false } : { kind: 'skipped' },
      ]),
    ),
  );
  const [finished, setFinished] = useState(remembered.finished);
  const [installing, setInstalling] = useState<HarnessKey | null>(null);
  const [installNote, setInstallNote] = useState<Partial<Record<HarnessKey, string>>>({});
  const changes = useAccountChanges({ client });
  const generation = useRef(0);

  /**
   * Reads the scan and each tool's version. `quiet` is a read nobody asked for (the step opening, a re-read after an
   * install): it never raises a passkey prompt, and a machine that wants one is answered with the button below. A press
   * (`quiet` false) is the person's own act and may ask.
   */
  const scan = useCallback(
    async (quiet = true): Promise<void> => {
      generation.current += 1;
      const mine = generation.current;
      try {
        const [answer, claude, codex] = await Promise.all([
          // A press (`quiet: false`) is the person's own act and opens the shell's passkey prompt; a read nobody asked for never does.
          client.call(SCAN_ROUTE, { quiet }),
          client.call(UPDATE_ROUTE['claude-code'], { quiet: true }).catch(() => null),
          client.call(UPDATE_ROUTE.codex, { quiet: true }).catch(() => null),
        ]);
        if (mine !== generation.current) return;
        const parsed = SetupScanSchema.safeParse(answer);
        if (!parsed.success && quiet) {
          setRead({ kind: 'confirm' });
          return;
        }
        setRead({
          kind: 'ready',
          scan: SetupScanSchema.parse(answer),
          versions: { 'claude-code': versionOf(claude), codex: versionOf(codex) },
        });
      } catch (error) {
        if (mine !== generation.current) return;
        // The real shape of "this machine wants a passkey for that": a 403 `grant_step_up_required`. Read quietly, it waits for a press.
        if (quiet && isStepUpRefusal(error)) setRead({ kind: 'confirm' });
        else setRead({ kind: 'failed', sentence: changeRefusalSentence(error) });
      }
    },
    [client],
  );

  useEffect(() => {
    void scan();
  }, [scan]);

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

  const models = useMemo<Readonly<Record<HarnessKey, ToolModel>> | null>(
    () =>
      read.kind === 'ready'
        ? {
            'claude-code': toolModel('claude-code', read.scan, read.versions['claude-code']),
            codex: toolModel('codex', read.scan, read.versions.codex),
          }
        : null,
    [read],
  );

  const toggle = useCallback((harness: HarnessKey, id: ImportItemId, on: boolean): void => {
    setLeft(current => {
      const next = new Set(current[harness]);
      if (on) next.delete(id);
      else next.add(id);
      return { ...current, [harness]: next };
    });
  }, []);

  const takeUpdate = useCallback((harness: HarnessKey, reference: string, on: boolean): void => {
    setDeclined(current => {
      const next = new Set(current[harness]);
      if (on) next.delete(reference);
      else next.add(reference);
      return { ...current, [harness]: next };
    });
  }, []);

  const tickEnv = useCallback((harness: HarnessKey, name: string, on: boolean): void => {
    setTickedEnv(current => {
      const next = new Set(current[harness]);
      if (on) next.add(name);
      else next.delete(name);
      return { ...current, [harness]: next };
    });
  }, []);

  const nameOf = useCallback(
    (harness: HarnessKey): string => names[harness] ?? models?.[harness].suggestedName ?? `${harness}-default`,
    [names, models],
  );

  const install = useCallback(
    async (harness: HarnessKey): Promise<void> => {
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
        await scan(false);
      } catch (error) {
        setInstallNote(current => ({ ...current, [harness]: changeRefusalSentence(error) }));
      } finally {
        setInstalling(null);
      }
    },
    [client, scan],
  );

  /** The old first-run steps this tool settles; a failure is told, never blocks. Answers whether any could not be marked. */
  const settleSteps = useCallback(
    async (harness: HarnessKey): Promise<boolean> => {
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
    async (harness: HarnessKey): Promise<void> => {
      if (models === null) return;
      const model = models[harness];
      if (nameProblem(nameOf(harness)) !== null) return;
      const result = await changes.apply(
        importChange(model, left[harness], nameOf(harness), tickedEnv[harness], declined[harness]),
      );
      // The daemon says "Nothing new to import." when everything is already in (the only change was an update the person left
      // unticked). That is not a failure to show: the tool is set up as it was, and each unticked update says so.
      const alreadyIn = result.kind === 'refused' && NOTHING_NEW.test(result.sentence);
      if (result.kind !== 'applied' && !alreadyIn) return;
      if (alreadyIn) changes.clear();
      const summary =
        result.kind === 'applied' && result.outcome.outcome === 'executed'
          ? result.outcome.summary
          : alreadyIn
            ? `Nothing new to bring in from ${model.label}: it is already set up.`
            : 'Imported.';
      const unmarked = await settleSteps(harness);
      const told = resultSentences(summary);
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
    [changes, left, models, nameOf, settleSteps, tickedEnv, declined],
  );

  const skip = useCallback(
    (harness: HarnessKey): void => setEnds(current => ({ ...current, [harness]: { kind: 'skipped' } })),
    [],
  );
  const reopen = useCallback((harness: HarnessKey): void => {
    setEnds(current => {
      const { [harness]: _gone, ...rest } = current;
      return rest;
    });
  }, []);

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
    setName: (harness: HarnessKey, name: string): void => setNames(current => ({ ...current, [harness]: name })),
    ends,
    installing,
    installNote,
    install,
    bringIn,
    skip,
    reopen,
    rescan: scan,
    /** The person's own press: may ask for the passkey. */
    look: () => scan(false),
    changes,
  };
}

export type ImportWizard = ReturnType<typeof useImportWizard>;
