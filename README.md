# sbx A/B agent

An autonomous A/B testing loop that runs on **Docker Cloud Sandboxes**, built with the
[Docker Sandboxes TypeScript SDK](https://docs.docker.com/ai/sandboxes-api/) (`@docker/sandboxes`).

Simulated shoppers find what's hard about a site, Claude Code builds fixes in parallel sandboxes, the same
shoppers re-test every variant, and the winning code comes back ready for a pull request.

## What happens when you run it

```
                 ┌───────────────────────────── Docker Cloud Sandboxes ─────────────────────────────┐
 npm start ──►   │  A  baseline shop  ── 3 shopper personas (Claude Code) ── analyst proposes B, C   │
                 │                                                                                  │
                 │  B  fresh sandbox ── Claude Code builds variant B ── same 3 shoppers re-test      │  (parallel)
                 │  C  fresh sandbox ── Claude Code builds variant C ── same 3 shoppers re-test      │
                 └──────────────────────────────────────────────────────────────────────────────────┘
                         │
                         ▼
           results table + winner, results/report.md, results/winner/*  (ready for a PR)
```

1. **Deploy baseline (A).** Launches the `claude` kit, copies `app/` in with the files API, starts the server
   as a background process and publishes port 3000. You get a public HTTPS URL.
2. **Simulate shoppers.** Three personas (budget student, hoodie hunter, sticker collector) run as headless
   Claude Code sessions inside the sandbox. Each one looks at the shop like a real user and returns a JSON report:
   did they finish the task, how many steps it took, an ease score, and what slowed them down.
3. **Analyse.** An analyst prompt reads those reports and proposes N different variants.
4. **Build and re-test, in parallel.** Each variant gets its own sandbox. Claude Code edits the shop, and the
   live URL updates right away. The same shoppers then re-test that variant.
5. **Pick a winner.** Ranks arms by ease score, then completion, then fewer steps. Prints a table with lift vs A,
   writes `results/report.md` and `results/report.json`, and copies the winner's files to `results/winner/`.

The demo shop (`app/`) is a zero-dependency Node server and a product grid with **no search, filter or sort**.
That gap is what the agent should find and fix.

## SDK calls used

| Step | SDK call |
|---|---|
| Sign in | `oauth()` with `fileOAuthCredentialStore`, or `pat()` |
| Store Anthropic key | `client.secrets.create({ serviceType: 'anthropic', ... })` |
| Launch sandbox | `client.kits.launchAndWait('claude', { storage: { secrets } })` |
| Copy app in / pull winner out | `sandbox.files.mkdir` / `files.write` / `files.read` |
| Start server | `sandbox.processes.start({ args, workingDir, env })` |
| Health check | `sandbox.run([...])` |
| Public URL | `sandbox.ports.create({ number: 3000, protocol: 'tcp' })` then `port.url` |
| Run agents | `sandbox.processes.run({ args: ['claude', '-p', ...] })` |
| Clean up | `client.allSandboxes()`, `sandbox.delete({ force: true })` |

## Prerequisites

- Node.js 20+
- A Docker account with an active Docker Agentic Platform subscription (cloud sandboxes access)
- An Anthropic API key (for Claude Code inside the sandboxes)

## Run it

```bash
npm install
cp .env.example .env     # fill in ANTHROPIC_API_KEY (and optionally DOCKER_USERNAME / DOCKER_PAT)
set -a; source .env; set +a

npm start                              # 2 variants, 3 personas
npm start -- --variants 3 --personas 2
npm start -- --goal "Users can't tell which items are on sale"
npm start -- --cleanup                 # delete sandboxes at the end
```

Without `DOCKER_USERNAME`/`DOCKER_PAT`, the script prints a sign-in link and code. The sign-in is cached in
`.docker-sandboxes/oauth.json` (plaintext, git-ignored) so re-runs during the demo don't ask again.

On the first run the Anthropic key is stored as a cloud secret and the script prints its resource name.
Set `ANTHROPIC_SECRET=secrets/...` to reuse it and skip creating another one.

By default the sandboxes **stay running** after the run so you can open each arm's URL side by side on stage.
Remove them with:

```bash
npm run cleanup     # deletes every sandbox whose display name starts with "ab-"
```

Preview the baseline shop locally: `npm run shop`, then open http://localhost:3000.

## Demo tips

- A full run with 2 variants and 3 personas uses 3 small sandboxes and about 12 Claude Code calls.
  Expect roughly 5 to 10 minutes. Do one run before the talk and keep those sandboxes as a fallback.
- Open the A, B and C URLs in three browser tabs while the shoppers are re-testing. B and C change in front
  of the audience as Claude Code edits the files.
- `diff -u app/app.js results/winner/app.js` is a good closing slide: the agent's PR in one screen.

## Honest limits

- The shoppers are Claude Code sessions that read the page with `curl` (HTML, JS and data), not a real browser.
  That's enough to judge missing search or filters, but not visual layout. Swapping in a browser agent is the
  natural next step (a Playwright kit from `docker/sbx-kits-contrib` would keep it all inside the sandbox).
- Scores come from LLM judgement on a handful of sessions. It's a demo of the loop, not a stats engine.
- Each variant starts from a fresh sandbox. The SDK also supports `sandbox.snapshot()` and `snapshot.restore()`,
  so a later version could fork variants from the baseline's exact state instead.
- The Sandboxes API and SDK are experimental, so names may change between SDK releases.
  This was written against `@docker/sandboxes` 0.53.0.
