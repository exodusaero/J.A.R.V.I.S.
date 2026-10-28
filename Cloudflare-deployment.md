# J.A.R.V.I.S. — Cloudflare deployment (public, verified chat)

The Cloudflare build is an original, interactive cinematic HUD with public,
Turnstile-verified, rate-limited conversation using Cloudflare Workers AI.
It does **not** use ChatGPT Plus, expose visitors' Mac files or devices, or run
Ollama in the cloud. The optional local Python companion remains separate.

## 1. Managed Turnstile verification

The approved Turnstile widget **JARVIS Public Chat** is registered for only
`j-a-r-v-i-s.business-exodusindustries.workers.dev`, with public sitekey
`0x4AAAAAAFo6JY22BhMNI09Q`. The corresponding secret is stored as
`TURNSTILE_SECRET` in the existing Cloudflare Worker `j-a-r-v-i-s` and must
**never** be copied into code, GitHub, or the browser.

`wrangler.jsonc` defines the public `TURNSTILE_SITEKEY` and exact production
`TURNSTILE_HOSTNAME`, the `AI` binding, and the SQLite-backed
`PUBLIC_CHAT_QUOTA` Durable Object. Do not remove these settings. A mismatched
hostname, missing secret, missing quota binding, expired challenge, wrong
action (`jarvis_chat`), or failed Siteverify call blocks chat.

The verification widget appears beneath the chat form only in hosted mode.
Each message requires a fresh, single-use token; the browser resets the widget
after every attempt. **The rest of the website remains public**, without an
email login. Remove any Cloudflare Access application that you deliberately
configured for the whole hostname if you intend the entire site to be public.

Only the production hostname is accepted by the backend; localhost is not an
approved widget domain. Cloudflare docs: [Turnstile server-side verification](https://developers.cloudflare.com/turnstile/get-started/server-side-validation/).

## 2. Deploy the Cloudflare Worker

The repository already has `wrangler.jsonc`: `main` points to the Worker, the
`AI` binding provides model inference, and static assets come from `./web`.
For a Git-integrated build, select the repository's desired branch, keep the
root directory at repository root, and use **`npx wrangler deploy`** as the
deploy command. No separate frontend build is required. Do not deploy only
`web/` as a static preview; the Worker entrypoint must be published too.

From your own machine, with Cloudflare authentication configured:

```bash
npm ci
npm test
npm run check    # dry-run only
npm run deploy   # live deployment; requires your explicit approval
```

Test on the actual hostname in a browser and on a phone: the interface should
load publicly, but chat should stay disabled until Turnstile completes. After
verification, a chat request should return a model reply. Direct API calls
without Turnstile should return HTTP 403. A replayed token should fail. Confirm
the hourly and daily quota responses, and check Cloudflare's AI usage dashboard.

Public requests are limited by a strongly consistent SQLite Durable Object to
**4 responses per visitor per hour**, **12 per visitor per UTC day**, and **60
globally per UTC day**. Visitor IP addresses are converted to day-specific
keyed digests; raw IPs are not retained in quota storage. These limits are
conservative rollout safeguards and do not translate to an exact billing cap.

## Cost and model disclosure

- The current model is Cloudflare-hosted `@cf/meta/llama-3.1-8b-instruct-fp8`.
- Workers AI provides a daily Free-plan Neuron allocation; exceeding it means
  inference fails until reset if you remain on the Free plan. On a paid plan,
  overage can be billed. Verify your Cloudflare plan and spending controls.
- This is **not ChatGPT/GPT-6** and does **not** consume your ChatGPT Plus usage.
- Conversation state is held only in the active browser tab (up to 8 recent
  messages sent with each prompt); the Worker stores no chat transcripts.
- Visitors should not enter secrets, company confidential data, or protected research into
  the Cloudflare AI chat unless you have reviewed its applicable data terms.

See [Cloudflare Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/).

## Local companion

The Cloudflare site cannot read process usage or files from a visitor's Mac.
To use those capabilities, start the Python assistant locally instead:

```bash
python3 -m pip install -e .
ollama pull llama3.2:3b
python3 -m jarvis --web --speak
```

Open `http://127.0.0.1:8765`. Mac commands require explicit one-use approval
cards; code development approvals are separate. Never expose the loopback
server directly to the public Internet.
