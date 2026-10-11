// Zero-dependency live dashboard for the A/B run.
// Serves one dark/monospace HTML page and streams run state over SSE (/events).
// ab.ts pushes state through the `dash` singleton; the page re-renders on every update.
import http from 'node:http';

export interface SessionView {
  persona: string;
  status: 'shopping' | 'done' | 'failed';
  score?: number;
  completed?: boolean;
  steps?: number;
  quote?: string;
}
export interface ArmView {
  id: string;
  title: string;
  status: string; // proposed | deploying | live | building | built | shopping | scored | failed
  url?: string;
  hypothesis?: string;
  buildNote?: string;
  sessions: SessionView[];
  avgScore?: number;
  completion?: number;
  avgSteps?: number;
  lift?: string;
  winner?: boolean;
}
interface Stage {
  id: string;
  label: string;
  status: 'pending' | 'active' | 'done';
}
export interface RunForm {
  repo?: string;
  branch?: string;
  subdir?: string;
  start?: string;
  goal?: string;
  variants?: string | number;
  personas?: string | number;
}
interface State {
  goal: string;
  stages: Stage[];
  summary?: string;
  arms: Record<string, ArmView>;
  armOrder: string[];
  winner?: string;
  done: boolean;
  running: boolean;
  canTrigger: boolean;
  error?: string;
}

const STAGES: Omit<Stage, 'status'>[] = [
  { id: 'baseline', label: 'Deploy baseline' },
  { id: 'shop-a', label: 'Shoppers test A' },
  { id: 'analyze', label: 'Analyze + propose' },
  { id: 'build', label: 'Build + re-test' },
  { id: 'winner', label: 'Pick winner' },
];

const freshState = (): State => ({
  goal: '',
  stages: STAGES.map((s) => ({ ...s, status: 'pending' })),
  arms: {},
  armOrder: [],
  done: false,
  running: false,
  canTrigger: false,
});

class Dashboard {
  private state: State = freshState();
  private clients = new Set<http.ServerResponse>();
  private server?: http.Server;
  private trigger?: (form: RunForm) => Promise<void> | void;

  start(port = 4000): Promise<string> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        if (req.url === '/events') {
          res.writeHead(200, {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache',
            connection: 'keep-alive',
          });
          res.write(`data: ${JSON.stringify(this.state)}\n\n`);
          this.clients.add(res);
          req.on('close', () => this.clients.delete(res));
          return;
        }
        if (req.url === '/run' && req.method === 'POST') {
          this.handleRun(req, res);
          return;
        }
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        res.end(PAGE);
      });
      this.server.on('error', reject);
      this.server.listen(port, () => resolve(`http://localhost:${port}`));
    });
  }

  // Register the function that a form submission should run (serve mode).
  onTrigger(fn: (form: RunForm) => Promise<void> | void) {
    this.trigger = fn;
    this.state.canTrigger = true;
    this.broadcast();
  }

  private handleRun(req: http.IncomingMessage, res: http.ServerResponse) {
    const reply = (code: number, body: object) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (!this.trigger) return reply(400, { error: 'this dashboard is not in serve mode' });
    if (this.state.running) return reply(409, { error: 'a run is already in progress' });
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 1e6) req.destroy(); });
    req.on('end', () => {
      let form: RunForm = {};
      try { form = raw ? JSON.parse(raw) : {}; } catch { return reply(400, { error: 'invalid JSON' }); }
      this.state.running = true;
      this.state.error = undefined;
      this.broadcast();
      reply(202, { ok: true });
      Promise.resolve(this.trigger!(form))
        .catch((e) => { this.state.error = String(e?.message ?? e); })
        .finally(() => { this.state.running = false; this.broadcast(); });
    });
  }

  stop() {
    for (const c of this.clients) c.end();
    this.clients.clear();
    this.server?.close();
  }

  private broadcast() {
    const data = `data: ${JSON.stringify(this.state)}\n\n`;
    for (const c of this.clients) c.write(data);
  }

  setGoal(goal: string) {
    this.state.goal = goal;
    this.broadcast();
  }

  // Mark a stage active; everything before it becomes done.
  stage(id: string, status: 'active' | 'done' = 'active') {
    const idx = this.state.stages.findIndex((s) => s.id === id);
    this.state.stages.forEach((s, i) => {
      if (i < idx) s.status = 'done';
      else if (i === idx) s.status = status;
    });
    this.broadcast();
  }

  arm(id: string, patch: Partial<ArmView>) {
    const existing = this.state.arms[id];
    if (!existing) {
      this.state.arms[id] = { id, title: id, status: 'proposed', sessions: [], ...patch };
      this.state.armOrder.push(id);
    } else {
      this.state.arms[id] = { ...existing, ...patch };
    }
    this.broadcast();
  }

  session(armId: string, persona: string, patch: Partial<SessionView>) {
    const arm = this.state.arms[armId];
    if (!arm) return;
    const s = arm.sessions.find((x) => x.persona === persona);
    if (s) Object.assign(s, patch);
    else arm.sessions.push({ persona, status: 'shopping', ...patch });
    this.broadcast();
  }

  setSummary(summary: string) {
    this.state.summary = summary;
    this.broadcast();
  }

  setWinner(id: string) {
    this.state.winner = id;
    for (const a of Object.values(this.state.arms)) a.winner = a.id === id;
    this.broadcast();
  }

  finish() {
    this.state.done = true;
    this.state.stages.forEach((s) => (s.status = 'done'));
    this.broadcast();
  }

  // Clear everything for a new run, keeping the trigger/running flags intact.
  reset() {
    const { running, canTrigger } = this.state;
    this.state = { ...freshState(), running, canTrigger };
    this.broadcast();
  }

  error(message: string) {
    this.state.error = message;
    this.broadcast();
  }
}

export const dash = new Dashboard();

const PAGE = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>sbx A/B agent — live</title>
<style>
  :root {
    --bg:#0a0e1a; --panel:#121a2e; --panel2:#0f1526; --border:#223052;
    --text:#e6edf7; --dim:#8aa0c6; --cyan:#35d0e0; --blue:#4f8bff; --green:#36d399;
    --amber:#f5b945; --red:#f06d6d; --glow:rgba(79,139,255,.45);
  }
  * { box-sizing:border-box; }
  body {
    margin:0; background:radial-gradient(1200px 600px at 50% -10%, #142041 0%, var(--bg) 60%);
    color:var(--text); font-family:"SF Mono",ui-monospace,Menlo,Consolas,monospace;
    min-height:100vh; padding:28px 22px 60px;
  }
  h1 { text-align:center; margin:4px 0 2px; font-size:26px; letter-spacing:1px; }
  h1 .arrow { color:var(--cyan); }
  .sub { text-align:center; color:var(--dim); margin:0 auto 22px; max-width:780px; font-size:13px; line-height:1.5; }
  .section { max-width:1200px; margin:0 auto 20px; border:1px solid var(--border); border-radius:14px;
    background:linear-gradient(180deg, rgba(255,255,255,.015), transparent); padding:16px 18px; }
  .tag { display:inline-block; background:var(--blue); color:#02112e; font-weight:700; font-size:12px;
    padding:4px 11px; border-radius:7px; margin-bottom:14px; }
  .pipeline { display:flex; align-items:stretch; gap:6px; flex-wrap:wrap; }
  .stage { flex:1 1 150px; min-width:140px; border:1px solid var(--border); border-radius:11px; padding:12px 10px;
    background:var(--panel2); text-align:center; position:relative; transition:all .3s; }
  .stage .lbl { font-size:12.5px; font-weight:600; }
  .stage .st { font-size:10.5px; color:var(--dim); margin-top:5px; text-transform:uppercase; letter-spacing:.5px; }
  .stage.active { border-color:var(--blue); box-shadow:0 0 0 1px var(--blue), 0 0 22px var(--glow);
    background:linear-gradient(180deg, rgba(79,139,255,.14), var(--panel2)); }
  .stage.active .st { color:var(--blue); }
  .stage.active::after { content:""; position:absolute; top:9px; right:10px; width:7px; height:7px; border-radius:50%;
    background:var(--blue); box-shadow:0 0 10px var(--blue); animation:pulse 1.1s infinite; }
  .stage.done { border-color:rgba(54,211,153,.4); }
  .stage.done .st { color:var(--green); }
  .stage.done .st::before { content:"✓ "; }
  @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.35} }
  .arms { display:grid; grid-template-columns:repeat(auto-fit,minmax(300px,1fr)); gap:14px; }
  .arm { border:1px solid var(--border); border-radius:13px; background:var(--panel); padding:15px 16px; transition:all .3s; }
  .arm.winner { border-color:var(--green); box-shadow:0 0 0 1px var(--green), 0 0 26px rgba(54,211,153,.3); }
  .arm.failed { opacity:.6; border-color:rgba(240,109,109,.5); }
  .arm .top { display:flex; justify-content:space-between; align-items:center; gap:8px; }
  .arm .id { font-size:17px; font-weight:800; }
  .arm .id .crown { color:var(--green); }
  .arm .title { color:var(--dim); font-size:13px; margin:3px 0 0; }
  .badge { font-size:10.5px; font-weight:700; padding:3px 9px; border-radius:20px; text-transform:uppercase; letter-spacing:.5px; white-space:nowrap; }
  .badge.proposed{background:#223052;color:var(--dim)} .badge.deploying,.badge.building{background:rgba(245,185,69,.18);color:var(--amber)}
  .badge.live,.badge.built{background:rgba(79,139,255,.18);color:var(--blue)} .badge.shopping{background:rgba(53,208,224,.18);color:var(--cyan)}
  .badge.scored{background:rgba(54,211,153,.18);color:var(--green)} .badge.failed{background:rgba(240,109,109,.2);color:var(--red)}
  .spin::before{content:"⟳ ";display:inline-block;animation:spin 1s linear infinite}
  @keyframes spin{to{transform:rotate(360deg)}}
  .url { display:inline-block; margin-top:10px; font-size:12px; color:var(--cyan); text-decoration:none; word-break:break-all; }
  .url:hover { text-decoration:underline; }
  .note { font-size:11.5px; color:var(--dim); margin-top:9px; line-height:1.45; border-left:2px solid var(--border); padding-left:9px; }
  .metrics { display:flex; gap:16px; margin-top:11px; }
  .metric { font-size:11px; color:var(--dim); } .metric b { display:block; font-size:18px; color:var(--text); font-weight:800; }
  .metric .lift.up { color:var(--green); } .metric .lift.down { color:var(--red); }
  .sessions { margin-top:11px; display:flex; flex-direction:column; gap:6px; }
  .ses { display:flex; align-items:center; gap:8px; font-size:11.5px; background:var(--panel2); border:1px solid var(--border); border-radius:8px; padding:6px 9px; }
  .ses .dot { width:7px; height:7px; border-radius:50%; flex:none; }
  .ses .pname { flex:1; color:var(--dim); } .ses .sc { font-weight:800; } .ses .q { color:var(--dim); font-style:italic; }
  .foot { text-align:center; color:var(--dim); font-size:11px; margin-top:26px; }
  .goal { background:var(--panel2); border:1px solid var(--border); border-radius:9px; padding:10px 13px; color:var(--dim); font-size:12.5px; line-height:1.5; }
  .form { display:grid; grid-template-columns:1fr 1fr; gap:12px; }
  .form .full { grid-column:1 / -1; }
  .form label { display:block; font-size:11px; color:var(--dim); margin-bottom:5px; text-transform:uppercase; letter-spacing:.5px; }
  .form input, .form textarea { width:100%; background:var(--panel2); border:1px solid var(--border); border-radius:8px;
    color:var(--text); font-family:inherit; font-size:13px; padding:9px 11px; }
  .form input:focus, .form textarea:focus { outline:none; border-color:var(--blue); box-shadow:0 0 0 1px var(--blue); }
  .form textarea { resize:vertical; min-height:46px; }
  .form .row3 { display:grid; grid-template-columns:1fr 110px 110px; gap:12px; }
  .runbtn { background:var(--blue); color:#02112e; font-weight:800; font-family:inherit; font-size:14px; border:none;
    border-radius:9px; padding:11px 20px; cursor:pointer; letter-spacing:.5px; }
  .runbtn:disabled { opacity:.5; cursor:not-allowed; }
  .runbtn.running::before { content:"⟳ "; display:inline-block; animation:spin 1s linear infinite; }
  .hint { font-size:11px; color:var(--dim); margin-top:2px; }
  .err { background:rgba(240,109,109,.14); border:1px solid rgba(240,109,109,.5); color:var(--red);
    border-radius:9px; padding:10px 13px; font-size:12.5px; margin-top:12px; display:none; }
</style>
</head>
<body>
  <h1>sbx A/B agent <span class="arrow">▸</span> live</h1>
  <p class="sub">Simulated shoppers find the friction, Codex builds fixes in parallel sandboxes, the same shoppers re-test, the winner comes back ready for a PR.</p>

  <div class="section" id="trigger-section" style="display:none"><span class="tag">NEW RUN</span>
    <div class="form">
      <div class="full">
        <label>GitHub repo URL <span style="text-transform:none">(optional — blank uses the bundled shop)</span></label>
        <input id="f-repo" placeholder="https://github.com/you/your-shop" />
        <div class="hint">The app should serve on $PORT (3000). Use subdir if it lives in a subfolder (e.g. app).</div>
      </div>
      <div><label>Branch (optional)</label><input id="f-branch" placeholder="main" /></div>
      <div><label>Subdir (optional)</label><input id="f-subdir" placeholder="app" /></div>
      <div class="full"><label>Goal / prompt</label><textarea id="f-goal" placeholder="What should shoppers be able to do more easily?"></textarea></div>
      <div class="full">
        <div class="row3">
          <div style="align-self:end"><button class="runbtn" id="f-run">Run A/B test</button></div>
          <div><label>Variants</label><input id="f-variants" type="number" min="1" max="4" value="2" /></div>
          <div><label>Personas</label><input id="f-personas" type="number" min="1" max="3" value="3" /></div>
        </div>
      </div>
    </div>
    <div class="err" id="err"></div>
  </div>

  <div class="section"><span class="tag">GOAL</span><div class="goal" id="goal">waiting for run…</div></div>
  <div class="section"><span class="tag">PIPELINE</span><div class="pipeline" id="pipeline"></div></div>
  <div class="section"><span class="tag">ARMS</span><div id="summary" class="goal" style="margin-bottom:14px;display:none"></div><div class="arms" id="arms"></div></div>
  <div class="foot" id="foot">connecting…</div>

<script>
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const dotColor = (st) => st==='done' ? 'var(--green)' : st==='failed' ? 'var(--red)' : 'var(--cyan)';
const spinning = new Set(['deploying','building','shopping']);

function render(s) {
  $('goal').textContent = s.goal || 'waiting for run…';

  $('pipeline').innerHTML = s.stages.map((st) =>
    '<div class="stage ' + st.status + '"><div class="lbl">' + esc(st.label) + '</div><div class="st">' + st.status + '</div></div>'
  ).join('');

  if (s.summary) { $('summary').style.display='block'; $('summary').textContent = s.summary; }

  $('arms').innerHTML = s.armOrder.map((id) => {
    const a = s.arms[id];
    const badge = '<span class="badge ' + a.status + (spinning.has(a.status)?' spin':'') + '">' + a.status + '</span>';
    const crown = a.winner ? ' <span class="crown">★</span>' : '';
    const url = a.url ? '<a class="url" href="' + esc(a.url) + '" target="_blank">' + esc(a.url) + '</a>' : '';
    const hyp = a.hypothesis && !a.buildNote ? '<div class="note">' + esc(a.hypothesis) + '</div>' : '';
    const note = a.buildNote ? '<div class="note">' + esc(a.buildNote) + '</div>' : '';
    const lift = a.lift ? '<div class="metric">lift<b class="lift ' + (a.lift.startsWith('-')?'down':'up') + '">' + esc(a.lift) + '</b></div>' : '';
    const metrics = (a.avgScore!=null) ? '<div class="metrics">' +
      '<div class="metric">ease<b>' + a.avgScore.toFixed(1) + '</b></div>' +
      '<div class="metric">done<b>' + Math.round((a.completion||0)*100) + '%</b></div>' +
      '<div class="metric">steps<b>' + (a.avgSteps!=null?a.avgSteps.toFixed(1):'–') + '</b></div>' + lift + '</div>' : '';
    const sessions = a.sessions.length ? '<div class="sessions">' + a.sessions.map((x) => {
      const score = x.score!=null ? '<span class="sc">' + x.score + '/10</span>' : (x.status==='shopping'?'<span class="sc spin"></span>':'');
      const q = x.quote ? '<span class="q">“' + esc(x.quote.slice(0,60)) + (x.quote.length>60?'…':'') + '”</span>' : '';
      return '<div class="ses"><span class="dot" style="background:' + dotColor(x.status) + '"></span><span class="pname">' + esc(x.persona) + '</span>' + score + ' ' + q + '</div>';
    }).join('') + '</div>' : '';
    return '<div class="arm ' + (a.winner?'winner ':'') + (a.status==='failed'?'failed':'') + '"><div class="top"><div><span class="id">' + esc(a.id) + crown + '</span><div class="title">' + esc(a.title) + '</div></div>' + badge + '</div>' + url + hyp + note + metrics + sessions + '</div>';
  }).join('');

  // Trigger form (serve mode only)
  $('trigger-section').style.display = s.canTrigger ? '' : 'none';
  if (s.canTrigger) {
    const btn = $('f-run');
    btn.disabled = !!s.running;
    btn.classList.toggle('running', !!s.running);
    btn.textContent = s.running ? 'Running…' : 'Run A/B test';
    ['f-repo','f-branch','f-subdir','f-goal','f-variants','f-personas'].forEach((id) => { $(id).disabled = !!s.running; });
  }
  const err = $('err');
  if (s.error) { err.style.display = 'block'; err.textContent = 'Error: ' + s.error; } else { err.style.display = 'none'; }

  const running = s.running;
  $('foot').textContent = running ? 'running — updating live…'
    : s.done ? (s.winner ? 'Done — winner: ' + s.winner : 'Done')
    : s.canTrigger ? 'idle — submit a repo + goal above to start a run'
    : 'live — updating as the run progresses';
}

async function submitRun() {
  const body = {
    repo: $('f-repo').value, branch: $('f-branch').value, subdir: $('f-subdir').value,
    goal: $('f-goal').value, variants: $('f-variants').value, personas: $('f-personas').value,
  };
  $('f-run').disabled = true;
  try {
    const r = await fetch('/run', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(body) });
    if (!r.ok) { const j = await r.json().catch(()=>({})); $('err').style.display='block'; $('err').textContent = 'Error: ' + (j.error || r.status); $('f-run').disabled = false; }
  } catch (e) { $('err').style.display='block'; $('err').textContent = 'Error: ' + e.message; $('f-run').disabled = false; }
}

function connect() {
  const es = new EventSource('/events');
  es.onmessage = (e) => render(JSON.parse(e.data));
  es.onerror = () => { $('foot').textContent = 'disconnected — the run process has exited'; };
}
document.getElementById('f-run').addEventListener('click', submitRun);
connect();
</script>
</body>
</html>`;
