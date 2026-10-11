// Prompts for the three agent roles in the loop:
// 1. Shopper personas (simulated users)  2. Analyst (finds friction, proposes variants)
// 3. Builder (implements one variant)

export interface Persona {
  id: string;
  who: string;
  task: string;
}

export const DEFAULT_PERSONAS: Persona[] = [
  {
    id: 'budget-student',
    who: 'a student with about $20 to spend',
    task: 'find a gift under $20 for a developer friend',
  },
  {
    id: 'hoodie-hunter',
    who: 'a busy engineer who already knows they want a hoodie in size L',
    task: 'find all hoodies available in size L and pick the cheapest one',
  },
  {
    id: 'sticker-collector',
    who: 'someone who only cares about stickers',
    task: 'see every sticker product and compare their prices quickly',
  },
];

const SHOPPER_RULES = `
You are role-playing a REAL HUMAN shopper. You are NOT a developer and you must NOT edit any files.
The shop is running at http://localhost:3000 . Look at it the way a shopper would:
- Fetch the page with: curl -s http://localhost:3000/
- Also fetch any linked scripts/styles/data it loads (for example /app.js, /styles.css, /products.json)
  so you understand exactly what the page shows and which controls (search, filters, sort, buttons) exist.
- Judge only what a person in a browser would actually see and be able to do.
Think step by step about the clicks and scrolling you would need, then answer.`;

export function shopperPrompt(persona: Persona, goal: string): string {
  return `${SHOPPER_RULES}

Who you are: ${persona.who}.
Your task: ${persona.task}.
Context from the product team (do not mention it, just shop): "${goal}"

Reply with ONLY a JSON object, no prose, in exactly this shape:
{
  "persona": "${persona.id}",
  "completed": true | false,
  "steps": <estimated number of clicks/scrolls/scans a human would need>,
  "score": <1-10, how easy the task was, 10 = effortless>,
  "journey": ["short step", "short step", "..."],
  "friction": ["specific thing that slowed you down or confused you", "..."],
  "quote": "one sentence a real user might say after trying"
}`;
}

export function analystPrompt(goal: string, sessions: unknown[], count: number): string {
  return `You are a senior product analyst running an A/B experiment.
Product goal: "${goal}"

Below are the reports from simulated shoppers who just used the baseline version of the site
(the code is in the current directory: index.html, app.js, styles.css, products.json).

${JSON.stringify(sessions, null, 2)}

1. Summarise the main friction in 2-3 sentences.
2. Propose exactly ${count} DIFFERENT variants that could fix it. Each variant must be a small,
   self-contained front-end change that a coding agent can build in a few minutes using only
   index.html, app.js and styles.css (no new dependencies, no build step, no backend changes).
   Make the variants genuinely different approaches so the A/B test is interesting.

Reply with ONLY a JSON object, no prose:
{
  "summary": "...",
  "variants": [
    { "id": "B", "title": "short name", "hypothesis": "why this should help", "spec": "what to build, concrete" }
  ]
}
Use ids "B", "C", "D" ... in order (A is the baseline).`;
}

export function builderPrompt(variant: { title: string; spec: string }): string {
  return `You are improving a small static web shop in the current directory.
Files: index.html, app.js, styles.css, products.json, server.mjs.

Implement this change:
Title: ${variant.title}
Spec: ${variant.spec}

Rules:
- Only edit index.html, app.js and styles.css. Do NOT touch server.mjs or products.json.
- Plain HTML/CSS/JS only. No frameworks, no npm installs, no build step.
- Keep the existing look and the "Add to cart" buttons.
- The server is already running on port 3000 and serves files fresh on every request,
  so do not start or restart any server.
- When done, run: curl -s http://localhost:3000/ | head -40  to confirm the page still loads.

Finish with one short paragraph describing what you changed.`;
}
