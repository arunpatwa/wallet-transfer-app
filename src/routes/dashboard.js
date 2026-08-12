/**
 * A single self-contained page at GET / for reading the service's own telemetry.
 *
 * Deliberately has no build step, no framework and no external requests: it is
 * one string of HTML that polls /metrics, /logs and /invariants. That keeps the
 * observability story inspectable -- nothing here can drift from what the
 * service actually reports, because it reads the same endpoints a reviewer does.
 */
import { Router } from 'express';

export const dashboardRouter = Router();

const PAGE = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Wallet service</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #ffffff; --fg: #16181d; --muted: #6b7280; --line: #e5e7eb;
    --card: #f9fafb; --ok: #047857; --warn: #b45309; --bad: #b91c1c;
    --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0d1117; --fg: #e6edf3; --muted: #8b949e; --line: #21262d;
      --card: #161b22; --ok: #3fb950; --warn: #d29922; --bad: #f85149;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 2rem 1.25rem 4rem; background: var(--bg); color: var(--fg);
    font: 15px/1.55 system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
  }
  main { max-width: 1080px; margin: 0 auto; }
  h1 { font-size: 1.3rem; margin: 0 0 .25rem; }
  h2 { font-size: .8rem; text-transform: uppercase; letter-spacing: .06em;
       color: var(--muted); margin: 2rem 0 .75rem; font-weight: 600; }
  .sub { color: var(--muted); font-size: .875rem; margin: 0 0 .5rem; }
  .grid { display: grid; gap: .75rem; grid-template-columns: repeat(auto-fit, minmax(155px, 1fr)); }
  .tile { background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: .8rem .9rem; }
  .tile .k { font-size: .7rem; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); }
  .tile .v { font-family: var(--mono); font-size: 1.35rem; margin-top: .2rem; word-break: break-all; }
  .ok { color: var(--ok); } .warn { color: var(--warn); } .bad { color: var(--bad); }
  table { width: 100%; border-collapse: collapse; font-family: var(--mono); font-size: .78rem; }
  th, td { text-align: left; padding: .35rem .5rem; border-bottom: 1px solid var(--line); vertical-align: top; }
  th { color: var(--muted); font-weight: 600; position: sticky; top: 0; background: var(--bg); }
  .scroll { overflow-x: auto; border: 1px solid var(--line); border-radius: 8px; }
  .logs { max-height: 26rem; overflow-y: auto; }
  td.ev { white-space: nowrap; }
  td.id { color: var(--muted); white-space: nowrap; }
  .pill { display: inline-block; padding: .05rem .4rem; border-radius: 4px; background: var(--line); font-size: .72rem; }
  footer { margin-top: 2.5rem; color: var(--muted); font-size: .8rem; }
  a { color: inherit; }
  .filters { display: flex; gap: .4rem; flex-wrap: wrap; margin-bottom: .6rem; }
  button {
    font: inherit; font-size: .78rem; padding: .2rem .6rem; cursor: pointer;
    background: var(--card); color: var(--fg); border: 1px solid var(--line); border-radius: 999px;
  }
  button[aria-pressed="true"] { border-color: var(--muted); font-weight: 600; }
</style>
</head>
<body>
<main>
  <h1>Wallet / P2P transfer service</h1>
  <p class="sub">Live telemetry, read from this instance's own <code>/metrics</code>, <code>/logs</code> and <code>/invariants</code>. Refreshes every 3s.</p>

  <h2>Conservation</h2>
  <div class="grid" id="invariants"></div>

  <h2>Traffic</h2>
  <div class="grid" id="traffic"></div>

  <h2>Transfers</h2>
  <div class="grid" id="transfers"></div>

  <h2>Recent events</h2>
  <div class="filters" id="filters"></div>
  <div class="scroll logs">
    <table>
      <thead><tr><th>time</th><th>event</th><th>request id</th><th>detail</th></tr></thead>
      <tbody id="logs"></tbody>
    </table>
  </div>

  <footer>
    Raw: <a href="/metrics">/metrics</a> &middot; <a href="/logs">/logs</a> &middot;
    <a href="/invariants">/invariants</a> &middot; <a href="/healthz">/healthz</a> &middot;
    <a href="/readyz">/readyz</a>
    <br>Logs come from a bounded in-memory ring buffer, so they are per-instance and reset on restart; stdout is the durable copy.
  </footer>
</main>

<script>
const fmt = new Intl.NumberFormat('en-IN');
let filter = null;

function tile(key, value, cls) {
  return '<div class="tile"><div class="k">' + key + '</div><div class="v ' + (cls || '') + '">' + value + '</div></div>';
}

// Minimal Prometheus text-format reader: enough to pull the samples this page
// shows, without pretending to be a full parser.
function parseMetrics(text) {
  const out = {};
  for (const line of text.split('\\n')) {
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^([a-zA-Z_:][a-zA-Z0-9_:]*)(\\{[^}]*\\})?\\s+(.+)$/);
    if (!match) continue;
    const [, name, labels, raw] = match;
    const value = Number(raw);
    if (!Number.isFinite(value)) continue;
    (out[name] ??= []).push({ labels: labels || '', value });
  }
  return out;
}

const sum = (m, name) => (m[name] ?? []).reduce((a, s) => a + s.value, 0);
const label = (s, key) => (s.labels.match(new RegExp(key + '="([^"]*)"')) || [])[1];

function quantile(m, q) {
  const s = (m.http_request_duration_summary_seconds ?? []).filter((x) => label(x, 'quantile') === q);
  if (!s.length) return null;
  const worst = Math.max(...s.map((x) => x.value).filter(Number.isFinite));
  return Number.isFinite(worst) ? worst : null;
}

async function refresh() {
  try {
    const [metricsText, logsJson, inv] = await Promise.all([
      fetch('/metrics').then((r) => r.text()),
      fetch('/logs?limit=300').then((r) => r.json()),
      fetch('/invariants').then((r) => r.json()),
    ]);
    const m = parseMetrics(metricsText);

    document.getElementById('invariants').innerHTML =
      tile('total money (paise)', fmt.format(inv.total_balance_paise)) +
      tile('ledger sum', fmt.format(inv.ledger_sum_paise), inv.ledger_balanced ? 'ok' : 'bad') +
      tile('balanced', inv.ledger_balanced ? 'yes' : 'NO', inv.ledger_balanced ? 'ok' : 'bad') +
      tile('wallets', fmt.format(inv.wallet_count)) +
      tile('ledger rows', fmt.format(inv.ledger_entry_count));

    const total = sum(m, 'http_requests_total');
    const errors = (m.http_requests_total ?? [])
      .filter((s) => Number(label(s, 'status')) >= 500)
      .reduce((a, s) => a + s.value, 0);
    const p99 = quantile(m, '0.99');
    const p50 = quantile(m, '0.5');
    const rate = total ? (errors / total) * 100 : 0;

    document.getElementById('traffic').innerHTML =
      tile('requests', fmt.format(total)) +
      tile('5xx', fmt.format(errors), errors ? 'bad' : 'ok') +
      tile('error rate', rate.toFixed(2) + '%', rate > 0 ? 'warn' : 'ok') +
      tile('p50', p50 === null ? '--' : Math.round(p50 * 1000) + ' ms') +
      tile('p99', p99 === null ? '--' : Math.round(p99 * 1000) + ' ms') +
      tile('datastore', sum(m, 'datastore_up') >= 1 ? 'up' : 'down',
           sum(m, 'datastore_up') >= 1 ? 'ok' : 'bad');

    const rejected = m.transfers_rejected_total ?? [];
    document.getElementById('transfers').innerHTML =
      tile('applied', fmt.format(sum(m, 'transfers_applied_total')), 'ok') +
      tile('rejected', fmt.format(rejected.reduce((a, s) => a + s.value, 0)), 'warn') +
      tile('idempotent replays', fmt.format(sum(m, 'idempotent_replays_total'))) +
      tile('races lost', fmt.format(sum(m, 'race_lost_total'))) +
      tile('wallets created', fmt.format(sum(m, 'wallets_created_total'))) +
      tile('auth failures', fmt.format(sum(m, 'auth_failures_total')));

    renderLogs(logsJson.logs ?? []);
  } catch (err) {
    document.getElementById('invariants').innerHTML = tile('error', String(err.message), 'bad');
  }
}

const INTERESTING = [
  'transfer.applied', 'transfer.rejected', 'transfer.idempotent_replay',
  'transfer.race_lost', 'wallet.getorcreate', 'auth.failed',
];

function renderLogs(logs) {
  const present = [...new Set(logs.map((l) => l.event))].filter(Boolean).sort();
  document.getElementById('filters').innerHTML =
    ['<button data-f="" aria-pressed="' + (filter === null) + '">all</button>']
      .concat(present.map((e) =>
        '<button data-f="' + e + '" aria-pressed="' + (filter === e) + '">' + e +
        (INTERESTING.includes(e) ? ' *' : '') + '</button>'))
      .join('');

  const rows = logs
    .filter((l) => !filter || l.event === filter)
    .slice(-200)
    .reverse()
    .map((l) => {
      const detail = Object.entries(l)
        .filter(([k]) => !['level', 'time', 'service', 'env', 'event', 'request_id', 'msg', 'method', 'route'].includes(k))
        .map(([k, v]) => k + '=' + (typeof v === 'object' ? JSON.stringify(v) : v))
        .join(' ');
      const cls = l.level === 'error' ? 'bad' : l.level === 'warn' ? 'warn' : '';
      return '<tr><td class="id">' + (l.time ?? '').slice(11, 23) +
        '</td><td class="ev ' + cls + '"><span class="pill">' + (l.event ?? l.level) +
        '</span></td><td class="id">' + (l.request_id ?? '').slice(0, 8) +
        '</td><td>' + escapeHtml(detail) + '</td></tr>';
    })
    .join('');
  document.getElementById('logs').innerHTML = rows || '<tr><td colspan="4">no events yet</td></tr>';
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

document.addEventListener('click', (e) => {
  const button = e.target.closest('button[data-f]');
  if (!button) return;
  filter = button.dataset.f || null;
  refresh();
});

refresh();
setInterval(refresh, 3000);
</script>
</body>
</html>`;

dashboardRouter.get('/', (_req, res) => {
  res.type('html').send(PAGE);
});
