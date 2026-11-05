import type { VoiceEngineView, VoiceInstallProgress, VoiceModelEntry } from '@ferretry/protocol';

/** Bytes as a person reads them: "487 MB", "1.1 GB". Decimal, as download sizes are quoted. */
function sizeLabel(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${String(Math.round(bytes / 1e6))} MB`;
  if (bytes >= 1e3) return `${String(Math.round(bytes / 1e3))} KB`;
  return `${String(bytes)} B`;
}

function installLabel(entry: VoiceModelEntry): string {
  if (entry.install.state === 'installed') return 'installed';
  return entry.install.partialBytes > 0
    ? `part downloaded (${sizeLabel(entry.install.partialBytes)})`
    : 'not installed';
}

function rowLine(entry: VoiceModelEntry): string {
  const tags = [
    entry.active ? 'active' : undefined,
    entry.recommended ? 'recommended' : undefined,
    entry.weight === 'light' ? undefined : entry.weight === 'standard' ? undefined : entry.weight,
  ].filter((tag): tag is string => tag !== undefined);
  const memory = `${sizeLabel(entry.peakMemory.bytes)} memory${entry.peakMemory.basis === 'estimate' ? ' (estimate)' : ''}`;
  return [
    `  ${entry.id}${tags.length === 0 ? '' : `  [${tags.join(', ')}]`}`,
    `      ${entry.name} — ${entry.languages.join(', ')}`,
    `      ${sizeLabel(entry.archive.bytes)} download, ${memory} — ${installLabel(entry)}`,
  ].join('\n');
}

/** One line saying how far an install is, or how it ended. */
export function progressLine(progress: VoiceInstallProgress): string {
  const what = progress.component === 'runtime' ? 'the speech runtime' : progress.modelId;
  if (progress.status === 'succeeded') return `${progress.modelId} is installed.`;
  if (progress.status === 'cancelled') return progress.message ?? `The install of ${progress.modelId} was cancelled.`;
  if (progress.status === 'failed') return progress.message ?? `The install of ${progress.modelId} failed.`;
  if (progress.phase === 'downloading' && progress.bytesTotal > 0) {
    const percent = Math.floor((progress.bytesDone / progress.bytesTotal) * 100);
    return `Downloading ${what}: ${sizeLabel(progress.bytesDone)} of ${sizeLabel(progress.bytesTotal)} (${String(percent)}%)`;
  }
  return `${progress.phase[0]?.toUpperCase() ?? ''}${progress.phase.slice(1)} ${what}…`;
}

/** `fy voice status`: the runtime, then each model, then any install and anything to know. */
export function renderStatus(view: VoiceEngineView): string {
  const lines: string[] = [];
  if (view.target === null) {
    lines.push(`Speech engine: ${view.unsupported ?? 'not available on this machine'}`);
  } else {
    const runtime = view.runtime;
    const where =
      runtime.source === 'override'
        ? `your runtime at ${runtime.path ?? '?'}`
        : `sherpa-onnx ${runtime.version ?? ''} for ${view.target}`.trim();
    const state =
      runtime.install.state === 'installed'
        ? `installed (${sizeLabel(runtime.install.bytes)})`
        : runtime.install.partialBytes > 0
          ? `part downloaded (${sizeLabel(runtime.install.partialBytes)})`
          : 'not installed — it is fetched with the first model';
    lines.push(`Runtime: ${where} — ${state}`);
  }
  lines.push(
    `Active: batch ${view.active.batch ?? 'none'}, streaming ${view.active.streaming ?? 'none'}`,
    ...(view.freeBytes === undefined ? [] : [`Free disk: ${sizeLabel(view.freeBytes)}`]),
    '',
    'Batch models (voice chat, dictation after Stop):',
    ...view.models.filter(entry => entry.role === 'batch').map(rowLine),
    '',
    'Streaming models (real-time dictation):',
    ...view.models.filter(entry => entry.role === 'streaming').map(rowLine),
  );
  if (view.install !== null) lines.push('', `Install: ${progressLine(view.install)}`);
  for (const warning of view.warnings) lines.push('', `Warning: ${warning}`);
  return lines.join('\n');
}
