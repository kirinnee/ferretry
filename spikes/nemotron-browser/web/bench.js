// SPIKE: the bench's main thread — model registry, pacing, metrics and the page.
// Every engine runs in its own worker; this file only feeds audio and measures.

// `?hf=<origin>` points the model downloads at a mirror (the desktop harness serves local copies).
const HF = new URLSearchParams(location.search).get('hf') || 'https://huggingface.co';
const sherpaFiles = (repo, rev, sizes) =>
  Object.entries(sizes).map(([name, bytes]) => ({ name, bytes, url: `${HF}/${repo}/resolve/${rev}/${name}` }));

const MODELS = [
  {
    id: 'nemotron-en-160',
    label: 'Nemotron Speech Streaming EN 0.6B · 160 ms · int8',
    engine: 'sherpa',
    licence: 'NVIDIA Open Model License',
    files: sherpaFiles('csukuangfj2/sherpa-onnx-nemotron-speech-streaming-en-0.6b-160ms-int8-2026-04-25', '237e551abd7a411ef92d3595454d9f6ab5fe7d6c', {
      'encoder.int8.onnx': 652916849, 'decoder.int8.onnx': 7257753, 'joiner.int8.onnx': 1735862, 'tokens.txt': 8952,
    }),
  },
  {
    id: 'nemotron-en-560',
    label: 'Nemotron Speech Streaming EN 0.6B · 560 ms · int8',
    engine: 'sherpa',
    licence: 'NVIDIA Open Model License',
    files: sherpaFiles('csukuangfj2/sherpa-onnx-nemotron-speech-streaming-en-0.6b-560ms-int8-2026-04-25', '52056fdc070914a48dcd68b31b44d6a6f5b85902', {
      'encoder.int8.onnx': 652916849, 'decoder.int8.onnx': 7257753, 'joiner.int8.onnx': 1735862, 'tokens.txt': 8952,
    }),
  },
  {
    id: 'nemotron35-160',
    label: 'Nemotron 3.5 ASR Streaming multilingual 0.6B · 160 ms · int8',
    engine: 'sherpa',
    multilingual: true,
    licence: 'OpenMDW 1.1',
    files: sherpaFiles('csukuangfj2/sherpa-onnx-nemotron-3.5-asr-streaming-0.6b-160ms-int8-2026-06-11', 'b3a4dbde84fba1a13cb4270e6730b525ac6a2db6', {
      'encoder.int8.onnx': 657601518, 'decoder.int8.onnx': 14978075, 'joiner.int8.onnx': 9504438, 'tokens.txt': 131440,
    }),
  },
  {
    id: 'nemotron35-560',
    label: 'Nemotron 3.5 ASR Streaming multilingual 0.6B · 560 ms · int8',
    engine: 'sherpa',
    multilingual: true,
    licence: 'OpenMDW 1.1',
    files: sherpaFiles('csukuangfj2/sherpa-onnx-nemotron-3.5-asr-streaming-0.6b-560ms-int8-2026-06-11', 'ab43d895f5985b1bbab8b6eac8607fcdc05343f3', {
      'encoder.int8.onnx': 657601403, 'decoder.int8.onnx': 14978075, 'joiner.int8.onnx': 9504438, 'tokens.txt': 131440,
    }),
  },
  {
    id: 'fastconformer-480',
    label: 'NeMo streaming FastConformer transducer EN · 480 ms · int8 (small baseline)',
    engine: 'sherpa',
    licence: 'NGC Terms of Use (not an open licence)',
    files: sherpaFiles('csukuangfj/sherpa-onnx-nemo-streaming-fast-conformer-transducer-en-480ms-int8', 'df8ed95e44a70924450381e610770f9d656d1e15', {
      'encoder.int8.onnx': 131507603, 'decoder.int8.onnx': 3955864, 'joiner.int8.onnx': 1408182, 'tokens.txt': 11896,
    }),
  },
  {
    id: 'parakeet',
    label: 'Parakeet TDT 0.6B v3 · int8 (what Ferretry ships today)',
    engine: 'parakeet',
    licence: 'CC-BY-4.0',
    files: [
      { name: 'encoder', bytes: 652183999, url: `${HF}/ysdede/parakeet-tdt-0.6b-v3-onnx/resolve/f88260fa0777fe0868dda6df85d1a98f012a4a7a/encoder-model.int8.onnx` },
      { name: 'decoder', bytes: 18202004, url: `${HF}/ysdede/parakeet-tdt-0.6b-v3-onnx/resolve/f88260fa0777fe0868dda6df85d1a98f012a4a7a/decoder_joint-model.int8.onnx` },
      { name: 'vocabulary', bytes: 102132, url: `${HF}/ysdede/parakeet-tdt-0.6b-v3-onnx/resolve/f88260fa0777fe0868dda6df85d1a98f012a4a7a/vocab.txt` },
      { name: 'runtime', bytes: 12297086, url: new URL('ort-wasm-simd-threaded.wasm', location.href).href },
    ],
  },
];

const CLIPS = [
  { file: 'clips/c1.wav', text: 'He hoped there would be stew for dinner, turnips and carrots and bruised potatoes and fat mutton pieces to be ladled out in thick peppered flour fattened sauce.' },
  { file: 'clips/c2.wav', text: 'Stuff it into you, his belly counselled him.' },
  { file: 'clips/c3.wav', text: 'After early nightfall the yellow lamps would light up here and there the squalid quarter of the brothels.' },
  { file: 'clips/c4.wav', text: 'God as a direct consequence of the sin which man thus punished had given her a lovely child whose place was on that same dishonoured bosom to connect her parent for ever with the race and descent of mortals and to be finally a blessed soul in heaven.' },
];

const SR = 16000;
const query = new URLSearchParams(location.search);
const slowdown = Math.max(1, Number(query.get('slowdown') || '1') || 1);
const $ = id => document.getElementById(id);
const results = { device: deviceInfo(), loads: [], runs: [] };
globalThis.__bench = { results, load: id => loadModel(id), clips: mode => runClips(mode) };

// ---------- workers ----------
let worker = null;
let current = null;
let nextId = 1;
const pending = new Map();

function startWorker(model) {
  if (worker) worker.terminate();
  const suffix = slowdown > 1 ? `?slowdown=${slowdown}` : '';
  worker =
    model.engine === 'sherpa'
      ? new Worker(`sherpa-worker.js${suffix}`)
      : new Worker(`parakeet-worker.js${suffix}`, { type: 'module' });
  worker.onmessage = ({ data }) => {
    if (data.type === 'progress') return onProgress(data);
    if (data.type === 'log') return console.log('[worker]', data.text);
    const waiter = pending.get(data.id);
    if (!waiter) return;
    pending.delete(data.id);
    data.ok ? waiter.resolve(data.value) : waiter.reject(new Error(data.error));
  };
  worker.onerror = event => setStatus(`Worker crashed: ${event.message || 'out of memory?'}`, 'bad');
}

function call(type, body = {}, transfer = []) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    worker.postMessage({ id, type, ...body }, transfer);
  });
}

// ---------- audio ----------
async function readWav(url) {
  const view = new DataView(await (await fetch(url)).arrayBuffer());
  let offset = 12;
  while (offset < view.byteLength) {
    const id = String.fromCharCode(...new Uint8Array(view.buffer, offset, 4));
    const size = view.getUint32(offset + 4, true);
    if (id === 'data') {
      const out = new Float32Array(size / 2);
      for (let i = 0; i < out.length; i++) out[i] = view.getInt16(offset + 8 + i * 2, true) / 32768;
      return out;
    }
    offset += 8 + size + (size % 2);
  }
  throw new Error(`no data chunk in ${url}`);
}

/** Seconds into the clip where the voice starts: first 20 ms frame above a fixed loudness. */
function speechOnset(samples) {
  const frame = SR / 50;
  for (let i = 0; i + frame <= samples.length; i += frame) {
    let sum = 0;
    for (let j = i; j < i + frame; j++) sum += samples[j] * samples[j];
    if (Math.sqrt(sum / frame) > 0.02) return i / SR;
  }
  return 0;
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, Math.max(0, ms)));

// ---------- metrics ----------
const words = text => text.toLowerCase().replace(/[^\p{L}\p{N}\s']/gu, ' ').split(/\s+/u).filter(Boolean);
function wer(reference, hypothesis) {
  const ref = words(reference);
  const hyp = words(hypothesis);
  let row = Array.from({ length: hyp.length + 1 }, (_, j) => j);
  for (let i = 1; i <= ref.length; i++) {
    const next = [i];
    for (let j = 1; j <= hyp.length; j++)
      next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (ref[i - 1] === hyp[j - 1] ? 0 : 1));
    row = next;
  }
  return row[hyp.length] / ref.length;
}
const pct = (list, p) => {
  if (!list.length) return null;
  const sorted = [...list].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
};
const mb = bytes => (bytes == null ? '–' : `${Math.round(bytes / 1e6)} MB`);
const ms = v => (v == null ? '–' : `${Math.round(v)} ms`);

/**
 * One clip through a STREAMING engine. Live: each 100 ms chunk is sent when it would have reached
 * a microphone. Word lag uses the model's own token times.
 */
async function sherpaClip(samples, live) {
  await call('begin', { language: 'en' });
  const chunk = live ? SR / 10 : SR / 2;
  const start = performance.now();
  const steps = [];
  let decodeTotal = 0;
  let firstWordAt = null;
  const seen = [];
  const lags = [];
  const jobs = [];
  const handle = reply => {
    const now = performance.now() - start;
    if (reply.steps > 0) steps.push(reply.decodeMs / reply.steps);
    decodeTotal += reply.decodeMs;
    if (reply.text && firstWordAt === null) firstWordAt = now;
    $('live').textContent = reply.text;
    // A token's first appearance: lag = now − when the model says it was spoken.
    for (let k = seen.length; k < reply.timestamps.length; k++) {
      seen.push(reply.tokens[k]);
      lags.push(now - reply.timestamps[k] * 1000);
    }
  };
  for (let i = 0; i < samples.length; i += chunk) {
    const piece = samples.slice(i, i + chunk);
    if (live) await sleep(start + ((i + piece.length) / SR) * 1000 - performance.now());
    const job = call('chunk', { samples: piece }, [piece.buffer]).then(handle);
    if (live) jobs.push(job);
    else await job;
  }
  await Promise.all(jobs);
  const audioEnd = (samples.length / SR) * 1000;
  const fin = await call('end');
  handle(fin);
  const endAt = performance.now() - start;
  return {
    text: fin.text,
    rtf: decodeTotal / audioEnd,
    stepP50: pct(steps, 50),
    stepP95: pct(steps, 95),
    firstWordAt,
    lagP50: pct(lags, 50),
    lagP95: pct(lags, 95),
    finalAfterEnd: endAt - audioEnd,
    heap: fin.peakHeap,
  };
}

/**
 * One clip through Parakeet the way near-live drives it: re-transcribe the last ≤8 s every ≥1.2 s
 * while the audio plays, never two passes at once, then one pass over the whole take at the end.
 */
async function parakeetClip(samples, live) {
  const audioEnd = (samples.length / SR) * 1000;
  if (!live) {
    const r = await call('transcribe', { samples });
    return { text: r.text, rtf: r.decodeMs / audioEnd, stepP50: r.decodeMs, stepP95: r.decodeMs, firstWordAt: null, lagP50: null, lagP95: null, finalAfterEnd: null, heap: null };
  }
  const start = performance.now();
  const passes = [];
  const lags = [];
  let firstWordAt = null;
  let heardUntil = 0; // seconds of audio whose words have already been timed
  for (;;) {
    const elapsed = performance.now() - start;
    if (elapsed >= audioEnd) break;
    const fed = Math.floor((elapsed / 1000) * SR);
    const from = Math.max(0, fed - 8 * SR);
    const r = await call('transcribe', { samples: samples.slice(from, fed) });
    const now = performance.now() - start;
    passes.push(r.decodeMs);
    if (r.text && firstWordAt === null) firstWordAt = now;
    $('live').textContent = r.text;
    for (const w of r.words) {
      const spokenEnd = from / SR + w.end;
      if (spokenEnd > heardUntil + 0.05) {
        lags.push(now - spokenEnd * 1000);
        heardUntil = spokenEnd;
      }
    }
    await sleep(Math.max(0, 1200 - r.decodeMs));
  }
  await sleep(audioEnd - (performance.now() - start));
  const final = await call('transcribe', { samples });
  const endAt = performance.now() - start;
  $('live').textContent = final.text;
  return {
    text: final.text,
    rtf: final.decodeMs / audioEnd,
    stepP50: pct(passes, 50),
    stepP95: pct(passes, 95),
    firstWordAt,
    lagP50: pct(lags, 50),
    lagP95: pct(lags, 95),
    finalAfterEnd: endAt - audioEnd,
    heap: null,
  };
}

async function runClips(mode) {
  const live = mode === 'live';
  setBusy(true);
  const per = [];
  try {
    for (const [index, clip] of CLIPS.entries()) {
      setStatus(`${live ? 'Playing' : 'Decoding'} clip ${index + 1} of ${CLIPS.length}…`);
      const samples = await readWav(clip.file);
      const onset = speechOnset(samples) * 1000;
      const r = current.engine === 'sherpa' ? await sherpaClip(samples, live) : await parakeetClip(samples, live);
      per.push({ ...r, onset, seconds: samples.length / SR, wer: wer(clip.text, r.text), reference: clip.text });
    }
    const seconds = per.reduce((t, r) => t + r.seconds, 0);
    const refWords = per.reduce((t, r) => t + words(r.reference).length, 0);
    const run = {
      model: current.id,
      mode: live ? 'live' : 'flat-out',
      slowdown,
      seconds,
      rtf: per.reduce((t, r) => t + r.rtf * r.seconds, 0) / seconds,
      stepP50: pct(per.map(r => r.stepP50).filter(v => v != null), 50),
      stepP95: Math.max(...per.map(r => r.stepP95 ?? 0)),
      firstWord: live ? pct(per.map(r => (r.firstWordAt == null ? null : r.firstWordAt - r.onset)).filter(v => v != null), 50) : null,
      lagP50: live ? pct(per.map(r => r.lagP50).filter(v => v != null), 50) : null,
      lagP95: live ? Math.max(...per.map(r => r.lagP95 ?? 0)) : null,
      finalAfterEnd: live ? pct(per.map(r => r.finalAfterEnd), 50) : null,
      wer: per.reduce((t, r) => t + r.wer * words(r.reference).length, 0) / refWords,
      heap: Math.max(...per.map(r => r.heap ?? 0)) || null,
      clips: per.map(({ reference, ...rest }) => rest),
    };
    results.runs.push(run);
    addRow(run);
    setStatus('Done.', 'good');
    return run;
  } catch (error) {
    setStatus(`Run failed: ${error.message}`, 'bad');
    throw error;
  } finally {
    setBusy(false);
  }
}

// ---------- microphone ----------
let mic = null;
async function toggleMic() {
  if (mic) return stopMic();
  setBusy(true, true);
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 } });
    const context = new AudioContext();
    const source = context.createMediaStreamSource(stream);
    const node = context.createScriptProcessor(4096, 1, 1);
    const ratio = context.sampleRate / SR;
    const captured = [];
    const start = performance.now();
    const state = { stream, context, node, captured, start, firstWordAt: null, steps: [], decodeTotal: 0, jobs: [] };
    if (current.engine === 'sherpa') await call('begin', { language: query.get('lang') || 'en' });
    node.onaudioprocess = event => {
      const input = event.inputBuffer.getChannelData(0);
      const out = new Float32Array(Math.floor(input.length / ratio));
      for (let i = 0; i < out.length; i++) out[i] = input[Math.floor(i * ratio)];
      captured.push(out);
      if (current.engine === 'sherpa') {
        state.jobs.push(
          call('chunk', { samples: out }).then(r => {
            if (r.steps > 0) state.steps.push(r.decodeMs / r.steps);
            state.decodeTotal += r.decodeMs;
            if (r.text && state.firstWordAt === null) state.firstWordAt = performance.now() - start;
            $('live').textContent = r.text;
          }),
        );
      }
    };
    source.connect(node);
    node.connect(context.destination);
    mic = state;
    $('mic').textContent = 'Stop';
    setStatus(current.engine === 'sherpa' ? 'Listening — words should appear as you speak.' : 'Listening — Parakeet transcribes when you stop.');
  } catch (error) {
    setBusy(false);
    setStatus(`Microphone failed: ${error.message}`, 'bad');
  }
}

async function stopMic() {
  const state = mic;
  mic = null;
  state.node.disconnect();
  state.stream.getTracks().forEach(t => t.stop());
  await state.context.close();
  $('mic').textContent = 'Speak (tap again to stop)';
  const total = state.captured.reduce((t, c) => t + c.length, 0);
  const seconds = total / SR;
  const stoppedAt = performance.now();
  let text;
  let rtf;
  let heap = null;
  let stepP50 = null;
  if (current.engine === 'sherpa') {
    await Promise.all(state.jobs);
    const fin = await call('end');
    text = fin.text;
    heap = fin.peakHeap;
    rtf = (state.decodeTotal + fin.decodeMs) / (seconds * 1000);
    stepP50 = pct(state.steps, 50);
  } else {
    const all = new Float32Array(total);
    let offset = 0;
    for (const c of state.captured) {
      all.set(c, offset);
      offset += c.length;
    }
    const r = await call('transcribe', { samples: all });
    text = r.text;
    rtf = r.decodeMs / (seconds * 1000);
  }
  $('live').textContent = text || '(nothing heard)';
  const run = {
    model: current.id,
    mode: 'microphone',
    slowdown,
    seconds,
    rtf,
    stepP50,
    stepP95: null,
    firstWord: state.firstWordAt,
    lagP50: null,
    lagP95: null,
    finalAfterEnd: performance.now() - stoppedAt,
    wer: null,
    heap,
    text,
  };
  results.runs.push(run);
  addRow(run);
  setBusy(false);
  setStatus('Done.', 'good');
}

// ---------- loading ----------
let progressFiles = {};
function onProgress({ file, got, total }) {
  progressFiles[file] = { got, total };
  const all = Object.values(progressFiles);
  const sumGot = all.reduce((t, f) => t + f.got, 0);
  const sumTotal = current.files.reduce((t, f) => t + f.bytes, 0);
  $('progress').style.width = `${Math.min(100, (100 * sumGot) / sumTotal).toFixed(1)}%`;
  setStatus(`Downloading ${mb(sumGot)} of ${mb(sumTotal)}…`);
}

async function loadModel(id) {
  const model = MODELS.find(m => m.id === id);
  current = model;
  progressFiles = {};
  setBusy(true);
  $('progress').style.width = '0';
  setStatus('Starting the speech engine…');
  startWorker(model);
  const t0 = performance.now();
  try {
    const value = await call('load', { files: model.files, multilingual: Boolean(model.multilingual) });
    const load = { model: id, wallMs: performance.now() - t0, ...value };
    results.loads.push(load);
    $('progress').style.width = '100%';
    setStatus(`Loaded in ${(load.wallMs / 1000).toFixed(1)} s${value.fromCache ? ' (from this device’s cache)' : ''}. Engine set-up ${(value.initMs / 1000).toFixed(1)} s.`, 'good');
    renderSummary();
    return load;
  } catch (error) {
    setStatus(`Load failed: ${error.message}`, 'bad');
    current = null;
    throw error;
  } finally {
    setBusy(false);
  }
}

// ---------- page ----------
function deviceInfo() {
  return {
    userAgent: navigator.userAgent,
    cores: navigator.hardwareConcurrency ?? null,
    deviceMemoryGB: navigator.deviceMemory ?? null,
    crossOriginIsolated: globalThis.crossOriginIsolated === true,
    when: new Date().toISOString(),
  };
}

function setStatus(text, tone = '') {
  const el = $('status');
  el.textContent = text;
  el.className = tone;
}

function setBusy(busy, micOnly = false) {
  $('load').disabled = busy;
  $('clear').disabled = busy;
  $('model').disabled = busy;
  $('clipLive').disabled = busy || !current;
  $('clipFast').disabled = busy || !current;
  $('mic').disabled = (busy && !micOnly) || !current;
}

function renderSummary() {
  const load = results.loads.at(-1);
  const rows = load
    ? [
        ['Model', current.label],
        ['Licence', current.licence],
        ['Download', `${mb(load.downloadedBytes)} in ${(load.downloadMs / 1000).toFixed(1)} s${load.fromCache ? ' (cached)' : ''}`],
        ['Engine set-up', ms(load.initMs)],
        ['Heap after load', mb(load.heapNow)],
      ]
    : [];
  $('summary').innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${escapeHtml(String(v))}</dd>`).join('');
}

function addRow(run) {
  const tone = run.rtf < 0.5 ? 'good' : run.rtf < 1 ? 'warn' : 'bad';
  const tr = document.createElement('tr');
  const cells = [
    run.model,
    `${run.mode}${run.slowdown > 1 ? ` ×${run.slowdown}` : ''} · ${run.seconds.toFixed(1)} s`,
    `<span class="${tone}">${run.rtf.toFixed(2)}</span>`,
    `${ms(run.stepP50)} / ${ms(run.stepP95)}`,
    ms(run.firstWord),
    run.lagP50 == null ? '–' : `${ms(run.lagP50)} / ${ms(run.lagP95)}`,
    ms(run.finalAfterEnd),
    run.wer == null ? escapeHtml(run.text || '') : `${(run.wer * 100).toFixed(1)}%`,
    mb(run.heap),
  ];
  const labels = ['Model', 'Run', 'RTF', 'Step p50/p95', 'First word', 'Word lag p50/p95', 'Final after end', 'WER / text', 'Heap'];
  tr.innerHTML = cells.map((c, i) => `<td data-label="${labels[i]}">${c}</td>`).join('');
  $('runs').tBodies[0].append(tr);
}

function escapeHtml(text) {
  return text.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}

function init() {
  $('model').innerHTML = MODELS.map(m => `<option value="${m.id}">${escapeHtml(m.label)}</option>`).join('');
  const note = () => {
    const m = MODELS.find(x => x.id === $('model').value);
    const total = m.files.reduce((t, f) => t + f.bytes, 0);
    $('modelNote').textContent = `${mb(total)} download, kept on this device after the first load · ${m.licence}`;
  };
  $('model').onchange = note;
  note();
  $('load').onclick = () => loadModel($('model').value).catch(() => {});
  $('clipLive').onclick = () => runClips('live').catch(() => {});
  $('clipFast').onclick = () => runClips('fast').catch(() => {});
  $('mic').onclick = () => toggleMic();
  $('copy').onclick = async () => {
    const text = JSON.stringify(results, null, 2);
    try {
      await navigator.clipboard.writeText(text);
      setStatus('Results copied.', 'good');
    } catch {
      setStatus('Clipboard blocked — results are in the console.', 'warn');
      console.log(text);
    }
  };
  $('clear').onclick = async () => {
    await caches.delete('nemotron-bench-v1');
    setStatus('Downloaded models deleted from this device.', 'good');
  };
  const d = results.device;
  $('device').innerHTML = [
    ['Browser', d.userAgent],
    ['CPU cores', d.cores ?? 'unknown'],
    ['Memory (rounded)', d.deviceMemoryGB ? `${d.deviceMemoryGB} GB` : 'not reported'],
    ['Slow-down', slowdown > 1 ? `×${slowdown} (simulated)` : 'none'],
  ]
    .map(([k, v]) => `<dt>${k}</dt><dd>${escapeHtml(String(v))}</dd>`)
    .join('');
  setBusy(false);
}

init();
