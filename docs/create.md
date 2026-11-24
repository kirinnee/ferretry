# Create: pictures and sound (and later video) for agents that cannot make them

An agent whose runtime has no image or sound tool (an open-weight model behind Claude Code, say) calls
`generate_image`, `generate_speech`, `generate_sfx` or `generate_music`. Create makes the file on **the owner's own
fal and ElevenLabs keys**, prices the call before it is sent, refuses past a daily limit, and asks the owner before one
dear call. This page is the contract; the code is `packages/plugins/create`.

Built so far: the core (tools, price table, ledger, daily cap, the ask), `generate_image`, and the sound tools
(`generate_speech`, `generate_sfx`, `generate_music`). The streamed media route that lifts the 1 MiB chat limit (U15)
and video (U16) come after it.

## Turning it on

1. The owner stores a key: `fy secret set FAL_KEY` (pictures, sound effects, music) and/or
   `fy secret set ELEVENLABS_API_KEY` (speech). The value is never shown or returned; see [secrets.md](secrets.md).
2. The owner names each in `config/create.yaml`. Only the owner can add that line (a ferret's write that adds a secret
   reference is held):

```yaml
fal:
  key: ${secret:FAL_KEY}
elevenlabs:
  key: ${secret:ELEVENLABS_API_KEY}
limits:
  dailyUsd: 5 # all creative tools together; refused past it
  askAboveUsd: 1 # one call dearer than this asks the owner first
timeZone: America/Los_Angeles # where "a day" ends; default: this machine's own zone
```

Without a tool's key (`fal.key` for the picture, sound-effect and music tools, `elevenlabs.key` for speech) the tool answers
"creative tools are off" or "speech is off" and nothing leaves the machine. One key does not turn on the other
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
tool (`generate_image`, `generate_speech`, `generate_sfx` or `generate_music`), model, ferret, cost in micro-dollars, whether the provider's own endpoint (fal) or the table priced it, and a digest of the request. **Never**
the prompt, a key, or anything fal sent. **The spend is reserved before the run**, so a call that may have been billed
is always counted. It is given back (a second line, `refund: true`, that cancels the first; the ledger is only ever
appended to) only when the provider definitely billed nothing: the request never left, it was refused, or it answered 401, 403,
429 or another 4xx. A timeout, a dropped connection, a 5xx or an answer that cannot be read stays counted.

## Where the key goes, and where it does not

- `kernel.secrets.send` places `FAL_KEY` as `Authorization: Key …` on a request to **`fal.run`** (the run) or
  **`api.fal.ai`** (the price), and `ELEVENLABS_API_KEY` as `xi-api-key: …` on a request to **`api.elevenlabs.io`**.
  Those are the only hosts it may reach (`permissions.network`, named exactly). Create never
  holds the value; a reply that echoes it is reported unreadable; the security log names the secret and host only
  ([secrets.md](secrets.md#a-plugins-own-key-placed-by-the-kernel)).
- The picture or sound is fetched from `https://*.fal.media` with **no key**, and from nowhere else. A wildcard host can never
  receive a key.
- fal and ElevenLabs are third parties: the **prompt** (or, for speech, the **text**) goes to them, and the key is a key it can bill. The ask shows the prompt (at
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
- **Estimates, not invoices.** fal returns no cost with a run, so the ledger holds the price that was shown. Its own
  usage page is the authority for the bill.
- **No real run has been made.** Everything here was built and tested against fake fal and ElevenLabs servers; the first
  real picture (about $0.003), voiceover (about $0.001), sound effect ($0.01) and song ($0.60) wait for the owner's keys.
