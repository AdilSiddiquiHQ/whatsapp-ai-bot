import { api, escHtml, formatTimeMs, relativeTime, toast } from '../api.js';
import { icon } from '../icons.js';

export function renderLeadsView(container, ctx) {
  let leads = [];
  let currency = ctx.user?.currency || 'INR';
  let search = '';
  let viewMode = 'kanban'; // kanban | table
  let quickFilter = 'all'; // all | hot | visits
  let selectedLeadId = null;

  const STAGES = [
    { id: 'new', label: 'New Inquiry', pill: 'pill-sky' },
    { id: 'qualified', label: 'Qualified', pill: 'pill-amber' },
    { id: 'booked', label: 'Booked / Slot', pill: 'pill-emerald' },
    { id: 'won', label: 'Won Deals', pill: 'pill-emerald' },
    { id: 'lost', label: 'Lost', pill: 'pill-rose' }
  ];

  const sym = () => (currency === 'USD' ? '$' : currency === 'EUR' ? '€' : '₹');
  const fmtMoney = (n) => `${sym()}${Number(n || 0).toLocaleString('en-IN')}`;
  const digitsOnly = (s) => String(s || '').replace(/\D/g, '');

  async function init() {
    container.innerHTML = `<div class="card"><span class="card-sub">Loading captured leads CRM...</span></div>`;
    try {
      const res = await api('/api/leads');
      leads = res.leads || [];
      if (res.currency) currency = res.currency;
      paint();
    } catch (err) {
      toast(err.message, 'err');
    }
  }

  function paint() {
    const filtered = leads.filter((l) => {
      if (quickFilter === 'hot' && l.score !== 'hot') return false;
      if (quickFilter === 'visits' && l.stage !== 'booked' && !l.bookedSlot) return false;
      if (!search) return true;
      const q = search.toLowerCase();
      return (
        (l.name || '').toLowerCase().includes(q) ||
        (l.phone || '').toLowerCase().includes(q) ||
        (l.goal || l.intent || '').toLowerCase().includes(q) ||
        (l.planInterest || '').toLowerCase().includes(q)
      );
    });

    const pipelineVal = leads.filter((l) => !['won', 'lost'].includes(l.stage)).reduce((a, b) => a + (Number(b.dealValue) || 0), 0);
    const wonVal = leads.filter((l) => l.stage === 'won').reduce((a, b) => a + (Number(b.dealValue) || 0), 0);
    const bookedCnt = leads.filter((l) => l.stage === 'booked').length;
    const hotCnt = leads.filter((l) => l.score === 'hot' && l.stage !== 'lost').length;
    const activeDrawerLead = leads.find((l) => l._id === selectedLeadId) || null;

    container.innerHTML = `
      <div class="row-between" style="margin-bottom:14px;flex-wrap:wrap;gap:10px;">
        <div>
          <h2 style="font-size:18px;">Leads &amp; Revenue CRM</h2>
          <div class="card-sub">Multi-turn AI capture with slots, executive briefs, and deal attribution.</div>
        </div>
        <div class="row-gap" style="flex-wrap:wrap;">
          <input id="leads-q" class="input" style="width:190px;height:34px;" placeholder="Search name, phone, plan..." value="${escHtml(search)}" />
          <div class="row-gap">
            <button class="chip ${viewMode === 'kanban' ? 'active' : ''}" data-vmode="kanban">Kanban</button>
            <button class="chip ${viewMode === 'table' ? 'active' : ''}" data-vmode="table">Table</button>
          </div>
          <a href="/api/leads/export.csv" class="btn-3d btn-3d-primary btn-sm">${icon('download', 'icon-sm')}<span>Export CSV</span></a>
        </div>
      </div>

      <div class="crm-kpi-strip">
        <div class="crm-stat">
          <div class="crm-stat-label">Active Pipeline</div>
          <div class="crm-stat-val tabular">${fmtMoney(pipelineVal)}</div>
        </div>
        <div class="crm-stat">
          <div class="crm-stat-label">Closed Won Revenue</div>
          <div class="crm-stat-val tabular" style="color:var(--emerald);">${fmtMoney(wonVal)}</div>
        </div>
        <div class="crm-stat">
          <div class="crm-stat-label">Visits &amp; Bookings</div>
          <div class="crm-stat-val tabular">${bookedCnt}</div>
        </div>
        <div class="crm-stat">
          <div class="crm-stat-label">Hot High-Intent</div>
          <div class="crm-stat-val tabular" style="color:var(--rose);">${hotCnt}</div>
        </div>
      </div>

      <div class="row-gap" style="margin-bottom:12px;">
        <button class="chip ${quickFilter === 'all' ? 'active' : ''}" data-qf="all">All Leads (${leads.length})</button>
        <button class="chip ${quickFilter === 'hot' ? 'active' : ''}" data-qf="hot">Hot Only (${hotCnt})</button>
        <button class="chip ${quickFilter === 'visits' ? 'active' : ''}" data-qf="visits">Visits &amp; Booked Slots</button>
      </div>

      ${viewMode === 'kanban' ? `
        <div class="kanban-board">
          ${STAGES.map((st) => {
            const colItems = filtered.filter((l) => (l.stage || 'new') === st.id);
            const colSum = colItems.reduce((a, b) => a + (Number(b.dealValue) || 0), 0);
            return `
              <div class="kanban-col">
                <div class="kanban-col-head">
                  <span>${escHtml(st.label)} (${colItems.length})</span>
                  <span class="mono muted" style="font-size:11px;">${fmtMoney(colSum)}</span>
                </div>
                <div class="kanban-cards">
                  ${colItems.length === 0 ? `<div class="muted" style="font-size:11px;padding:12px 6px;text-align:center;">Empty stage</div>` : colItems.map((l) => `
                    <div class="kanban-card open-drawer" data-id="${escHtml(l._id)}">
                      <div class="row-between" style="margin-bottom:4px;">
                        <span style="font-weight:600;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escHtml(l.name)}</span>
                        <span class="pill ${l.score === 'hot' ? 'pill-rose' : l.score === 'warm' ? 'pill-amber' : 'pill-sky'}" style="font-size:9px;padding:1px 5px;text-transform:uppercase;">${escHtml(l.score || 'warm')}</span>
                      </div>
                      <div style="font-size:12px;color:var(--ink-secondary);margin-bottom:5px;line-height:1.35;">${escHtml(l.goal || l.intent || 'Inquiry')}</div>
                      ${l.bookedSlot ? `<div class="pill pill-emerald" style="font-size:10px;margin-bottom:5px;">Slot: ${escHtml(l.bookedSlot)}</div>` : ''}
                      <div class="row-between" style="font-size:11px;">
                        <span class="mono" style="color:var(--emerald);font-weight:500;">${l.dealValue ? fmtMoney(l.dealValue) : (l.budget ? escHtml(l.budget) : '—')}</span>
                        <span class="muted tabular">${relativeTime(l.updatedAt)}</span>
                      </div>
                    </div>
                  `).join('')}
                </div>
              </div>
            `;
          }).join('')}
        </div>
      ` : `
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Customer</th>
                <th>Goal &amp; Plan</th>
                <th>Value</th>
                <th>Slot</th>
                <th>Score</th>
                <th>Stage</th>
                <th>Updated</th>
                <th style="text-align:right;">Actions</th>
              </tr>
            </thead>
            <tbody>
              ${filtered.length === 0 ? `
                <tr><td colspan="8" style="text-align:center;padding:36px;color:var(--ink-muted);">No leads matching filter yet.</td></tr>
              ` : filtered.map((l) => `
                <tr>
                  <td>
                    <div style="font-weight:500;">${escHtml(l.name)}</div>
                    <div class="mono muted" style="font-size:11px;">${escHtml(l.phone)}</div>
                  </td>
                  <td>
                    <div>${escHtml(l.goal || l.intent || '—')}</div>
                    ${l.planInterest ? `<div class="card-sub" style="font-size:11px;">${escHtml(l.planInterest)}</div>` : ''}
                  </td>
                  <td class="mono">${l.dealValue ? fmtMoney(l.dealValue) : escHtml(l.budget || '—')}</td>
                  <td>${l.bookedSlot ? `<span class="pill pill-emerald" style="font-size:11px;">${escHtml(l.bookedSlot)}</span>` : '—'}</td>
                  <td>
                    <span class="pill ${l.score === 'hot' ? 'pill-rose' : l.score === 'warm' ? 'pill-amber' : 'pill-sky'}" style="text-transform:uppercase;font-size:10px;">
                      ${escHtml(l.score || 'warm')}
                    </span>
                  </td>
                  <td>
                    <select class="select lead-stage" data-id="${escHtml(l._id)}" style="height:30px;padding:4px 8px;font-size:12px;">
                      ${STAGES.map((st) => `<option value="${st.id}" ${l.stage === st.id ? 'selected' : ''}>${st.label}</option>`).join('')}
                    </select>
                  </td>
                  <td class="tabular muted">${relativeTime(l.updatedAt)}</td>
                  <td style="text-align:right;">
                    <div class="row-gap" style="justify-content:flex-end;">
                      <button class="btn-3d btn-3d-secondary btn-sm open-drawer" data-id="${escHtml(l._id)}">Details</button>
                      <button class="btn-3d btn-3d-secondary btn-sm open-conv" data-cid="${escHtml(l.conversationId || '')}">Inbox</button>
                    </div>
                  </td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      `}

      ${activeDrawerLead ? `
        <div class="drawer-backdrop" id="lead-drawer-backdrop">
          <div class="drawer-panel">
            <div class="row-between" style="margin-bottom:14px;">
              <div>
                <h3 style="font-size:17px;">${escHtml(activeDrawerLead.name)}</h3>
                <div class="mono muted" style="font-size:12px;">${escHtml(activeDrawerLead.phone)}</div>
              </div>
              <button id="drawer-close" class="btn-3d btn-3d-secondary btn-sm">&times;</button>
            </div>

            <div class="row-gap" style="margin-bottom:14px;flex-wrap:wrap;">
              ${digitsOnly(activeDrawerLead.phone) ? `<a href="tel:+${digitsOnly(activeDrawerLead.phone)}" class="btn-3d btn-3d-secondary btn-sm">${icon('phone', 'icon-sm')}<span>Call</span></a>` : ''}
              ${digitsOnly(activeDrawerLead.phone) ? `<a href="https://wa.me/${digitsOnly(activeDrawerLead.phone)}" target="_blank" rel="noopener" class="btn-3d btn-3d-secondary btn-sm">WhatsApp Direct</a>` : ''}
              ${activeDrawerLead.conversationId ? `<button id="drawer-open-inbox" class="btn-3d btn-3d-primary btn-sm">${icon('inbox', 'icon-sm')}<span>Open Chat</span></button>` : ''}
            </div>

            ${(activeDrawerLead.whyHot || activeDrawerLead.nextStep) ? `
              <div style="padding:12px;background:var(--bg-inset);border:1px solid var(--border-hairline);border-radius:10px;margin-bottom:14px;">
                <div style="font-size:11px;font-weight:600;text-transform:uppercase;color:var(--emerald);margin-bottom:4px;">AI Executive Brief</div>
                ${activeDrawerLead.whyHot ? `<div style="font-size:12px;margin-bottom:4px;"><strong>Why Qualified:</strong> ${escHtml(activeDrawerLead.whyHot)}</div>` : ''}
                ${activeDrawerLead.nextStep ? `<div style="font-size:12px;"><strong>Suggested Next:</strong> ${escHtml(activeDrawerLead.nextStep)}</div>` : ''}
              </div>
            ` : ''}

            <form id="drawer-form">
              <div class="equal-col" style="gap:10px;">
                <div class="field">
                  <label>Pipeline Stage</label>
                  <select id="dr-stage" class="select">
                    ${STAGES.map((st) => `<option value="${st.id}" ${activeDrawerLead.stage === st.id ? 'selected' : ''}>${st.label}</option>`).join('')}
                  </select>
                </div>
                <div class="field">
                  <label>Lead Score</label>
                  <select id="dr-score" class="select">
                    ${['hot', 'warm', 'cold'].map((sc) => `<option value="${sc}" ${activeDrawerLead.score === sc ? 'selected' : ''}>${sc.toUpperCase()}</option>`).join('')}
                  </select>
                </div>
              </div>

              <div class="field"><label>Primary Need / Goal</label><input id="dr-goal" class="input" value="${escHtml(activeDrawerLead.goal || activeDrawerLead.intent || '')}" /></div>
              <div class="equal-col" style="gap:10px;">
                <div class="field"><label>Interested Plan</label><input id="dr-plan" class="input" value="${escHtml(activeDrawerLead.planInterest || '')}" /></div>
                <div class="field"><label>Deal Value (${sym()})</label><input id="dr-deal" type="number" min="0" class="input mono" value="${Number(activeDrawerLead.dealValue || 0)}" /></div>
              </div>
              <div class="field"><label>Booked Visit / Callback Slot</label><input id="dr-slot" class="input" placeholder="e.g. Tomorrow 6 PM" value="${escHtml(activeDrawerLead.bookedSlot || '')}" /></div>
              <div class="field"><label>Lost Reason (if lost)</label><input id="dr-lost" class="input" placeholder="e.g. Too expensive, joined elsewhere" value="${escHtml(activeDrawerLead.lostReason || '')}" /></div>
              <div class="field"><label>Team Notes</label><textarea id="dr-notes" class="textarea" rows="3">${escHtml(activeDrawerLead.notes || '')}</textarea></div>

              <div class="row-gap" style="margin-top:8px;">
                <button type="submit" class="btn-3d btn-3d-primary" style="flex:1;">Save Lead Details</button>
                ${activeDrawerLead.stage !== 'won' ? `<button type="button" id="dr-mark-won" class="btn-3d btn-3d-secondary">Mark Won (${sym()})</button>` : ''}
              </div>
            </form>
          </div>
        </div>
      ` : ''}
    `;

    container.querySelector('#leads-q').addEventListener('input', (e) => {
      search = e.target.value;
      paint();
    });
    container.querySelectorAll('[data-vmode]').forEach((b) => {
      b.addEventListener('click', () => { viewMode = b.dataset.vmode; paint(); });
    });
    container.querySelectorAll('[data-qf]').forEach((b) => {
      b.addEventListener('click', () => { quickFilter = b.dataset.qf; paint(); });
    });
    container.querySelectorAll('.open-drawer').forEach((el) => {
      el.addEventListener('click', () => { selectedLeadId = el.dataset.id; paint(); });
    });
    container.querySelector('#drawer-close')?.addEventListener('click', () => { selectedLeadId = null; paint(); });
    container.querySelector('#lead-drawer-backdrop')?.addEventListener('click', (e) => {
      if (e.target.id === 'lead-drawer-backdrop') { selectedLeadId = null; paint(); }
    });
    container.querySelector('#drawer-open-inbox')?.addEventListener('click', () => {
      if (activeDrawerLead?.conversationId) ctx.navigate('inbox', { convId: activeDrawerLead.conversationId });
    });

    container.querySelector('#drawer-form')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!activeDrawerLead) return;
      try {
        const res = await api(`/api/leads/${encodeURIComponent(activeDrawerLead._id)}`, {
          method: 'PATCH',
          body: {
            stage: container.querySelector('#dr-stage').value,
            score: container.querySelector('#dr-score').value,
            goal: container.querySelector('#dr-goal').value,
            planInterest: container.querySelector('#dr-plan').value,
            dealValue: Number(container.querySelector('#dr-deal').value || 0),
            bookedSlot: container.querySelector('#dr-slot').value,
            lostReason: container.querySelector('#dr-lost').value,
            notes: container.querySelector('#dr-notes').value
          }
        });
        const idx = leads.findIndex((x) => x._id === activeDrawerLead._id);
        if (idx >= 0 && res.lead) leads[idx] = res.lead;
        toast('Lead CRM updated.');
        selectedLeadId = null;
        paint();
      } catch (err) { toast(err.message, 'err'); }
    });

    container.querySelector('#dr-mark-won')?.addEventListener('click', async () => {
      if (!activeDrawerLead) return;
      const dv = Number(container.querySelector('#dr-deal').value || activeDrawerLead.dealValue || 0);
      try {
        const res = await api(`/api/leads/${encodeURIComponent(activeDrawerLead._id)}`, {
          method: 'PATCH',
          body: { stage: 'won', dealValue: dv }
        });
        const idx = leads.findIndex((x) => x._id === activeDrawerLead._id);
        if (idx >= 0 && res.lead) leads[idx] = res.lead;
        toast('Marked deal WON!');
        selectedLeadId = null;
        paint();
      } catch (err) { toast(err.message, 'err'); }
    });

    container.querySelectorAll('.lead-stage').forEach((sel) => {
      sel.addEventListener('change', async () => {
        try {
          const res = await api(`/api/leads/${encodeURIComponent(sel.dataset.id)}`, { method: 'PATCH', body: { stage: sel.value } });
          const idx = leads.findIndex((x) => x._id === sel.dataset.id);
          if (idx >= 0 && res.lead) leads[idx] = res.lead;
          toast('Lead stage updated.');
          paint();
        } catch (err) { toast(err.message, 'err'); }
      });
    });

    container.querySelectorAll('.open-conv').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (btn.dataset.cid) ctx.navigate('inbox', { convId: btn.dataset.cid });
      });
    });
  }

  init();
  return null;
}

export function renderLogsView(container) {
  let logs = [];
  let lvlFilter = 'all';
  let q = '';

  async function init() {
    container.innerHTML = `<div class="card"><span class="card-sub">Loading telemetry stream...</span></div>`;
    try {
      const res = await api('/api/logs');
      logs = res.logs || [];
      paint();
    } catch (err) {
      toast(err.message, 'err');
    }
  }

  function paint() {
    const filtered = logs.filter((l) => {
      if (lvlFilter !== 'all' && l.level !== lvlFilter) return false;
      if (q && !(l.msg || '').toLowerCase().includes(q.toLowerCase()) && !(l.mod || '').toLowerCase().includes(q.toLowerCase())) return false;
      return true;
    });

    container.innerHTML = `
      <div class="row-between" style="margin-bottom:14px;">
        <div class="row-gap">
          <h2 style="font-size:18px;">Live System Waterfall</h2>
          <span class="pill pill-emerald"><span class="dot dot-emerald"></span>Live SSE</span>
        </div>
        <div class="row-gap">
          <input id="log-search" class="input mono" style="width:210px;height:32px;" placeholder="Filter events..." value="${escHtml(q)}" />
          ${['all', 'info', 'warn', 'err'].map((lv) => `
            <button class="chip ${lvlFilter === lv ? 'active' : ''}" data-lv="${lv}">${lv.toUpperCase()}</button>
          `).join('')}
        </div>
      </div>

      <div class="log-terminal">
        ${filtered.length === 0 ? `<div style="padding:28px;text-align:center;" class="muted">No telemetry events matching filter.</div>` : filtered.map((l) => {
          const pillCls = l.level === 'err' ? 'pill-rose' : l.level === 'warn' ? 'pill-amber' : 'pill-emerald';
          return `
            <div class="log-row ${escHtml(l.level)}">
              <span class="tabular muted">${formatTimeMs(l.createdAt)}</span>
              <span><span class="pill ${pillCls}" style="font-size:10px;padding:1px 6px;">${escHtml((l.level || 'info').toUpperCase())}</span></span>
              <span class="muted">${escHtml((l.mod || 'sys').toUpperCase())}</span>
              <span>${escHtml(l.msg)}</span>
            </div>
          `;
        }).join('')}
      </div>
    `;

    container.querySelector('#log-search').addEventListener('input', (e) => {
      q = e.target.value;
      paint();
    });
    container.querySelectorAll('[data-lv]').forEach((b) => {
      b.addEventListener('click', () => {
        lvlFilter = b.dataset.lv;
        paint();
      });
    });
  }

  init();

  return (eventType, data) => {
    if (eventType === 'log') {
      logs.unshift(data);
      if (logs.length > 150) logs.pop();
      paint();
    }
  };
}

export function renderChannelsView(container, ctx) {
  let linkMode = 'qr';
  let pairingCode = ctx.user.pairingCode || '';

  function paint() {
    const u = ctx.user;
    const isLive = u.waStatus === 'open';

    container.innerHTML = `
      <h2 style="font-size:18px;margin-bottom:4px;">Channels &amp; Account</h2>
      <div class="card-sub" style="margin-bottom:16px;">Manage your WhatsApp link, upcoming channels &amp; security credentials.</div>

      <div class="equal-col" style="margin-bottom:14px;">
        <div class="card">
          <div class="card-header">
            <div>
              <div class="card-title">WhatsApp Cloud Socket</div>
              <div class="card-sub">Linked via Baileys Multi-Device &middot; Saved in MongoDB</div>
            </div>
            <span class="pill ${isLive ? 'pill-emerald' : u.waStatus === 'qr_ready' ? 'pill-amber' : ''}">
              <span class="dot ${isLive ? 'dot-emerald' : u.waStatus === 'qr_ready' ? 'dot-amber' : 'dot-muted'}"></span>
              ${isLive ? 'Connected' : escHtml(u.waStatus || 'offline')}
            </span>
          </div>

          ${isLive ? `
            <div style="padding:14px;background:var(--bg-inset);border:1px solid var(--emerald-border);border-radius:10px;margin-bottom:14px;">
              <div class="row-between" style="margin-bottom:6px;"><span class="card-sub">Linked Number</span><span class="mono">${escHtml(u.waPhone || 'Active')}</span></div>
              <div class="row-between"><span class="card-sub">Profile Name</span><span>${escHtml(u.waPushName || '—')}</span></div>
            </div>
            <div class="row-gap">
              <button id="ch-disconnect" class="btn-3d btn-3d-secondary btn-sm">Pause Socket</button>
              <button id="ch-logout" class="btn-3d btn-3d-danger btn-sm">Unlink WhatsApp</button>
            </div>
          ` : `
            <div class="row-gap" style="margin-bottom:12px;">
              <button id="ch-m-qr" class="chip ${linkMode === 'qr' ? 'active' : ''}">${icon('qr', 'icon-sm')} Scan QR Code</button>
              <button id="ch-m-pair" class="chip ${linkMode === 'pair' ? 'active' : ''}">${icon('phone', 'icon-sm')} 8-Digit Phone Code</button>
            </div>

            ${linkMode === 'qr' ? `
              <div style="text-align:center;padding:14px;background:var(--bg-inset);border-radius:10px;">
                ${u.qrDataUrl ? `<div class="qr-frame"><img src="${u.qrDataUrl}" alt="QR Code"/></div>` : `
                  <button id="ch-connect" class="btn-3d btn-3d-primary">${icon('qr', 'icon-sm')}<span>Generate WhatsApp QR</span></button>
                `}
              </div>
            ` : `
              <form id="ch-pair-form">
                <div class="field"><label>WhatsApp Number (with country code)</label><input id="ch-phone" class="input mono" placeholder="919876543210" required /></div>
                <button type="submit" class="btn-3d btn-3d-primary btn-full">Request 8-Digit Pairing Code</button>
                ${pairingCode ? `<div class="pairing-display">${escHtml(pairingCode)}</div>` : ''}
              </form>
            `}
          `}
        </div>

        <div class="card" style="display:flex;flex-direction:column;gap:12px;">
          <div class="card-title">Upcoming Channels (Phase 2)</div>
          <div style="padding:12px;background:var(--bg-inset);border:1px dashed var(--border-medium);border-radius:10px;">
            <div class="row-between"><span style="font-weight:500;">Instagram Direct Messages</span><span class="pill">Phase 2 Ready</span></div>
            <div class="card-sub" style="margin-top:4px;">Routes customer DMs with @username directly into this Inbox via dedicated IP / bridge.</div>
          </div>
          <div style="padding:12px;background:var(--bg-inset);border:1px dashed var(--border-medium);border-radius:10px;">
            <div class="row-between"><span style="font-weight:500;">Facebook Messenger</span><span class="pill">Phase 2 Ready</span></div>
            <div class="card-sub" style="margin-top:4px;">Unified Inbox syncs customer Page &amp; Messenger profiles cleanly when enabled.</div>
          </div>
        </div>
      </div>

      <div class="equal-col">
        <div class="card">
          <div class="card-title" style="margin-bottom:10px;">Interface Theme</div>
          <div class="row-between">
            <span class="card-sub">Switch between Obsidian Dark and Daylight Paper Lab</span>
            <button id="ch-theme" class="btn-3d btn-3d-secondary btn-sm">${icon('sun', 'icon-sm')}<span>Toggle Theme</span></button>
          </div>
        </div>

        <div class="card">
          <div class="card-title" style="margin-bottom:10px;">Change Login Password</div>
          <form id="ch-pw-form" class="row-gap">
            <input name="currentPassword" type="password" class="input" placeholder="Current password" required />
            <input name="newPassword" type="password" class="input" placeholder="New password" required minlength="5" />
            <button type="submit" class="btn-3d btn-3d-secondary btn-sm">Update</button>
          </form>
        </div>
      </div>
    `;

    container.querySelector('#ch-m-qr')?.addEventListener('click', () => { linkMode = 'qr'; paint(); });
    container.querySelector('#ch-m-pair')?.addEventListener('click', () => { linkMode = 'pair'; paint(); });
    container.querySelector('#ch-connect')?.addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      btn.textContent = 'Generating QR...';
      try {
        await api('/api/wa/connect', { method: 'POST' });
        toast('Initializing WhatsApp QR...');
      } catch (err) {
        toast(err.message, 'err');
        btn.disabled = false;
        paint();
      }
    });
    container.querySelector('#ch-disconnect')?.addEventListener('click', async () => {
      await api('/api/wa/disconnect', { method: 'POST' });
      toast('Socket disconnected (keys preserved).');
    });
    container.querySelector('#ch-logout')?.addEventListener('click', async () => {
      await api('/api/wa/logout', { method: 'POST' });
      toast('WhatsApp device unlinked.');
    });
    container.querySelector('#ch-pair-form')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        const res = await api('/api/wa/pairing-code', { method: 'POST', body: { phone: container.querySelector('#ch-phone').value } });
        pairingCode = res.code;
        toast('Pairing code ready.');
        paint();
      } catch (err) { toast(err.message, 'err'); }
    });
    container.querySelector('#ch-theme')?.addEventListener('click', () => ctx.toggleTheme());
    container.querySelector('#ch-pw-form')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      try {
        await api('/api/account/password', {
          method: 'POST',
          body: { currentPassword: fd.get('currentPassword'), newPassword: fd.get('newPassword') }
        });
        toast('Password updated.');
        e.target.reset();
      } catch (err) { toast(err.message, 'err'); }
    });
  }

  paint();

  return (eventType, data) => {
    if (eventType === 'wa_qr' || eventType === 'wa_status') {
      if (data.status) ctx.user.waStatus = data.status;
      if (data.qrDataUrl !== undefined) ctx.user.qrDataUrl = data.qrDataUrl;
      if (data.waPhone !== undefined) ctx.user.waPhone = data.waPhone;
      if (data.waPushName !== undefined) ctx.user.waPushName = data.waPushName;
      if (data.pairingCode !== undefined) pairingCode = data.pairingCode || pairingCode;
      paint();
    }
  };
}
