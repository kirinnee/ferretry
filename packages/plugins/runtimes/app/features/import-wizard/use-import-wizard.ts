/**
 * The import wizard's state: the scan and each tool's version (read again after an install or a sign-in), what the person
 * left out and named, what an install or an import answered. Everything reaches the daemon through the client the shell
 * handed over; nothing here holds a value, a token or a path.
 */
import type { HarnessKey } from '@ferretry/core-ferrets/contract';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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

const SCAN_ROUTE = 'GET /v1/runtimes/setup/scan' as const;
const INSTALL_ROUTE = 'POST /v1/runtimes/machine/tools/install' as const;
const STEP_ROUTE = 'POST /v1/onboarding/steps/:plugin/:stepId' as const;
const UPDATE_ROUTE: Readonly<Record<HarnessKey, string>> = {
  'claude-code': 'GET /v1/claude-code/update',
  codex: 'GET /v1/codex/update',
};

type Read =
  | { readonly kind: 'reading' }
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

const installSentence = (outcome: ToolInstallOutcome): string => {
  if (outcome.outcome === 'already-installed') return 'It is already installed.';
  if (outcome.outcome === 'installed') return `Installed with: ${outcome.command}`;
  return `${outcome.reason} To do it yourself, run: ${outcome.manualCommand}`;
};

export function useImportWizard(client: RuntimesClient) {
  const [read, setRead] = useState<Read>({ kind: 'reading' });
  const [left, setLeft] = useState<Readonly<Record<HarnessKey, ReadonlySet<ImportItemId>>>>({
    'claude-code': new Set(),
    codex: new Set(),
  });
  const [names, setNames] = useState<Partial<Record<HarnessKey, string>>>({});
  const [ends, setEnds] = useState<Partial<Record<HarnessKey, ToolEnd>>>({});
  const [installing, setInstalling] = useState<HarnessKey | null>(null);
  const [installNote, setInstallNote] = useState<Partial<Record<HarnessKey, string>>>({});
  const changes = useAccountChanges({ client });
  const generation = useRef(0);

  const scan = useCallback(async (): Promise<void> => {
    generation.current += 1;
    const mine = generation.current;
    try {
      const [answer, claude, codex] = await Promise.all([
        client.call(SCAN_ROUTE),
        client.call(UPDATE_ROUTE['claude-code']).catch(() => null),
        client.call(UPDATE_ROUTE.codex).catch(() => null),
      ]);
      if (mine !== generation.current) return;
      setRead({
        kind: 'ready',
        scan: SetupScanSchema.parse(answer),
        versions: { 'claude-code': versionOf(claude), codex: versionOf(codex) },
      });
    } catch (error) {
      if (mine === generation.current) setRead({ kind: 'failed', sentence: changeRefusalSentence(error) });
    }
  }, [client]);

  useEffect(() => {
    void scan();
  }, [scan]);

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
        await scan();
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
      const result = await changes.apply(importChange(model, left[harness], nameOf(harness)));
      if (result.kind !== 'applied') return;
      const summary = result.outcome.outcome === 'executed' ? result.outcome.summary : 'Imported.';
      const unmarked = await settleSteps(harness);
      setEnds(current => ({
        ...current,
        [harness]: { kind: 'imported', sentences: resultSentences(summary), unmarked },
      }));
    },
    [changes, left, models, nameOf, settleSteps],
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
    toggle,
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
    changes,
  };
}

export type ImportWizard = ReturnType<typeof useImportWizard>;
