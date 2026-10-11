// sbx A/B agent: an autonomous A/B testing loop on Docker Cloud Sandboxes.
//
//   A (baseline)  ->  simulated shoppers  ->  analyst proposes variants
//        |
//        +--> B, C, ... each in its own sandbox: Claude Code builds it,
//             the same shoppers re-test it, scores are compared, winner's code is pulled back.
//
// Built on the Docker Sandboxes TypeScript SDK (@docker/sandboxes).
import { mkdir, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import type { Sandbox, Sandboxes } from '@docker/sandboxes';
import { analystPrompt, builderPrompt, DEFAULT_PERSONAS, shopperPrompt, type Persona } from './prompts.js';
import {
  APP_DIR, banner, color, connect, destroy, extractJson, launchShop, log, openaiSecret, runAgent,
} from './sbx.js';

interface Session {
  persona: string; completed: boolean; steps: number; score: number;
  journey: string[]; friction: string[]; quote: string;
}
interface Variant { id: string; title: string; hypothesis: string; spec: string }
interface Arm {
  id: string; title: string; url: string; sandbox: Sandbox;
  sessions: Session[]; avgScore: number; completion: number; avgSteps: number; buildNotes?: string;
}

const { values: opts } = parseArgs({
  options: {
    goal: { type: 'string', default: "Shoppers say it's hard to find what they want. They scroll the whole catalog to find a cheap gift, a hoodie in their size, or all the stickers." },
    variants: { type: 'string', default: '2' },
    personas: { type: 'string', default: '3' },
    cleanup: { type: 'boolean', default: false },
  },
});
const GOAL = opts.goal!;
const N_VARIANTS = Math.max(1, Math.min(4, Number(opts.variants)));
const PERSONAS = DEFAULT_PERSONAS.slice(0, Math.max(1, Number(opts.personas)));

async function simulate(sandbox: Sandbox, armId: string, personas: Persona[]): Promise<Session[]> {
  return Promise.all(
    personas.map(async (p) => {
      log(`${armId}:${p.id}`, 'shopping...');
      try {
        const s = extractJson<Session>(await runAgent(sandbox, shopperPrompt(p, GOAL), 300_000));
        log(`${armId}:${p.id}`, `score ${s.score}/10, ${s.completed ? 'completed' : 'gave up'}, ~${s.steps} steps. "${s.quote}"`);
        return s;
      } catch (e) {
        log(`${armId}:${p.id}`, `session failed: ${(e as Error).message}`);
        return { persona: p.id, completed: false, steps: 0, score: 0, journey: [], friction: ['session failed'], quote: '' };
      }
    }),
  );
}

function stats(sessions: Session[]) {
  const n = sessions.length || 1;
  return {
    avgScore: sessions.reduce((a, s) => a + s.score, 0) / n,
    completion: sessions.filter((s) => s.completed).length / n,
    avgSteps: sessions.reduce((a, s) => a + s.steps, 0) / n,
  };
}

async function runVariant(client: Sandboxes, secret: string, v: Variant): Promise<Arm> {
  const tag = `${v.id}`;
  log(tag, `launching sandbox for "${v.title}"`);
  const { sandbox, url } = await launchShop(client, `ab-${v.id}-${slug(v.title)}`, secret, 'app');
  log(tag, `live at ${url}`);
  log(tag, 'Codex is building the variant...');
  const buildNotes = await runAgent(sandbox, builderPrompt(v), 900_000);
  log(tag, `built. ${buildNotes.split('\n').filter(Boolean).pop()?.slice(0, 160) ?? ''}`);
  const sessions = await simulate(sandbox, tag, PERSONAS);
  return { id: v.id, title: v.title, url, sandbox, sessions, buildNotes, ...stats(sessions) };
}

async function main() {
  banner('sbx A/B agent');
  log('goal', GOAL);
  const client = await connect();
  const sandboxes: Sandbox[] = [];
  try {
    const secret = await openaiSecret(client);

    // 1. Baseline
    banner('1. Deploy baseline (A)');
    const base = await launchShop(client, 'ab-A-baseline', secret, 'app');
    sandboxes.push(base.sandbox);
    log('A', `live at ${base.url}`);

    // 2. Simulated users on baseline
    banner('2. Simulated shoppers on A');
    const baseSessions = await simulate(base.sandbox, 'A', PERSONAS);
    const A: Arm = { id: 'A', title: 'Baseline', url: base.url, sandbox: base.sandbox, sessions: baseSessions, ...stats(baseSessions) };

    // 3. Analyst proposes variants
    banner('3. Analyse friction, propose variants');
    const plan = extractJson<{ summary: string; variants: Variant[] }>(
      await runAgent(base.sandbox, analystPrompt(GOAL, baseSessions, N_VARIANTS)),
    );
    const variants = plan.variants.slice(0, N_VARIANTS);
    log('analyst', plan.summary);
    for (const v of variants) log('analyst', `${v.id}: ${v.title} -- ${v.hypothesis}`);

    // 4 + 5. Build and re-test every variant in parallel, one sandbox each
    banner(`4. Build + re-test ${variants.length} variants in parallel`);
    const settled = await Promise.allSettled(variants.map((v) => runVariant(client, secret, v)));
    const arms: Arm[] = [A];
    settled.forEach((r, i) => {
      if (r.status === 'fulfilled') { arms.push(r.value); sandboxes.push(r.value.sandbox); }
      else log(variants[i].id, `variant failed: ${(r.reason as Error).message}`);
    });

    // 6. Pick a winner
    banner('5. Results');
    const ranked = [...arms].sort((a, b) => b.avgScore - a.avgScore || b.completion - a.completion || a.avgSteps - b.avgSteps);
    const winner = ranked[0];
    printTable(arms, winner, A);

    // 7. Pull the winner's code back so it can become a PR
    await mkdir('results/winner', { recursive: true });
    if (winner.id !== 'A') {
      for (const f of ['index.html', 'app.js', 'styles.css']) {
        const body = await winner.sandbox.files.read(`${APP_DIR}/${f}`, { encoding: 'utf8' });
        await writeFile(`results/winner/${f}`, body);
      }
      log('winner', `copied ${winner.id}'s files to results/winner/ (diff against app/ for the PR)`);
    }
    await writeReport(arms, winner, A, plan.summary);
    log('report', 'wrote results/report.md and results/report.json');

    if (!opts.cleanup) {
      console.log(`\n${color.bold}Sandboxes are still running so you can click through each arm live.${color.reset}`);
      console.log('Delete them with: npm run cleanup');
    }
  } finally {
    if (opts.cleanup) {
      banner('Cleanup');
      await Promise.all(sandboxes.map(destroy));
      log('cleanup', `deleted ${sandboxes.length} sandboxes`);
    }
    await client.close();
  }
}

function printTable(arms: Arm[], winner: Arm, A: Arm) {
  const rows = arms.map((a) => [
    a.id === winner.id ? `${a.id} *` : a.id,
    a.title.slice(0, 34),
    a.avgScore.toFixed(1),
    `${Math.round(a.completion * 100)}%`,
    a.avgSteps.toFixed(1),
    a.id === 'A' ? '-' : lift(a.avgScore, A.avgScore),
    a.url,
  ]);
  const head = ['Arm', 'Variant', 'Ease', 'Done', 'Steps', 'Lift', 'Live URL'];
  const w = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (r: string[]) => r.map((c, i) => c.padEnd(w[i])).join('  ');
  console.log(color.bold + line(head) + color.reset);
  rows.forEach((r) => console.log(r[0].includes('*') ? color.green + line(r) + color.reset : line(r)));
  console.log(`\n${color.green}${color.bold}Winner: ${winner.id} - ${winner.title}${color.reset}`);
}

async function writeReport(arms: Arm[], winner: Arm, A: Arm, summary: string) {
  await mkdir('results', { recursive: true });
  const plain = arms.map(({ sandbox, ...rest }) => ({ ...rest, sandbox: sandbox.name }));
  await writeFile('results/report.json', JSON.stringify({ goal: GOAL, summary, winner: winner.id, arms: plain }, null, 2));
  const md = [
    `# A/B run: ${new Date().toISOString()}`,
    '', `**Goal:** ${GOAL}`, '', `**Baseline friction:** ${summary}`, '',
    '| Arm | Variant | Ease (1-10) | Task done | Avg steps | Lift vs A |',
    '|---|---|---|---|---|---|',
    ...arms.map((a) => `| ${a.id}${a.id === winner.id ? ' (winner)' : ''} | ${a.title} | ${a.avgScore.toFixed(1)} | ${Math.round(a.completion * 100)}% | ${a.avgSteps.toFixed(1)} | ${a.id === 'A' ? '-' : lift(a.avgScore, A.avgScore)} |`),
    '',
    ...arms.flatMap((a) => [
      `## ${a.id}: ${a.title}`, '', `Live: ${a.url}`, '',
      ...(a.buildNotes ? ['**What Claude Code changed:**', '', a.buildNotes.trim(), ''] : []),
      ...a.sessions.flatMap((s) => [
        `- **${s.persona}**: ${s.score}/10, ${s.completed ? 'completed' : 'gave up'}, ~${s.steps} steps. _"${s.quote}"_`,
        ...s.friction.map((f) => `  - friction: ${f}`),
      ]),
      '',
    ]),
  ].join('\n');
  await writeFile('results/report.md', md);
}

const lift = (x: number, base: number) => (base > 0 ? `${x >= base ? '+' : ''}${Math.round(((x - base) / base) * 100)}%` : 'n/a');
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30);

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
