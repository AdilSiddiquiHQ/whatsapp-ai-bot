import { api, escHtml, toast } from '../api.js';
import { icon } from '../icons.js';
import { renderTrafficChart, renderHourlyChart } from '../charts.js';

export function renderOverviewView(container, ctx) {
  let days = 7;

  async function load() {
    container.innerHTML = `<div class="card"><span class="card-sub">Loading workspace telemetry...</span></div>`;
    try {
      const data = await api(`/api/dashboard?days=${days}`);
      paint(data);
    } catch (err) {
      container.innerHTML = `<div class="card">${escHtml(err.message)}</div>`;
    }
  }

  function paint(data) {
    const { kpis, quota, series, hourlyTotals, wa } = data;
    const quotaPct = Math.min(100, Math.round(((quota.usedToday || 0) / Math.max(1, quota.maxDailyOut || 90)) * 100));
    const waLive = wa.status === 'open';

    container.innerHTML = `
      <div class="kpi-grid">
        <div class="kpi-card">
          <div class="kpi-label"><span>Messages (${days}d)</span>${icon('inbox', 'icon-sm')}</div>
          <div class="kpi-value tabular">${kpis.totalIn + kpis.totalAiOut + kpis.totalHumanOut}</div>
          <div class="kpi-foot tabular">${kpis.totalIn} inbound &middot; ${kpis.totalAiOut} AI &middot; ${kpis.totalHumanOut} manual</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label"><span>AI Resolution Rate</span>${icon('spark', 'icon-sm')}</div>
          <div class="kpi-value tabular">${kpis.resolutionRate}%</div>
          <div class="kpi-foot">${kpis.activeChats} threads &middot; ${kpis.pausedChats} paused right now</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label"><span>Avg Reply Latency</span>${icon('terminal', 'icon-sm')}</div>
          <div class="kpi-value tabular">${kpis.avgLatencyMs ? `${kpis.avgLatencyMs}ms` : '—'}</div>
          <div class="kpi-foot">2026 Gemini Flash + OpenRouter</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label"><span>Leads Captured</span>${icon('leads', 'icon-sm')}</div>
          <div class="kpi-value tabular">${kpis.totalLeads}</div>
          <div class="kpi-foot">Extracted automatically from chats</div>
        </div>
      </div>

      <div class="two-col">
        <div class="card">
          <div class="card-header">
            <div>
              <div class="card-title">Message Volume &amp; AI Automation</div>
              <div class="card-sub">Green solid = AI replies &middot; Dashed = customer inbound</div>
            </div>
            <div class="row-gap">
              <button class="chip ${days === 7 ? 'active' : ''}" data-days="7">7D</button>
              <button class="chip ${days === 14 ? 'active' : ''}" data-days="14">14D</button>
              <button class="chip ${days === 30 ? 'active' : ''}" data-days="30">30D</button>
            </div>
          </div>
          <div id="ov-traffic-chart"></div>
        </div>

        <div class="card" style="display:flex;flex-direction:column;justify-content:space-between;">
          <div>
            <div class="card-header">
              <div>
                <div class="card-title">WhatsApp Health &amp; Safety</div>
                <div class="card-sub">Live link &amp; daily warmup protection</div>
              </div>
              <span class="pill ${waLive ? 'pill-emerald' : 'pill-amber'}">
                <span class="dot ${waLive ? 'dot-emerald' : 'dot-amber'}"></span>
                ${waLive ? 'Connected' : escHtml(wa.status)}
              </span>
            </div>

            <div style="padding:12px;background:var(--bg-inset);border:1px solid var(--border-hairline);border-radius:10px;margin-bottom:14px;">
              <div class="row-between" style="margin-bottom:6px;">
                <span class="card-sub">Linked Number</span>
                <span class="mono" style="font-weight:500;">${escHtml(wa.waPhone || 'Not linked yet')}</span>
              </div>
              <div class="row-between" style="margin-bottom:6px;">
                <span class="card-sub">Auto-Pilot AI</span>
                <span class="pill ${wa.aiEnabled ? 'pill-emerald' : 'pill-rose'}">${wa.aiEnabled ? 'Active' : 'Paused'}</span>
              </div>
              <div class="row-between">
                <span class="card-sub">Warmup Tier</span>
                <span class="mono" style="text-transform:uppercase;font-size:11px;">${escHtml(quota.warmupTier)}</span>
              </div>
            </div>

            <div style="margin-bottom:14px;">
              <div class="row-between" style="margin-bottom:6px;">
                <span class="card-sub">Daily AI Reply Quota</span>
                <span class="tabular" style="font-size:12px;font-weight:500;">${quota.usedToday} / ${quota.maxDailyOut}</span>
              </div>
              <div style="height:7px;background:var(--bg-inset);border-radius:999px;overflow:hidden;border:1px solid var(--border-hairline);">
                <div style="height:100%;width:${quotaPct}%;background:var(--emerald);transition:width 240ms ease;"></div>
              </div>
            </div>
          </div>

          <div class="row-gap" style="flex-wrap:wrap;">
            <button id="ov-go-inbox" class="btn-3d btn-3d-primary btn-sm" style="flex:1;">${icon('inbox', 'icon-sm')}<span>Open Inbox &amp; Preview</span></button>
            <button id="ov-go-brain" class="btn-3d btn-3d-secondary btn-sm" style="flex:1;">${icon('brain', 'icon-sm')}<span>Edit Prices &amp; FAQ</span></button>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-header">
          <div>
            <div class="card-title">24-Hour Customer Inquiry Density</div>
            <div class="card-sub">Shows exact hours your customers message most (hover bars for counts)</div>
          </div>
        </div>
        <div id="ov-hourly-chart"></div>
      </div>
    `;

    renderTrafficChart(container.querySelector('#ov-traffic-chart'), series);
    renderHourlyChart(container.querySelector('#ov-hourly-chart'), hourlyTotals);

    container.querySelectorAll('[data-days]').forEach((b) => {
      b.addEventListener('click', () => {
        days = Number(b.dataset.days);
        load();
      });
    });
    container.querySelector('#ov-go-inbox')?.addEventListener('click', () => ctx.navigate('inbox'));
    container.querySelector('#ov-go-brain')?.addEventListener('click', () => ctx.navigate('brain'));
  }

  load();
  return null;
}
