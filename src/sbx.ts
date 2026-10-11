// Thin helpers over the Docker Sandboxes TypeScript SDK (@docker/sandboxes).
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  fileOAuthCredentialStore,
  oauth,
  pat,
  Sandboxes,
  type Sandbox,
} from '@docker/sandboxes';

export const APP_DIR = '/tmp/shop';
export const APP_PORT = 3000;

// ---------- auth ----------
export async function connect(): Promise<Sandboxes> {
  const { DOCKER_USERNAME, DOCKER_PAT } = process.env;
  if (DOCKER_USERNAME && DOCKER_PAT) {
    // Unattended: Docker PAT with the sandbox:use permission.
    return new Sandboxes({ auth: pat({ username: DOCKER_USERNAME, personalAccessToken: DOCKER_PAT }) });
  }
  // Attended: device-code sign-in, cached locally so re-runs during a demo don't prompt again.
  const auth = oauth({
    store: fileOAuthCredentialStore({ path: '.docker-sandboxes/oauth.json' }),
    onVerification: ({ verificationUriComplete, verificationUri, userCode }) => {
      console.log(`\n  Sign in to Docker: ${verificationUriComplete ?? verificationUri}`);
      console.log(`  Code: ${userCode}\n`);
    },
  });
  await auth.getAccessToken();
  return new Sandboxes({ auth });
}

// ---------- OpenAI key as a stored secret (never put in env or args) ----------
// Returns a secret resource name to attach to each sandbox. The sandbox proxy uses it to inject the
// Authorization header on Codex's calls to api.openai.com. The secret must be attached explicitly:
// unlike the `sbx` CLI, the SDK does not auto-attach the globally stored OpenAI secret.
export async function openaiSecret(client: Sandboxes): Promise<string> {
  if (process.env.OPENAI_SECRET) return process.env.OPENAI_SECRET; // e.g. "secrets/abc123"
  const key = process.env.OPENAI_API_KEY;
  if (key) {
    const secret = await client.secrets.create({
      displayName: 'sbx-ab-agent-openai',
      serviceType: 'openai',
      token: { value: key },
    });
    log('secret', `stored OpenAI key as ${secret.name} (export OPENAI_SECRET=${secret.name} to reuse)`);
    return secret.name;
  }
  // No key in the env: reuse an already-stored OpenAI secret so the demo runs without one in .env.
  for await (const s of client.secrets.all()) {
    if ((s as { serviceType?: string }).serviceType === 'openai') {
      log('secret', `using existing OpenAI secret ${s.name}`);
      return s.name;
    }
  }
  throw new Error('No OpenAI credential: set OPENAI_API_KEY or OPENAI_SECRET, or run `sbx secret set openai`.');
}

// ---------- sandbox lifecycle ----------
export async function launchShop(
  client: Sandboxes,
  displayName: string,
  secret: string,
  localAppDir: string,
): Promise<{ sandbox: Sandbox; url: string }> {
  const sandbox = await client.kits.launchAndWait('codex', {
    displayName,
    resources: 'small',
    storage: { secrets: [secret] },
  });

  // Copy the app in through the files API.
  await sandbox.files.mkdir(APP_DIR, { mode: 0o755, parents: true });
  for (const f of await readdir(localAppDir)) {
    await sandbox.files.write(`${APP_DIR}/${f}`, await readFile(join(localAppDir, f), 'utf8'));
  }

  // Start the server as a long-running process (we don't attach to it).
  await sandbox.processes.start({
    args: ['node', 'server.mjs'],
    workingDir: APP_DIR,
    env: { PORT: String(APP_PORT) },
    label: 'shop-server',
  });
  await waitForHttp(sandbox);

  // Publish the port and get a public HTTPS URL for the live demo.
  const port = await sandbox.ports.create({ number: APP_PORT, protocol: 'tcp' });
  return { sandbox, url: port.url ?? '(no url returned)' };
}

async function waitForHttp(sandbox: Sandbox, tries = 30) {
  const probe = `fetch('http://127.0.0.1:${APP_PORT}/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))`;
  for (let i = 0; i < tries; i++) {
    const r = await sandbox.run(['node', '-e', probe]);
    if (r.exitCode === 0) return;
    await new Promise((res) => setTimeout(res, 1000));
  }
  throw new Error(`shop server did not come up in ${sandbox.name}`);
}

export async function destroy(sandbox: Sandbox) {
  try {
    const latest = await sandbox.refresh();
    const deleting = await latest.delete({ force: true });
    await deleting?.waitUntilDeleted();
  } catch (e) {
    log('cleanup', `could not delete ${sandbox.name}: ${(e as Error).message}`);
  }
}

// ---------- run Codex (OpenAI) headless inside a sandbox ----------
// `codex exec` is the non-interactive mode. We're already inside a microVM, so we bypass Codex's
// own approval+sandbox layer. The prompt is fed on stdin with the `-` argument (passing it as a
// positional arg makes codex still block reading stdin and exit 1). `-o` writes just the final
// assistant message to a file, which we read back (cleaner than parsing the --json event stream).
// A unique output file per call keeps parallel sessions on one sandbox from colliding.
export async function runAgent(sandbox: Sandbox, prompt: string, timeoutMs = 600_000): Promise<string> {
  const outFile = `/tmp/codex-${randomUUID()}.out`;
  const script =
    `printf '%s' "$1" | codex exec -C ${APP_DIR} --skip-git-repo-check --ephemeral ` +
    `--dangerously-bypass-approvals-and-sandbox -o ${outFile} -`;
  const r = await sandbox.processes.run(
    { args: ['bash', '-lc', script, 'bash', prompt], workingDir: APP_DIR },
    { timeoutMs },
  );
  if (r.exitCode !== 0) {
    // The real error is at the tail; the head is just codex's startup banner.
    const out = `${r.stderr ?? ''}\n${r.stdout ?? ''}`.trim();
    throw new Error(`codex exited ${r.exitCode} in ${sandbox.name}: ${out.slice(-800)}`);
  }
  try {
    return await sandbox.files.read(outFile, { encoding: 'utf8' });
  } catch {
    return r.stdout;
  }
}

// Pull the first JSON object out of an LLM reply (tolerates ```json fences and stray prose).
export function extractJson<T>(text: string): T {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error(`no JSON in reply: ${text.slice(0, 300)}`);
  return JSON.parse(body.slice(start, end + 1)) as T;
}

// ---------- logging ----------
const t0 = Date.now();
const C = { dim: '\x1b[2m', cyan: '\x1b[36m', green: '\x1b[32m', yellow: '\x1b[33m', bold: '\x1b[1m', reset: '\x1b[0m' };
export function log(tag: string, msg: string) {
  const s = ((Date.now() - t0) / 1000).toFixed(0).padStart(4);
  console.log(`${C.dim}${s}s${C.reset} ${C.cyan}[${tag}]${C.reset} ${msg}`);
}
export function banner(msg: string) {
  console.log(`\n${C.bold}${C.yellow}== ${msg} ==${C.reset}`);
}
export const color = C;
