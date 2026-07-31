import type {
  SttEnhancementResult,
  SttInstallStatus,
  SttModelListResponse,
  SttModelStatus,
  SttStatus,
  SttTranscript,
  SttWorkerStatus,
} from '@ferretry/protocol';

const BYTES_PER_UNIT = 1024;
const UNITS = ['B', 'KiB', 'MiB', 'GiB'] as const;

/** A byte count a human can compare at a glance. */
export function humanBytes(bytes: number): string {
  let value = bytes;
  let unit = 0;
  while (value >= BYTES_PER_UNIT && unit < UNITS.length - 1) {
    value /= BYTES_PER_UNIT;
    unit += 1;
  }
  const rounded = unit === 0 ? String(Math.round(value)) : value.toFixed(1);
  return `${rounded} ${UNITS[unit]}`;
}

/** How far a download has got, as a whole percentage; an unknown total reads as unknown. */
export function installPercent(status: SttInstallStatus): string {
  if (status.totalBytes === 0) return '?%';
  return `${Math.floor((status.receivedBytes / status.totalBytes) * 100)}%`;
}

/** One line saying where an installation stands. */
export function renderInstallStatus(status: SttInstallStatus): string {
  switch (status.phase) {
    case 'idle':
      return 'not started';
    case 'downloading':
      return `downloading ${installPercent(status)} (${humanBytes(status.receivedBytes)} of ${humanBytes(status.totalBytes)})`;
    case 'extracting':
      return 'extracting';
    case 'verifying':
      return 'verifying checksums';
    case 'ready':
      return `installed ${status.finishedAt}`;
    case 'failed':
      return `failed (${status.code}): ${status.message}`;
  }
}

/** One model as a human reads it: what it is, what it costs, and whether it is usable. */
export function renderModel(model: SttModelStatus): string {
  const lines = [
    `  ${model.id}  [${model.state}]  ${model.label}`,
    `    runs: ${model.kind} · languages: ${model.languages.join(', ')}`,
    `    cost: download ${humanBytes(model.costs.downloadBytes)}, disk ${humanBytes(model.costs.diskBytes)}, RAM ~${humanBytes(model.costs.ramBytesApprox)}`,
    `    install: ${renderInstallStatus(model.install)}`,
  ];
  if (model.state === 'ready') lines.push(`    ${model.files.length} files verified`);
  if (model.costs.summary !== '') lines.push(`    ${model.costs.summary}`);
  return lines.join('\n');
}

/** Both models, daemon first: it is the one the CLI can actually transcribe with. */
export function renderModelList(response: SttModelListResponse): string {
  return ['dictation models', renderModel(response.models.daemon), renderModel(response.models.browser)].join('\n');
}

/** What the decoder process is doing right now. */
export function renderWorker(worker: SttWorkerStatus): string {
  switch (worker.phase) {
    case 'cold':
      return 'worker: cold — the first transcription will load the model';
    case 'loading':
      return `worker: loading${worker.modelId === undefined ? '' : ` ${worker.modelId}`}`;
    case 'ready':
      return `worker: ready with ${worker.modelId} since ${worker.loadedAt} (pid ${worker.pid})`;
    case 'busy':
      return `worker: busy with ${worker.modelId} (pid ${worker.pid})`;
    case 'error':
      return `worker: error (${worker.lastError.code}) at ${worker.lastError.at}: ${worker.lastError.message}`;
    case 'closed':
      return 'worker: closed';
  }
}

/** Whether dictation works, and if not, what is missing. */
export function renderSttStatus(status: SttStatus): string {
  return [
    status.available ? 'dictation is available' : 'dictation is NOT available',
    `  mode: ${status.mode} · language: ${status.language}`,
    `  ${renderWorker(status.worker)}`,
    `  limits: ${status.limits.sampleRate} Hz, ${status.limits.channels} channel, ${status.limits.bitsPerSample}-bit, up to ${status.limits.maxDurationSeconds}s (${humanBytes(status.limits.maxPcmBytes)})`,
    renderModel(status.models.daemon),
  ].join('\n');
}

/**
 * The transcript, with the decode cost on its own line.
 *
 * The text comes first and alone on its line so `fy stt transcribe … | pbcopy` is not polluted by
 * the metrics — kteam interleaved both into one string and nothing downstream could split them.
 */
export function renderTranscript(transcript: SttTranscript): string {
  const audio = (transcript.audioMs / 1000).toFixed(1);
  const decode = (transcript.decodeMs / 1000).toFixed(1);
  return [
    transcript.text,
    `— ${transcript.modelId}: ${audio}s of audio decoded in ${decode}s (rtf ${transcript.rtf.toFixed(2)})`,
  ].join('\n');
}

/** The cleaned-up text, with the provider that produced it. */
export function renderEnhancement(result: SttEnhancementResult): string {
  return [result.text, `— ${result.provider}/${result.model} in ${Math.round(result.latencyMs)}ms`].join('\n');
}
