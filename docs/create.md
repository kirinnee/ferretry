# Create: pictures, sound and video for agents that cannot make them

An agent whose runtime has no image or sound tool (an open-weight model behind Claude Code, say) calls
`generate_image`, `generate_speech`, `generate_sfx`, `generate_music`, `generate_video` or `generate_avatar_video`. Create makes the file on **the owner's own
fal, ElevenLabs and HeyGen keys**, prices the call before it is sent, refuses past a daily limit, and asks the owner before one
dear call. This page is the contract; the code is `packages/plugins/create`.

Built: the core (tools, price table, ledger, daily cap, the ask), `generate_image`, the sound tools
(`generate_speech`, `generate_sfx`, `generate_music`), and video (`generate_video` + `generation_status`, below). A
clip is played from the media folder through the streamed byte route ([fy-render.md](fy-render.md) rule 11), up to
32 MiB.

## Turning it on

1. The owner stores a key: `fy secret set FAL_KEY` (pictures, sound effects, music),
   `fy secret set ELEVENLABS_API_KEY` (speech) and/or `fy secret set HEYGEN_API_KEY` (avatar video). The value is never shown or returned; see [secrets.md](secrets.md).
2. The owner names each in `config/create.yaml`. Only the owner can add that line (a ferret's write that adds a secret
   reference is held):

```yaml
fal:
  key: ${secret:FAL_KEY}
elevenlabs:
  key: ${secret:ELEVENLABS_API_KEY}
heygen:
  key: ${secret:HEYGEN_API_KEY}
limits:
  dailyUsd: 5 # all creative tools together; refused past it
  askAboveUsd: 1 # one call dearer than this asks the owner first
timeZone: America/Los_Angeles # where "a day" ends; default: this machine's own zone
```

Without a tool's key (`fal.key` for the picture, sound-effect and music tools, `elevenlabs.key` for speech, `heygen.key` for avatar video) the tool answers
"creative tools are off", "speech is off" or "avatar video is off" and nothing leaves the machine. One key does not turn on the other
provider's tools. Raising either limit, or
changing `timeZone`, loosens spend, so the edit is held for the owner ([config-files.md](config-files.md)).

## The tool

`generate_image(prompt, model?, size?)`: one picture. `model` is `flux-schnell` (default), `flux-dev` or `flux-pro`;
`size` is one of fal's named shapes, each at or just over one megapixel (default `landscape_4_3`, 1024×768). The
answer is **one piece to paste**: a cost line (`flux-schnell · $0.002 · $0.05 of $5 today`) and the `fy-render` block
that shows the picture, under "Put these lines in your reply:".

**The picture reaches the chat with no step by the ferret.** Ferrets' `deliverMedia` seam (the harness seam beside
`deliverFiles`) writes it into the ferret's own `media/` folder (`FY_MEDIA_DIR`, `0700` folder, `0600` file, through a
handle scoped to that folder alone), and the block names it `src: media:<name>`. The chat shows an image of at most
1 MiB ([fy-render.md](fy-render.md)); a larger one is kept in the media folder and the answer gives only the cost line.

### The sound tools

All three answer the same way as a picture: **one piece to paste**, a cost line and a `fy-render` block, here
`type: audio`, so the chat plays it with its own player. Every sound is asked for as MP3 at 64 kbit/s (8 000 bytes a
second, so a minute is under 0.5 MiB), and a file over the chat's **1 MiB** is kept in the media folder with only the
cost line, as a large picture is.

- `generate_speech(text, voice?, model?)`: reads `text` (1–1 500 characters, about 100 s) aloud with ElevenLabs.
  `voice` is an ElevenLabs voice id (letters and digits; default the premade Rachel, `21m00Tcm4TlvDq8ikWAM`);
  `model` is `flash` (default) or `multilingual`.
- `generate_sfx(prompt, seconds?)`: one sound effect of exactly `seconds` (0.5–22, default 5) through fal's
  `fal-ai/elevenlabs/sound-effects/v2`. The length is part of the request because it is the price.
- `generate_music(prompt, seconds?, instrumental?)`: a short piece (3–60 s, default 30) through fal's
  `fal-ai/elevenlabs/music`. ElevenLabs music goes **through fal**, not through ElevenLabs' own API (owner decision O4).

**Speech goes through the Vault as JSON.** The Vault's outbound holder returns only parsed JSON (≤ 4 MiB here), so raw
audio from ElevenLabs would be dropped. Create calls the `/v1/text-to-speech/{voice}/with-timestamps` endpoint, which
answers JSON whose `audio_base64` field is the MP3, and decodes it itself. Only that field is read; the per-letter
timings it also returns are ignored. A reply that is not JSON is unreadable, so the call is counted as possibly billed.

### Video: two calls, because a clip takes minutes

`generate_video(prompt, model?, seconds?, aspect?, resolution?, audio?)` puts one request in **fal's queue**
(`POST queue.fal.run/<endpoint>`) and answers at once with a **job id** (`vid_…`). `generation_status(job)` asks fal
about it: still waiting (it says so, spends nothing), or made, in which case Create fetches the file from fal's
storage with no key, saves it to the ferret's media folder and answers the same one piece to paste as a picture, here
`type: video`. Asked again after that it answers the same block and fetches nothing. A job is its ferret's own: another
ferret's id is answered as no job.

- `model`: `kling` (default; Kling 2.6 Pro, `fal-ai/kling-video/v2.6/pro/text-to-video`; 5 or 10 s; 16:9, 9:16 or 1:1) or
  `veo-fast` (Veo 3.1 Fast, `fal-ai/veo3.1/fast`; 4, 6 or 8 s, default 8; 16:9 or 9:16; `resolution` 720p or 1080p).
  A length, shape or resolution the model does not take is refused before any price is read; 4K is not offered.
- `audio` (default **false**) asks for generated sound, which doubles the price. Every setting is sent by name, so no
  default of fal's can change what the call costs.
- **Priced by the second**: Kling $0.07 (sound $0.14), Veo Fast $0.10 (sound $0.15), 720p and 1080p alike, from the
  pages in `contract/pricing.ts`. fal's own rate is asked first; it is ONE number per endpoint, so it is compared with the
  table for **both** options (sound off and on) and the clip is priced at the **higher** (a price that rose is seen; one
  that fell is not; a base rate that rose lifts a clip with sound by the table's own sound/silent ratio),
  and a live rate in a unit other than the second refuses the call. So a Kling 5 s silent clip is $0.35, a Veo 8 s silent
  $0.80, and a Veo 8 s clip with sound is **$1.20, over the $1 limit: it asks first**.
- **The spend is reserved when it is queued**, by the same steps as every tool (cap, ask, reserve). Checking a job never
  reserves or charges again.
- **A job fal fails is refunded only on an error fal does not bill, and only from its status.** fal's one statement on
  billing is that "failed requests that return 5xx status codes are not billed"
  ([Reliability](https://fal.ai/docs/documentation/model-apis/inference/reliability.md)). So the refund (the ledger's
  `refund: true` line) is given when the **status** endpoint ends the request (`COMPLETED` carrying an `error`) with an
  `error_type` of that 5xx class (`request_timeout`, `startup_timeout`, `runner_*`, `internal_error`) or `bad_request`
  (the same "4xx = no charge" rule a refused submit already follows). A cancel or dropped client (`client_cancelled`,
  `client_disconnected`, 499), `content_policy_violation`, and any `error_type` Create does not know **stay counted**.
  A request whose status says `COMPLETED` with no error succeeded and was billed, so a result that will not read (422, 499,
  5xx, a dropped connection) is **never a refund**: the job stays open and is read again on the next `generation_status`
  (free), and after 5 failed reads (of the result, or of the file on fal's storage, which also covers a file that has
  expired) it is closed as counted with "made and paid for, could not be fetched, do NOT retry". A result that has expired
  (404; fal keeps a result for an hour), a finished answer with no video, a job fal no longer knows, a file on a host that
  is not fal's storage, or a file over 32 MiB or not a video also **stays counted** at once, and the ferret is told not to
  retry. A clip that could not be saved leaves the job open: asking again retries for free.
- **A restart loses nothing and charges nothing twice.** The job (fal's request id and the two queue addresses it
  answered, https on `queue.fal.run` only) is written to `state/create/jobs.jsonl` (`0600`, private) before `generate_video`
  answers; `generation_status` reads it from there. The order is chosen so a crash can only **over-count**: the spend is
  reserved before fal is called, and a job's end is written before its refund. The same request made again while its
  job is still open is answered with that job and not queued again.

## What it costs, and where each price came from

Every call is priced **before** it is sent. fal's own price endpoint is asked first
(`GET api.fal.ai/v1/models/pricing?endpoint_id=…`,
[docs](https://fal.ai/docs/platform-apis/v1/models/pricing)), and its answer is used when it names a unit Create can
price (per megapixel, or per image). The table below is the allow-list (a model not in it is never called) and the
price when fal cannot be asked. A live rate in a unit Create cannot read **refuses the call**: a price the owner was
not shown is not spent. The answer says which one priced the call (`fal's price` or `the listed price`).

| Model          | fal endpoint           | Table price | Read from (2026-11-24)                                                                    |
| -------------- | ---------------------- | ----------- | ----------------------------------------------------------------------------------------- |
| `flux-schnell` | `fal-ai/flux/schnell`  | $0.003 / MP | [fal.ai/models/fal-ai/flux/schnell](https://fal.ai/models/fal-ai/flux/schnell/llms.txt)   |
| `flux-dev`     | `fal-ai/flux/dev`      | $0.025 / MP | [fal.ai/models/fal-ai/flux/dev](https://fal.ai/models/fal-ai/flux/dev/llms.txt)           |
| `flux-pro`     | `fal-ai/flux-pro/v1.1` | $0.04 / MP  | [fal.ai/models/fal-ai/flux-pro/v1.1](https://fal.ai/models/fal-ai/flux-pro/v1.1/llms.txt) |

| Voice (ElevenLabs) | Table price              | Read from (2026-11-24)                                                                                                       |
| ------------------ | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `flash`            | $0.05 / 1 000 characters | [elevenlabs.io/pricing/api](https://elevenlabs.io/pricing/api) (Flash / Turbo)                                               |
| `multilingual`     | $0.10 / 1 000 characters | [elevenlabs.io/pricing/api](https://elevenlabs.io/pricing/api) (Multilingual v2; one page says $0.08, so the higher is kept) |

| Sound (fal)  | fal endpoint                         | Table price                                              | Read from (2026-11-24)                                                                                                |
| ------------ | ------------------------------------ | -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| sound effect | `fal-ai/elevenlabs/sound-effects/v2` | $0.002 / second                                          | [fal.ai/models/fal-ai/elevenlabs/sound-effects/v2](https://fal.ai/models/fal-ai/elevenlabs/sound-effects/v2/llms.txt) |
| music        | `fal-ai/elevenlabs/music`            | $0.60 / audio minute, **rounded up to the whole minute** | [fal.ai/models/fal-ai/elevenlabs/music](https://fal.ai/models/fal-ai/elevenlabs/music/llms.txt)                       |

| Video (fal) | fal endpoint                                | Table price (sound off / on) | Read from (2026-11-24)                                                                                                              |
| ----------- | ------------------------------------------- | ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `kling`     | `fal-ai/kling-video/v2.6/pro/text-to-video` | $0.07 / $0.14 per second     | [fal.ai/models/fal-ai/kling-video/v2.6/pro/text-to-video](https://fal.ai/models/fal-ai/kling-video/v2.6/pro/text-to-video/llms.txt) |
| `veo-fast`  | `fal-ai/veo3.1/fast`                        | $0.10 / $0.15 per second     | [fal.ai/models/fal-ai/veo3.1/fast](https://fal.ai/models/fal-ai/veo3.1/fast/llms.txt)                                               |

**ElevenLabs has no price endpoint**, so speech is always priced from the table above (the answer says `the listed
price`), by the characters of the text sent. fal's own endpoint is asked first for the sound effect and the music, and
its rate is used when it is per second or per minute; a per-minute rate on a sound effect, and any rate on music, is
priced from the whole minute, so the estimate is never below what fal bills. A sound's price in a picture's unit (and a
picture's in a time unit) is refused.

A megapixel rate is proportional to the picture's area. A per-image rate on a picture over one megapixel is priced as
that many megapixels, so the estimate is never below a per-megapixel bill. A price fal gives in any currency but USD is
refused. The source lives beside each price in `contract/pricing.ts`.

## The limits

In this order, for every call, **whichever tool made it** (one ledger, one cap, one queue):

1. **Daily cap** (`limits.dailyUsd`, default **$5**, all creative tools together). A call that would pass it is
   refused, with the sum so far, and nothing is asked. A day ends at midnight in `timeZone` (absent: the
   machine's own zone, as Usage counts its days).
2. **Ask over one call's limit** (`limits.askAboveUsd`, default **$1**). A dearer call raises an ask on the ferret's
   agenda, in the existing Asks path (source `create-spend`, a `permission` ask, blocking), and **sends nothing**. The
   ferret is told to call again with exactly the same request once the owner answers. The owner's **Approve** lets
   that one call through and is then spent; the same words asked again ask again. An approval holds for the price it was
   asked at: if the price is higher when the ferret calls again, it asks again. **Reject** refuses it. If the
   agenda cannot take the ask, nothing is sent.
3. Otherwise the call goes.

Calls run one at a time, through one queue for every tool, so two ferrets asking together (for the same tool or not)
cannot both pass the same cap. An approval is for one request of one tool: the tool, the settings and the words are all
part of what was approved.

## The ledger

`state/create/ledger.jsonl` (`0600`, private: no ferret reads it through any root) keeps one line per spend: time, day,
tool (`generate_image`, `generate_speech`, `generate_sfx`, `generate_music` or `generate_video`), model, ferret, cost in micro-dollars, whether the provider's own endpoint (fal) or the table priced it, and a digest of the request. **Never**
the prompt, a key, or anything fal sent. **The spend is reserved before the run**, so a call that may have been billed
is always counted. It is given back (a second line, `refund: true`, that cancels the first; the ledger is only ever
appended to) only when the provider definitely billed nothing: the request never left, it was refused, or it answered 401, 403,
429 or another 4xx. A timeout, a dropped connection, a 5xx or an answer that cannot be read stays counted.

### Avatar video (HeyGen): two calls, the same money steps

`generate_avatar_video(script, avatar, voice, aspect?)` has a HeyGen avatar read `script` (1–1 500 characters) in a voice,
as a talking-head video (`16:9` default, or `9:16`, 720p, made by HeyGen's **Avatar IV** engine, which every request names). `avatar` and `voice` are ids from the owner's own HeyGen account:
there is no default, so none is invented. It goes through the **same** steps as every creative tool: the one daily cap, the
ask over $1, the reservation in the one ledger before HeyGen is called, the one queue. It answers a job id; the video is
made in minutes. `avatar_video_status(job)` is free: while it is made it says so, and when it is made it fetches the file
from HeyGen's storage with no key, saves it to the ferret's media folder and answers the `fy-render` block under the cost
line. The job is kept in `state/create/avatar-jobs.jsonl` (owner-only) so a restart loses nothing.

**The price is a table** (HeyGen has no price endpoint). HeyGen bills per generated second and per engine, so the request
**pins the engine** (`avatar_iv`) and the reservation is that engine's per-second rate: Avatar IV's **$4.83 a minute**
(a digital twin or studio avatar; a photo avatar is $2.31, and Create does not know which the owner's avatar is, so it
reserves the dearer), billed by the second. The speaking time is guessed from the script at 15 characters a second and
**rounded up to the whole second**, so a 31-character script is 3 s = $0.25, 300 characters is 20 s = $1.61, 900 is a
minute = $4.83 and 1 500 is 100 s = $8.05, over the default $5 daily limit until the owner raises it. A reservation never
undercounts the engine's rate, and the ask over $1 still triggers on a longer script. A reservation is given back only when HeyGen refused the submit with a 4xx. A video HeyGen
fails, no longer knows, or finishes with no file stays **counted** (HeyGen's refund rules are not something Create relies
on), and the ferret is told not to ask again.

## Where the key goes, and where it does not

- `kernel.secrets.send` places `FAL_KEY` as `Authorization: Key …` on a request to **`fal.run`** (the run),
  **`queue.fal.run`** (a video's queue, status and result) or **`api.fal.ai`** (the price), `ELEVENLABS_API_KEY` as `xi-api-key: …` on a request to **`api.elevenlabs.io`**, and `HEYGEN_API_KEY` as `x-api-key: …` on a request to **`api.heygen.com`**.
  Those are the only hosts it may reach (`permissions.network`, named exactly). Create never
  holds the value; a reply that echoes it is reported unreadable; the security log names the secret and host only
  ([secrets.md](secrets.md#a-plugins-own-key-placed-by-the-kernel)).
- The picture or sound is fetched from `https://*.fal.media` with **no key**, and from nowhere else. An avatar video is fetched, with no key, from `https://*.heygen.ai` or `https://*.heygen.com` only. A wildcard host can never
  receive a key.
- fal, ElevenLabs and HeyGen are third parties: the **prompt** (for speech, the **text**; for an avatar video, the **script**,
  with the avatar and voice ids) goes to them, and the key is a key it can bill. The ask shows the prompt (at
  most 400 characters) so the owner knows what they are approving; agenda text is readable by every ferret.

## Declared gaps

- **A secret is bound to the plugin's hosts, not to one host.** The kernel lets a plugin place any secret it declares on
  any exact host it declares. Create's code places `FAL_KEY` only on fal's hosts and `ELEVENLABS_API_KEY` only on
  ElevenLabs', and a test pins the headers; the kernel does not enforce the pairing.
- **Music's output address is assumed to be fal's own storage.** fal's page shows one example reply on
  `storage.googleapis.com`; Create fetches only from `*.fal.media`, so a music reply on any other host is refused
  after it was paid for, and said so.
- **The ElevenLabs voice ids and prices are from public pages, not an account.** Premade voices can be limited by plan.
- **The day's zone is Create's own key or the host's.** Usage's `usage.yaml` `timeZone` is not read: Create does not
  depend on Usage, so `create.yaml` `timeZone` names the zone, and absent it the day follows the machine's own zone
  (what Usage does when it has none).
- **A crash between fal answering a submit and the job being written loses the job** (the money stays counted, and the
  ferret is told so if the write fails; a crash at that instant is not told). fal's own usage page shows the clip.
- **fal's result is kept for an hour.** A job nobody checks within that hour may be unfetchable (it is then counted, not
  refunded).
- **HeyGen is built against its public API reference, not a live reply.** The request and status shapes (v3: `POST /v3/videos`, `GET /v3/videos/{video_id}`; HeyGen retired the v2 and v1 endpoints on 2026-10-31), the storage hosts (`*.heygen.ai`, `*.heygen.com`) and the price (Avatar IV at $4.83 a minute billed by the second, [HeyGen's API pricing page](https://help.heygen.com/en/articles/10060327-heygen-api-pricing-credits-explained)) are from public pages; the first real video waits for the owner's key. If a real video comes from another host it is refused after it was paid for, and said so.
- **Estimates, not invoices.** fal returns no cost with a run, so the ledger holds the price that was shown. Its own
  usage page is the authority for the bill.
- **No real run has been made.** Everything here was built and tested against fake fal and ElevenLabs servers; the first
  real picture (about $0.003), voiceover (about $0.001), sound effect ($0.01), song ($0.60) and Kling 5 s clip ($0.35)
  wait for the owner's keys. The queue's wire shape (`request_id`, `status_url`, `response_url`, `COMPLETED` with an
  `error`) is from fal's queue documentation, not a live reply.
