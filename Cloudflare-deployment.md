# J.A.R.V.I.S. — Cloudflare deployment (private AI)

The Cloudflare build is an original, interactive cinematic HUD with a separate
Cloudflare Workers AI conversation endpoint. It does **not** use ChatGPT Plus,
does not expose the user's Mac files or devices, and does not run Ollama in the
cloud. The optional local Python companion remains separate.

## 1. Protect the Worker with Cloudflare Access **before enabling inference**

In your Cloudflare account, activate Zero Trust if needed, and create a
Cloudflare Access application that protects the entire `j-a-r-v-i-s` Worker,
including the production hostname, custom domains, and preview deployments.
Set its **Allow** policy to only your own verified account/email. Do **not**
choose an Everyone policy. Check authorized and unauthorized access yourself.

Cloudflare docs: [Protect a Worker with Access](https://developers.cloudflare.com/workers/configuration/cloudflare-access/).

The Worker also validates Cloudflare's signed identity token on every API call;
without all three settings below it denies all AI requests, even if someone
accidentally makes the site publicly reachable.

Set these two non-secret environment variables on the Worker in the Cloudflare
dashboard, or with Wrangler, to exactly match the Access application:

| Name | Required value |
| --- | --- |
| `TEAM_DOMAIN` | `https://YOUR-TEAM.cloudflareaccess.com` |
| `POLICY_AUD` | Your Access application's audience (AUD) tag |
| `OWNER_EMAIL` | Your exact verified sign-in email, used for an additional owner-only check |

Never enter these as sample placeholders. You can find the AUD tag under
Zero Trust → Access → Applications → your application → Additional settings.
They identify the policy and owner, but do not grant access by themselves. Sign-in is
handled by Cloudflare Access, not by a custom Jarvis password form.

**Warning:** A deployment with an incorrect Access policy may allow unwanted
visitors to reach the static page. The API still fails closed without a valid
signed Access JWT, but keep the whole site protected for privacy.

## 2. Deploy the Cloudflare Worker

The repository already has `wrangler.jsonc`: `main` points to the Worker, the
`AI` binding provides model inference, and static assets come from `./web`.
For a Git-integrated build, select the repository's desired branch, keep the
root directory at repository root, and use **`npx wrangler deploy`** as the
deploy command. No separate frontend build is required.

From your own machine, with Cloudflare authentication configured:

```bash
npm ci
npm test
npm run check    # dry-run only
npm run deploy   # live deployment; requires your explicit approval
```

Test the protected hostname using an allowed identity, then an unauthorized
browser/private session. The allowed account should get a conversation reply;
an unauthorized browser must fail at the Access login/policy stage, and
direct requests to `/api/chat` without an Access JWT must return HTTP 403.

## Cost and model disclosure

- The current model is Cloudflare-hosted `@cf/meta/llama-3.1-8b-instruct-fp8`.
- Workers AI provides a daily Free-plan Neuron allocation; exceeding it means
  inference fails until reset (unless you deliberately choose a paid plan).
- This is **not ChatGPT/GPT-6** and does **not** consume your ChatGPT Plus usage.
- Conversation state is held only in the active browser tab (up to 12 recent
  messages sent with each prompt); the Worker stores no chat transcripts.
- Do not enter secrets, company confidential data, or protected research into
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
