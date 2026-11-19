/**
 * "Install Claude Code" — the first page of the Claude segment. It decides alone whether to show: Claude found on this
 * machine → `skip('not-needed')`, nothing drawn. Not found → the exact command first, then one button that runs it
 * through Runtimes' installer (fixed argv, no shell, no sudo, behind the passkey step-up; the manager's last lines come
 * back scrubbed). The command is read from the installer's own plan, never made up here, and nothing installs until the
 * person presses the button.
 */
import { Button } from '@ferretry/app';
import { isStepUpRefusal } from '@ferretry/app/ui';
import { SetupToolSchema, type ToolInstallPlan, ToolInstallResultSchema } from '@ferretry/plugin-runtimes/contract';
import { useCallback, useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import type { ClaudeCodeClient } from '../../lib/client.ts';
import { InstalledDemo } from './demos.tsx';
import type { StepPageProps } from './kit.tsx';
import { sentenceOf } from './words.ts';

/** Only the tools list of the scan is read here; the rest is the import wizard's. */
const ScanToolsSchema = z.looseObject({ tools: z.array(SetupToolSchema) });

const UPDATE = 'GET /v1/claude-code/update' as const;
const SCAN = 'GET /v1/runtimes/setup/scan' as const;
const INSTALL = 'POST /v1/runtimes/machine/tools/install' as const;

type Read =
  | { readonly kind: 'reading' }
  /** Found: nothing to draw (the shell has been told to move on). */
  | { readonly kind: 'found' }
  /** The machine wants a passkey before it shows the plan; asked only when the person presses. */
  | { readonly kind: 'confirm' }
  | { readonly kind: 'plan'; readonly plan: ToolInstallPlan }
  | { readonly kind: 'installed'; readonly lines: readonly string[] }
  | { readonly kind: 'failed'; readonly sentence: string };

/** Only where the binary stands is read from the update view; the rest of it is Settings’. */
const LocationSchema = z.looseObject({ location: z.looseObject({ state: z.string() }) });

export function InstalledPage({ client, step }: StepPageProps<ClaudeCodeClient>) {
  const [read, setRead] = useState<Read>({ kind: 'reading' });
  const [note, setNote] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const decided = useRef(false);

  /** Tell the shell once: show (ready) or move on (skip). */
  const decide = useCallback(
    (show: boolean): void => {
      if (decided.current) return;
      decided.current = true;
      if (show) step?.ready();
      else step?.skip('not-needed');
    },
    [step],
  );

  const readPlan = useCallback(
    async (quiet: boolean): Promise<void> => {
      try {
        const scan = ScanToolsSchema.parse(await client.call(SCAN, { quiet }));
        const tool = scan.tools.find(entry => entry.harness === 'claude-code');
        if (tool === undefined || tool.installed) {
          setRead({ kind: 'found' });
          decide(false);
        } else {
          setRead({ kind: 'plan', plan: tool.install });
          decide(true);
        }
      } catch (error) {
        if (quiet && isStepUpRefusal(error)) setRead({ kind: 'confirm' });
        else setRead({ kind: 'failed', sentence: sentenceOf(error) });
        decide(true);
      }
    },
    [client, decide],
  );

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const view = LocationSchema.parse(await client.call(UPDATE, { quiet: true }));
        if (!alive) return;
        if (view.location.state === 'located') {
          setRead({ kind: 'found' });
          decide(false);
          return;
        }
      } catch {
        // An unreadable version view is not "installed": the plan below says what is on the machine.
      }
      if (alive) await readPlan(true);
    })();
    return () => {
      alive = false;
    };
  }, [client, decide, readPlan]);

  const install = async (): Promise<void> => {
    setNote(null);
    setWorking(true);
    step?.busy('Installing Claude Code…');
    try {
      const result = ToolInstallResultSchema.parse(
        await client.call(INSTALL, { body: { harnesses: ['claude-code'] } }),
      );
      const outcome = result.outcomes.find(entry => entry.harness === 'claude-code');
      if (outcome?.outcome === 'installed' || outcome?.outcome === 'already-installed') {
        setRead({ kind: 'installed', lines: outcome.outcome === 'installed' ? outcome.output : [] });
        step?.done();
      } else if (outcome?.outcome === 'failed')
        setNote(`${outcome.reason} To do it yourself, run: ${outcome.manualCommand}`);
      else setNote('Nothing was installed.');
    } catch (error) {
      setNote(sentenceOf(error));
    } finally {
      setWorking(false);
      step?.busy(null);
    }
  };

  if (read.kind === 'reading' || read.kind === 'found') return null;
  return (
    <div className="cc-step" data-onboarding-step="claude-code.installed">
      <p className="cc-step__line">
        Claude Code runs the ferrets that use your Claude account. It is not on this machine yet.
      </p>
      {read.kind === 'confirm' ? (
        <div className="cc-actions">
          <Button onClick={() => void readPlan(false)}>Show the install command</Button>
        </div>
      ) : null}
      {read.kind === 'failed' ? (
        <p role="alert" className="cc-step__line">
          {read.sentence}
        </p>
      ) : null}
      {read.kind === 'plan' && read.plan.kind === 'runnable' ? (
        <>
          <p className="cc-step__line">Ferretry will run exactly this, once you press the button:</p>
          <pre className="cc-command" data-install-command="">
            {read.plan.command}
          </pre>
          <div className="cc-actions">
            <Button variant="primary" disabled={working} onClick={() => void install()}>
              {working ? 'Installing…' : 'Install Claude Code'}
            </Button>
          </div>
        </>
      ) : null}
      {read.kind === 'plan' && read.plan.kind === 'no-package-manager' ? (
        <>
          <p className="cc-step__line">{read.plan.reason} To do it yourself, run:</p>
          <pre className="cc-command" data-install-command="">
            {read.plan.manualCommand}
          </pre>
        </>
      ) : null}
      {read.kind === 'installed' ? (
        <p role="status" className="cc-step__line" data-installed="">
          Claude Code is installed.{read.lines.length === 0 ? '' : ` ${read.lines.join(' ')}`}
        </p>
      ) : null}
      {note === null ? null : (
        <p role="alert" className="cc-step__line">
          {note}
        </p>
      )}
      <InstalledDemo />
    </div>
  );
}
