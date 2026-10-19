# Spike: Nemotron streaming ASR in the browser

Measurement only. Nothing here ships, and nothing outside this folder changed. Phone page:
**https://ferretry-asr-bench.pages.dev**

Question: can NVIDIA Nemotron streaming ASR (through sherpa-onnx WebAssembly) give Ferretry live
dictation on a phone, next to the Parakeet TDT 0.6B v3 engine that ships today?

**Answer: no, not in a browser today.** Nemotron 0.6B is accurate, but in single-thread WASM it
**does not keep up with real time even on a fast desktop core** (RTF 1.4 at 560 ms chunks, about 4 at
160 ms chunks). Per second of audio it costs about 3.4× what Parakeet costs. A phone would need a
core well over 1.4× faster than a Xeon Platinum 8488C core to stream it.

## What was built

- `sherpa-onnx-wasm-asr.patch`: sherpa-onnx v1.13.8 `wasm/asr` built with emsdk 4.0.23. The model
  is loaded at runtime (Emscripten FS) instead of being baked into a `.data` file, and the memory
  ceiling is 4 GB. The output is a 13 MB `.wasm` file, SIMD and single-threaded.
- `web/`: the page plus a classic worker (`sherpa-worker.js`) for the streaming models.
- `parakeet-worker.ts`: the same Parakeet stack Ferretry ships (parakeet.js 1.4.4 and
  onnxruntime-web 1.24.1 wasm, one thread, the same pinned files), for a comparison on the same device.
- `build.ts` assembles `dist/`. `measure.ts` drives headless Chrome. `smoke-deployed.ts` checks the
  deployed page against real Hugging Face downloads and takes the screenshots.
- `results/*.jsonl`: raw output, one line per (model, profile).

Models are fetched from Hugging Face at pinned revisions (`csukuangfj2/sherpa-onnx-nemotron-*`,
`csukuangfj/sherpa-onnx-nemo-streaming-fast-conformer-transducer-en-480ms-int8`,
`ysdede/parakeet-tdt-0.6b-v3-onnx`) and kept in Cache Storage.

## Desktop: headless Chrome 154, Xeon 8488C, 1 WASM thread

The box was shared, with a load average of 16–44 on 29 cores. Treat the absolute numbers as ±20%.
The ratios between models are the robust part.

| Model                         | Download | Set-up | WASM heap | Renderer RSS | RTF       | Step p50          | First word | Word lag p50 / p95 | Final after end | WER  |
| ----------------------------- | -------- | ------ | --------- | ------------ | --------- | ----------------- | ---------- | ------------------ | --------------- | ---- |
| FastConformer 480 ms (114M)   | 137 MB   | 1.7 s  | 537 MB    | 0.77 GB      | **0.29**  | 151 ms / 480 ms   | 1.1 s      | 0.66 / 0.89 s      | 0.3 s           | 1.0% |
| Nemotron EN 0.6B 560 ms       | 662 MB   | 2.9 s  | 868 MB    | 2.63 GB      | **1.43**  | 748 ms / 560 ms   | 1.8 s      | 2.9 / 6.2 s ↑      | 5.0 s           | 0.0% |
| Nemotron 3.5 multi 560 ms     | 682 MB   | 2.0 s  | 880 MB    | 2.79 GB      | **1.41**  | 741 ms / 560 ms   | 1.8 s      | 2.5 / 6.0 s ↑      | 4.7 s           | 3.9% |
| Nemotron EN 0.6B 160 ms       | 662 MB   | 2.7 s  | 868 MB    | 2.81 GB      | **4.09**  | 582 ms / 160 ms   | 3.5 s      | 15.2 / 43.6 s ↑    | 35 s            | 0.0% |
| Nemotron 3.5 multi 160 ms     | 682 MB   | 1.9 s  | 880 MB    | 2.66 GB      | **3.85**  | 573 ms / 160 ms   | 3.2 s      | 13.5 / 40.3 s ↑    | 28 s            | 3.9% |
| Parakeet TDT v3 (ships today) | 683 MB   | 2.8 s  | n/a       | 2.98 GB      | **0.41**¹ | 1.6 s near-live pass | 1.6 s   | 2.7 / 6.2 s        | 4.4 s           | 2.9% |

How to read the columns:

- **Clips.** Four LibriSpeech clips, 37 s and 102 words in total.
- **RTF.** Decode time ÷ audio time. Under 1 keeps up with speech.
- **Step.** The time to decode one model chunk, shown against the chunk's length.
- **Live columns.** In live mode the audio is fed at real speed in 100 ms pieces.
- **↑ (lag grows).** With RTF > 1 the backlog grows for as long as the person speaks, so these lags
  get worse with longer dictation. A one-minute take at 560 ms would trail by about 25 s.
- **¹ Parakeet RTF.** This is one batch pass over each whole clip. Its live row copies what
  near-live does: re-transcribe the last ≤ 8 s every ≥ 1.2 s, then one final pass over the take.
- **Download.** The local runs read the exact pinned files from disk, so download *time* there is not
  meaningful. The sizes are real.
- **Final after end.** This includes draining the backlog.

### Native sherpa-onnx, no browser (16.7 s clip, same box)

| Model                   | 1 thread | 4 threads |
| ----------------------- | -------- | --------- |
| FastConformer 480 ms    | 0.14     |           |
| Nemotron EN 560 ms      | 0.56     | 0.30      |
| Nemotron EN 160 ms      | 1.60     | 0.69      |
| Nemotron 3.5 560 ms     | 0.54     |           |
| Nemotron 3.5 160 ms     | 1.40     |           |

Most of the cost is the model, not the browser. WASM adds roughly 2.5× on top of native.
Multi-threaded WASM would need COOP/COEP cross-origin isolation, which the Ferretry PWA does not
have. Even with the native 4-thread speed-up (~1.9×), a browser 560 ms stream would sit around
RTF 0.75 on this desktop, and a phone core is slower than this one.

## Phone proxy: Pixel 7 emulation, 4× CPU throttle, 4× in-worker slow-down

DevTools CPU throttling does not reach a dedicated worker. So the workers also spin to make every
decode take 4× as long (`?slowdown=4`), the same stand-in `harness/parakeet-near-live-smoke.ts`
uses.

| Model                | RTF   | Live: first word / lag p50 / final after end |
| -------------------- | ----- | -------------------------------------------- |
| FastConformer 480 ms | 1.23  | 1.6 s / 1.7 s / 2.9 s                         |
| Parakeet (ships)     | 1.78  | 4.0 s / 9.5 s / 20.5 s                        |
| Nemotron EN 560 ms   | 5.46  | not run (cannot keep up)                      |
| Nemotron EN 160 ms   | 15.05 | not run                                       |

4× is pessimistic for a current flagship phone: Parakeet works on the owner's phone, and here it
shows RTF 1.78. Calibrate with the ratio instead. **Nemotron-560 needs about 3.4× Parakeet's compute
per second of audio**, so it can stream only on a device where Parakeet's batch RTF is under about
0.29. That is faster than this desktop (0.41).

Memory: a Nemotron tab peaks at 2.6–2.8 GB of renderer RSS, about the same as Parakeet (3.0 GB),
with an 870 MB WASM heap after load. Memory is not the blocker; compute is.

## Licences

| Weights                                                                                       | Licence                                                                                                                                         | OK for Ferretry (MIT)?                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [nvidia/nemotron-speech-streaming-en-0.6b](https://huggingface.co/nvidia/nemotron-speech-streaming-en-0.6b) | [NVIDIA Open Model License](https://www.nvidia.com/en-us/agreements/enterprise-software/nvidia-open-model-license/) (last modified 2025-10-24) | **Yes, with conditions.** Commercial use is allowed. Redistribution must ship a copy of the agreement and the notice "Licensed by NVIDIA Corporation under the NVIDIA Open Model License". Rights end on bypassing built-in guardrails or on suing NVIDIA for IP infringement. It is not an OSI licence, so the weights stay a separately licensed download: never bundled into the MIT release, and attributed in Settings. The sherpa ONNX conversion is a Derivative Model under the same terms. |
| [nvidia/nemotron-3.5-asr-streaming-0.6b](https://huggingface.co/nvidia/nemotron-3.5-asr-streaming-0.6b)     | [OpenMDW 1.1](https://openmdw.ai/license/1-1/)                                                                                                  | **Yes.** Permissive, MIT-style: use without restriction, keep the licence text and notices when distributing, and rights end on patent/copyright suits.                                                                                                                                                                                                                                                                                                                                                     |
| NeMo `stt_en_fastconformer_hybrid_large_streaming_480ms` (baseline)                           | [NGC Terms of Use](https://ngc.nvidia.com/legal/terms) (NGC card)                                                                               | **Avoid.** It is not an open licence. The multi-latency sibling [nvidia/stt_en_fastconformer_hybrid_large_streaming_multi](https://huggingface.co/nvidia/stt_en_fastconformer_hybrid_large_streaming_multi) is CC-BY-4.0, so use that one if a small streaming model is ever wanted.                                                                                                                                                                                                                    |
| [nvidia/parakeet-tdt-0.6b-v3](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3) (today)     | CC-BY-4.0                                                                                                                                       | Yes (already shipped, with attribution).                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

sherpa-onnx itself is Apache-2.0.

## Recommendation

1. **Do not integrate Nemotron for live words in the browser now.** It cannot stream in real time
   in WASM on any phone, at any chunk size. 160 ms chunks are the worst: smaller chunks re-run more
   context per second of audio, so they cost about 3× more than 560 ms.
2. Its accuracy is excellent: 0% WER here against Parakeet's 2.9%. It would be worth it where
   compute exists, i.e. **on the daemon**. `fyd` runs on the person's machine, and native sherpa-onnx
   with 4 threads streams Nemotron-560 at RTF 0.30. The phone would stream audio to it over the
   existing session. That is a different integration from this spike: a daemon-side engine plus an
   audio route, behind the same voice-engine choice. Estimated M–L.
3. If on-device streaming is still wanted, the only model in this family that keeps up on a phone
   is a ~114M FastConformer: RTF 0.29 desktop, 1.23 on the pessimistic phone proxy, 1% WER. Use the
   CC-BY-4.0 multi-latency checkpoint, not the NGC-licensed 480 ms one. Integrating it behind the
   voice-engine-choice seam costs **about M**:
   - a sherpa worker beside `parakeet-worker.ts` (the 13 MB wasm self-hosted like ORT's, plus a
     `'wasm-unsafe-eval'` CSP that is already present);
   - a pinned-files store like `parakeet-store.ts`;
   - an engine adapter whose `onPartial` feeds the dictation strip directly, replacing near-live's
     re-transcription;
   - a Settings entry, kept **off by default** as "Live words (experimental)".
   Batch Parakeet after Stop stays the default and keeps the final text.
4. Re-measure when WebGPU int8 or WASM threads (COOP/COEP) become an option for the PWA. Both
   change the compute picture; nothing else here would.

Owner, to check on a real phone: open the URL on Wi-Fi, load **FastConformer**, then one
**Nemotron 560 ms**, then **Parakeet**. Run "Clips flat-out" for each and tap **Copy results as
JSON**. If Nemotron's RTF is above 1, it cannot stream on that phone.
