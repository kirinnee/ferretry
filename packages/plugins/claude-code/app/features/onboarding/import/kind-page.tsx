/**
 * One page per KIND of thing Claude Code keeps on the computer (settings, models, CLAUDE.md, skills, MCP): a short
 * checklist from the kit, each row saying what it BECOMES. Nothing is written here and nothing is sent: a tick is memory
 * of this run (a page never writes on a selection, and the arrow keys only move). The one act is the last page's Import.
 *
 * It decides itself, and tells the shell once:
 *   - `importMode` is `everything` or `fresh`: not needed (the last page does the lot, or nothing).
 *   - the scan found nothing of this kind (or the model set's settings were left out): not needed.
 *   - `importMode` is MISSING (a reload dropped the run's memory): it does NOT skip. It shows the list so the person
 *     chooses again, and says why.
 */
import { Button } from '@ferretry/app';
import { FoundKindList, type ImportKind, kindFound, useHarnessScan } from '@ferretry/plugin-runtimes/import-kit';
import { importItemId, type ImportItemId } from '@ferretry/plugin-runtimes/contract';
import { useEffect, useRef, useState } from 'react';
import type { ClaudeCodeClient } from '../../../lib/client.ts';
import { importModeOf } from '../import-choice-page.tsx';
import type { StepPageProps } from '../props.ts';
import { HARNESS, leftOf, leftPatch, SCAN_RUN, tickedEnvOf, tickedPatch } from './segment.ts';

const LINE: Readonly<Record<ImportKind, string>> = {
  settings: 'Your Claude Code settings. Hooks are never imported.',
  'model-set': 'The models your settings name become a model set for this machine.',
  instructions: 'Your CLAUDE.md becomes a Ferretry instruction that every Claude Code runtime starts with.',
  skills: 'Skills you wrote become Ferretry skills.',
  mcp: 'MCP servers you set up become Ferretry MCP servers. Their secrets go to the Vault.',
};

const LOST =
  'This page was reloaded, so Ferretry no longer knows what you chose earlier. Pick what to bring over again.';

function KindPage({ client, step, kind }: StepPageProps<ClaudeCodeClient> & { readonly kind: ImportKind }) {
  const { read, model, look } = useHarnessScan(client, HARNESS, SCAN_RUN);
  const mode = importModeOf(step?.segment ?? {});
  const [left, setLeft] = useState<ReadonlySet<ImportItemId>>(() => leftOf(step?.segment ?? {}, kind));
  const [ticked, setTicked] = useState<ReadonlySet<string>>(() => tickedEnvOf(step?.segment ?? {}));
  const decided = useRef(false);

  useEffect(() => {
    if (decided.current || step === undefined) return;
    if (mode === 'everything' || mode === 'fresh') {
      decided.current = true;
      step.skip('not-needed');
      return;
    }
    if (read.kind === 'idle' || read.kind === 'reading') return;
    decided.current = true;
    if (read.kind !== 'ready' || model === null) return step.ready(); // asks for a press, or says it failed
    const settingsLeft = leftOf(step.segment, 'settings').has(importItemId(HARNESS, 'settings'));
    if (!kindFound(model, kind) || (kind === 'model-set' && settingsLeft)) step.skip('not-needed');
    else step.ready();
  }, [read.kind, model, mode, kind, step]);

  if (mode === 'everything' || mode === 'fresh') return null;
  if (read.kind === 'idle' || read.kind === 'reading') return null;

  const toggle = (id: ImportItemId, on: boolean): void => {
    const next = new Set(left);
    if (on) next.delete(id);
    else next.add(id);
    setLeft(next);
    step?.remember(leftPatch(kind, next));
  };
  const tick = (name: string, on: boolean): void => {
    const next = new Set(ticked);
    if (on) next.add(name);
    else next.delete(name);
    setTicked(next);
    step?.remember(tickedPatch(next));
  };

  return (
    <div className="cc-step" data-onboarding-step={`claude-code.import-${kind}`}>
      {read.kind === 'ready' && model !== null ? (
        <>
          <p className="cc-step__line">{LINE[kind]}</p>
          {mode === undefined ? (
            <p className="cc-step__line" role="note" data-import-lost="">
              {LOST}
            </p>
          ) : null}
          {kindFound(model, kind) ? (
            <FoundKindList
              model={model}
              kind={kind}
              left={left}
              onToggle={toggle}
              tickedEnv={ticked}
              onTickEnv={tick}
            />
          ) : (
            <p className="cc-step__line" data-found-empty="">
              Nothing of this kind was found on this computer.
            </p>
          )}
        </>
      ) : read.kind === 'confirm' ? (
        <div className="cc-actions">
          <p className="cc-step__line">
            Ferretry needs your OK before it reads what Claude Code keeps on this computer.
          </p>
          <Button variant="primary" onClick={() => void look()}>
            Show what is there
          </Button>
        </div>
      ) : (
        <div className="cc-actions">
          <p role="alert" className="cc-step__line">
            {read.kind === 'failed' ? read.sentence : 'That did not work. Try again.'}
          </p>
          <Button onClick={() => void look()}>Try again</Button>
        </div>
      )}
    </div>
  );
}

export const SettingsPage = (props: StepPageProps<ClaudeCodeClient>) => <KindPage {...props} kind="settings" />;
export const ModelSetPage = (props: StepPageProps<ClaudeCodeClient>) => <KindPage {...props} kind="model-set" />;
export const InstructionsPage = (props: StepPageProps<ClaudeCodeClient>) => <KindPage {...props} kind="instructions" />;
export const SkillsPage = (props: StepPageProps<ClaudeCodeClient>) => <KindPage {...props} kind="skills" />;
export const McpPage = (props: StepPageProps<ClaudeCodeClient>) => <KindPage {...props} kind="mcp" />;
