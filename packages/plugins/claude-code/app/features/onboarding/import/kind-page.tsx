/**
 * One page per KIND of thing Claude Code keeps on the computer (settings, models, CLAUDE.md, skills, MCP): a short
 * checklist from the kit, each row saying what it BECOMES. Nothing is written here and nothing is sent: a tick is memory
 * of this run (a page never writes on a selection, and the arrow keys only move). The one act is the last page's Import.
 *
 * It skips ONLY for a fact that cannot change while the run is open: the scan found nothing of this kind. Everything the
 * person can still revise with Back (the mode, whether Settings is left out) never skips it, because a skip is
 * irreversible in the flow (the page is gone for the rest of the run and the machine records it skipped). So:
 *   - `importMode` is `everything` or `fresh`: it draws nothing and calls `notNeeded()` (contract rule 7): Import everything
 *     is ONE page (the run page), not five notice pages. Nothing is recorded; Back -> Choose what to import clears the
 *     mark (the mode changed), so the pages are there again.
 *   - the model set while its settings are left out: it stays, saying the models come from the settings.
 *   - `importMode` is MISSING (a reload dropped the run's memory): it shows its checklist exactly as in Customize, every
 *     item ticked as Import everything would bring it. No chooser, no extra button: only the footer Next answers it.
 */
import { Button, StepDemo } from '@ferretry/app';
import { FoundKindList, type ImportKind, kindFound, useHarnessScan } from '@ferretry/plugin-runtimes/import-kit';
import { importItemId, type ImportItemId } from '@ferretry/plugin-runtimes/contract';
import { useEffect, useRef, useState } from 'react';
import type { ClaudeCodeClient } from '../../../lib/client.ts';
import { KindDemo } from '../demos.tsx';
import { importModeOf } from '../import-choice-page.tsx';
import type { StepPageProps } from '../props.ts';
import { HARNESS, leftOf, leftPatch, SCAN_RUN, tickedEnvOf, tickedPatch } from './segment.ts';

const LINE: Readonly<Record<ImportKind, string>> = {
  settings: 'Your settings.',
  'model-set': 'The models your settings name become a model set for this machine.',
  instructions: 'Your CLAUDE.md becomes a Ferretry instruction that every Claude Code runtime starts with.',
  skills: 'Skills you wrote become Ferretry skills.',
  mcp: 'MCP servers you set up become Ferretry MCP servers. Their secrets go to the Vault.',
};

const NEEDS_SETTINGS =
  'Not imported: you left your settings out, and the models come from them. Go back to the Settings page to bring them in.';

function KindPage({ client, step, kind }: StepPageProps<ClaudeCodeClient> & { readonly kind: ImportKind }) {
  const { read, model, look } = useHarnessScan(client, HARNESS, SCAN_RUN);
  const mode = importModeOf(step?.segment ?? {});
  const [left, setLeft] = useState<ReadonlySet<ImportItemId>>(() => leftOf(step?.segment ?? {}, kind));
  const [ticked, setTicked] = useState<ReadonlySet<string>>(() => tickedEnvOf(step?.segment ?? {}));
  const decided = useRef(false);

  const settingsLeft = leftOf(step?.segment ?? {}, 'settings').has(importItemId(HARNESS, 'settings'));
  const settled = mode === 'everything' || mode === 'fresh' ? 'not-needed' : 'scan';

  useEffect(() => {
    if (decided.current || step === undefined) return;
    if (settled === 'not-needed') {
      // Nothing to ask and nothing to read: passed over for THIS run only (never recorded), until the mode changes.
      decided.current = true;
      step.notNeeded();
      return;
    }
    if (read.kind === 'idle' || read.kind === 'reading') return;
    decided.current = true;
    if (read.kind !== 'ready' || model === null) return step.ready(); // asks for a press, or says it failed
    // Only what the scan cannot change back: nothing of this kind exists on this computer.
    if (!kindFound(model, kind)) step.skip('not-needed');
    else step.ready();
  }, [read.kind, model, settled, kind, step]);

  if (settled === 'not-needed') return null;
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
          {kind === 'model-set' && settingsLeft ? (
            <p className="cc-step__line" data-needs-settings="">
              {NEEDS_SETTINGS}
            </p>
          ) : null}
          {kind === 'model-set' && settingsLeft ? null : kindFound(model, kind) ? (
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
          <StepDemo>
            <KindDemo kind={kind} />
          </StepDemo>
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
