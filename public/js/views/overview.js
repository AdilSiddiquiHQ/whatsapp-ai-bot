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

  function formatMoney(amt, currency = 'INR') {
    const sym = currency === 'USD' ? '$' : currency === 'EUR' ? '€' : '₹';
    return `${sym}${Number(amt || 0).toLocaleString('en-IN')}`;
  }

  function paint(data) {
    const { kpis, quota, series, hourlyTotals, wa } = data;
    const quotaPct = Math.min(100, Math.round(((quota.usedToday || 0) / Math.max(1, quota.maxDailyOut || 90)) * 100));
    const waLive = wa.status === 'open';
    if (ctx.user) {
      ctx.user.unseenHumanNeeded = kpis.unseenHumanNeeded || 0;
      ctx.syncStatusUi?.();
    }

    container.innerHTML = `
      ${kpis.unseenHumanNeeded > 0 ? `
        <div class="card" style="margin-bottom:14px;border-color:var(--amber-border);background:var(--amber-tint);padding:12px 16px;">
          <div class="row-between">
            <div>
              <div style="font-weight:600;color:var(--amber);font-size:13px;">${kpis.unseenHumanNeeded} Chat${kpis.unseenHumanNeeded === 1 ? '' : 's'} Left Unseen on WhatsApp for Your Reply</div>
              <div class="card-sub">Unknown / off-topic questions where AI stayed silent so they stay unread on your phone too.</div>
            </div>
            <button id="ov-open-unseen" class="btn-3d btn-3d-secondary btn-sm">Review Waiting Chats</button>
          </div>
        </div>
      ` : ''}

      <div class="kpi-grid">
        <div class="kpi-card">
          <div class="kpi-label"><span>Won Revenue</span>${icon('spark', 'icon-sm')}</div>
          <div class="kpi-value tabular" style="color:var(--emerald);">${formatMoney(kpis.wonRevenue, kpis.currency)}</div>
          <div class="kpi-foot tabular">${kpis.wonCount || 0} deals won &middot; ${formatMoney(kpis.pipelineValue, kpis.currency)} active pipeline</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label"><span>Leads &amp; Visits Booked</span>${icon('leads', 'icon-sm')}</div>
          <div class="kpi-value tabular">${kpis.totalLeads} <span style="font-size:14px;color:var(--ink-muted);font-weight:400;">(${kpis.bookedCount || 0} booked)</span></div>
          <div class="kpi-foot tabular">${kpis.hotLeadsCount || 0} hot high-intent inquiries</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label"><span>Messages (${days}d)</span>${icon('inbox', 'icon-sm')}</div>
          <div class="kpi-value tabular">${kpis.totalIn + kpis.totalAiOut + kpis.totalHumanOut}</div>
          <div class="kpi-foot tabular">${kpis.totalIn} in &middot; ${kpis.totalAiOut} AI &middot; ${kpis.totalHumanOut} manual</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label"><span>AI Resolution &amp; Speed</span>${icon('terminal', 'icon-sm')}</div>
          <div class="kpi-value tabular">${kpis.resolutionRate}%</div>
          <div class="kpi-foot tabular">${kpis.avgLatencyMs ? `${kpis.avgLatencyMs}ms avg` : 'Ready'} &middot; ${kpis.pausedChats} paused</div>
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
    container.querySelector('#ov-open-unseen')?.addEventListener('click', () => ctx.navigate('inbox', { filter: 'human_needed' }));
  }

  load();
  return null;
}
