# Create: pictures (and later sound and video) for agents that cannot make them

An agent whose runtime has no image tool (an open-weight model behind Claude Code, say) calls `generate_image`.
Create makes the picture on **the owner's own fal key**, prices the call before it is sent, refuses past a daily
limit, and asks the owner before one dear call. This page is the contract; the code is `packages/plugins/create`.

Built so far: the core (tools, price table, ledger, daily cap, the ask) and `generate_image`. Speech and sound (U14),
the streamed media route that lifts the 1 MiB chat limit (U15), and video (U16) come after it.

## Turning it on

1. The owner stores the key: `fy secret set FAL_KEY` (the value is never shown or returned; see
   [secrets.md](secrets.md)).
2. The owner names it in `config/create.yaml`. Only the owner can add that line (a ferret's write that adds a secret
   reference is held):

```yaml
fal:
  key: ${secret:FAL_KEY}
limits:
  dailyUsd: 5 # all creative tools together; refused past it
  askAboveUsd: 1 # one call dearer than this asks the owner first
timeZone: America/Los_Angeles # where "a day" ends; default: this machine's own zone
```

Without `fal.key` the tool answers "creative tools are off" and nothing leaves the machine. Raising either limit, or
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

A megapixel rate is proportional to the picture's area. A per-image rate on a picture over one megapixel is priced as
that many megapixels, so the estimate is never below a per-megapixel bill. A price fal gives in any currency but USD is
refused. The source lives beside each price in `contract/pricing.ts`.

## The limits

In this order, for every call:

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

Calls run one at a time, so two ferrets asking together cannot both pass the same cap.

## The ledger

`state/create/ledger.jsonl` (`0600`, private: no ferret reads it through any root) keeps one line per spend: time, day,
tool, model, ferret, cost in micro-dollars, whether fal or the table priced it, and a digest of the request. **Never**
the prompt, a key, or anything fal sent. **The spend is reserved before the run**, so a call that may have been billed
is always counted. It is given back (a second line, `refund: true`, that cancels the first; the ledger is only ever
appended to) only when fal definitely billed nothing: the request never left, fal refused it, or it answered 401, 403,
429 or another 4xx. A timeout, a dropped connection, a 5xx or an answer that cannot be read stays counted.

## Where the key goes, and where it does not

- `kernel.secrets.send` places `FAL_KEY` as `Authorization: Key …` on a request to **`fal.run`** (the run) or
  **`api.fal.ai`** (the price), the only two hosts it may reach (`permissions.network`, named exactly). Create never
  holds the value; a reply that echoes it is reported unreadable; the security log names the secret and host only
  ([secrets.md](secrets.md#a-plugins-own-key-placed-by-the-kernel)).
- The picture is fetched from `https://*.fal.media` with **no key**, and from nowhere else. A wildcard host can never
  receive a key.
- fal is a third party: the **prompt** goes to it, and the key is a key it can bill. The ask shows the prompt (at
  most 400 characters) so the owner knows what they are approving; agenda text is readable by every ferret.

## Declared gaps

- **The day's zone is Create's own key or the host's.** Usage's `usage.yaml` `timeZone` is not read: Create does not
  depend on Usage, so `create.yaml` `timeZone` names the zone, and absent it the day follows the machine's own zone
  (what Usage does when it has none).
- **Estimates, not invoices.** fal returns no cost with a run, so the ledger holds the price that was shown. Its own
  usage page is the authority for the bill.
- **A real run has not been made.** Everything here was built and tested against a fake fal; the first real picture
  waits for the owner's key (about $0.003).
