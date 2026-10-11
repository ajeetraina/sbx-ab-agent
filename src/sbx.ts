// Thin helpers over the Docker Sandboxes TypeScript SDK (@docker/sandboxes).
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

// ---------- Anthropic key as a stored secret (never put in env or args) ----------
export async function anthropicSecret(client: Sandboxes): Promise<string> {
  if (process.env.ANTHROPIC_SECRET) return process.env.ANTHROPIC_SECRET; // e.g. "secrets/abc123"
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    throw new Error('Set ANTHROPIC_SECRET (existing secret resource name) or ANTHROPIC_API_KEY.');
  }
  const secret = await client.secrets.create({
    displayName: 'sbx-ab-agent-anthropic',
    serviceType: 'anthropic',
    token: { value: key },
  });
  log('secret', `stored Anthropic key as ${secret.name} (export ANTHROPIC_SECRET=${secret.name} to reuse)`);
  return secret.name;
}

// ---------- sandbox lifecycle ----------
export async function launchShop(
  client: Sandboxes,
  displayName: string,
  secret: string,
  localAppDir: string,
): Promise<{ sandbox: Sandbox; url: string }> {
  const sandbox = await client.kits.launchAndWait('claude', {
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

// ---------- run Claude Code headless inside a sandbox ----------
export async function claude(sandbox: Sandbox, prompt: string, timeoutMs = 600_000): Promise<string> {
  const r = await sandbox.processes.run(
    {
      args: ['claude', '-p', prompt, '--output-format', 'json', '--dangerously-skip-permissions'],
      workingDir: APP_DIR,
      env: { IS_SANDBOX: '1' },
    },
    { timeoutMs },
  );
  if (r.exitCode !== 0) {
    throw new Error(`claude exited ${r.exitCode} in ${sandbox.name}: ${r.stderr.slice(0, 500)}`);
  }
  try {
    return String(JSON.parse(r.stdout).result ?? r.stdout);
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
