/**
 * Export settings: this machine's configuration files as one zip, without secrets — for a backup, or to read and edit
 * by hand. The rules are `export-settings-model.ts`.
 *
 * The zip is built in this browser from the files the machine already serves, so the export is exactly what
 * `GET /v1/config/file` answers and nothing more; a file the machine does not show whole (it may hold a pasted key) is
 * left out and named.
 */

import { SetupNote, SetupSection } from '@ferretry/app/ui';
import { Download } from 'lucide-react';
import { useState } from 'react';
import { type ConfigStatusView, readConfigFile, readConfigStatus } from '../../../lib/config-files.ts';
import type { RuntimesClient } from '../../../lib/client.ts';
import { Button } from '../../../ui.ts';
import { changeRefusalSentence } from '../shell/apply-change.ts';
import {
  carriedFile,
  type ExportFile,
  type ExportPlan,
  exportFileName,
  exportManifest,
  exportPlan,
  secretReference,
  zipFiles,
} from './export-settings-model.ts';

/** Hands the finished zip to the person. */
type SaveFile = (fileName: string, bytes: Uint8Array) => void;

/** The browser's own download: an object URL on a link that is clicked once, then let go. */
const downloadFile: SaveFile = (fileName, bytes) => {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'application/zip' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
};

export interface ExportSettingsProps {
  readonly client: RuntimesClient;
  readonly machineName: string;
  /** Tests and the harness keep the zip instead of downloading it. */
  readonly save?: SaveFile;
  readonly now?: () => Date;
}

type Phase =
  | { readonly kind: 'idle' }
  | { readonly kind: 'reading' }
  | { readonly kind: 'saved'; readonly name: string; readonly files: readonly ExportFile[]; readonly plan: ExportPlan }
  | { readonly kind: 'failed'; readonly reason: string };

const files = (count: number): string => `${String(count)} ${count === 1 ? 'file' : 'files'}`;

/** What the zip carries and what it leaves out, read now: files in the plan, minus any the machine does not show whole. */
export const readExport = async (
  client: RuntimesClient,
  status: ConfigStatusView,
): Promise<{ readonly files: readonly ExportFile[]; readonly plan: ExportPlan }> => {
  const plan = exportPlan(status);
  const carried: ExportFile[] = [];
  const leftOut = [...plan.leftOut];
  for (const path of plan.include) {
    const answer = carriedFile(await readConfigFile(client, path));
    if ('file' in answer) carried.push(answer.file);
    else leftOut.push(answer.leftOut);
  }
  return { files: carried, plan: { include: carried.map(file => file.path), leftOut } };
};

export function ExportSettings({
  client,
  machineName,
  save = downloadFile,
  now = () => new Date(),
}: ExportSettingsProps) {
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });

  const run = (): void => {
    setPhase({ kind: 'reading' });
    void (async () => {
      try {
        const read = await readExport(client, await readConfigStatus(client));
        const when = now();
        const name = exportFileName(machineName, when);
        save(name, zipFiles(read.files, when));
        setPhase({ kind: 'saved', name, files: read.files, plan: read.plan });
      } catch (error) {
        setPhase({ kind: 'failed', reason: changeRefusalSentence(error) });
      }
    })();
  };

  return (
    <section className="flex min-w-0 flex-col gap-4" data-export-settings="" aria-labelledby="export-settings-heading">
      <div className="flex min-w-0 flex-col gap-1">
        <h3 id="export-settings-heading" className="m-0 text-row font-semibold text-fg">
          Export settings
        </h3>
        <p className="m-0 text-cell leading-base text-muted">
          A zip of <span className="font-mono">{machineName}</span>’s YAML configuration files — Warden, Learning,
          Voice, logins, profiles, components and runtimes — without secrets. A file only ever names a secret as{' '}
          <span className="font-mono">{secretReference('NAME')}</span>, never its value. Device settings are not
          included.
        </p>
      </div>
      <div>
        <Button type="button" variant="primary" data-export-run="" disabled={phase.kind === 'reading'} onClick={run}>
          <Download size={16} aria-hidden="true" />
          {phase.kind === 'reading' ? 'Reading the files…' : 'Export settings'}
        </Button>
      </div>
      {phase.kind === 'failed' ? (
        <SetupNote live tone="err" name="export-failed" title="Couldn’t export">
          <span>{phase.reason}</span>
        </SetupNote>
      ) : null}
      {phase.kind === 'saved' ? (
        <>
          <SetupNote live tone="ok" name="export-saved" title={`Saved ${phase.name}`}>
            <span>{files(phase.files.length)}. Secrets: none.</span>
          </SetupNote>
          <SetupSection title="In the zip" name="export-manifest">
            <pre className="m-0 max-w-full overflow-x-auto whitespace-pre rounded-control bg-surface p-3 font-mono text-meta">
              {exportManifest(phase.name, phase.files).split('\n').slice(0, -1).join('\n')}
            </pre>
            <p className="m-0 text-meta leading-base text-muted [overflow-wrap:anywhere]" data-export-note="">
              {exportManifest(phase.name, phase.files).split('\n').at(-1)?.trim().replace(/^# /u, '')}
            </p>
          </SetupSection>
          {phase.plan.leftOut.length === 0 ? null : (
            <SetupNote tone="warn" name="export-left-out" title={`${files(phase.plan.leftOut.length)} left out`}>
              {phase.plan.leftOut.map(entry => (
                <span key={entry.path} className="[overflow-wrap:anywhere]">
                  <span className="font-mono">{entry.path}</span>: {entry.reason}
                </span>
              ))}
            </SetupNote>
          )}
        </>
      ) : null}
    </section>
  );
}
