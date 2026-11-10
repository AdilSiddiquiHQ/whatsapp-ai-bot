import { api, escHtml, formatTimeMs, relativeTime, toast } from '../api.js';
import { icon } from '../icons.js';

export function renderLeadsView(container, ctx) {
  let leads = [];
  let search = '';

  async function init() {
    container.innerHTML = `<div class="card"><span class="card-sub">Loading captured leads...</span></div>`;
    try {
      const res = await api('/api/leads');
      leads = res.leads || [];
      paint();
    } catch (err) {
      toast(err.message, 'err');
    }
  }

  function paint() {
    const filtered = leads.filter((l) => {
      if (!search) return true;
      const q = search.toLowerCase();
      return (l.name || '').toLowerCase().includes(q) || (l.phone || '').toLowerCase().includes(q) || (l.intent || '').toLowerCase().includes(q);
    });

    container.innerHTML = `
      <div class="row-between" style="margin-bottom:16px;">
        <div>
          <h2 style="font-size:18px;">Captured Leads CRM</h2>
          <div class="card-sub">Automatically qualified from WhatsApp buyer inquiries &amp; pricing requests.</div>
        </div>
        <div class="row-gap">
          <input id="leads-q" class="input" style="width:220px;" placeholder="Filter leads..." value="${escHtml(search)}" />
          <a href="/api/leads/export.csv" class="btn-3d btn-3d-primary btn-sm">${icon('download', 'icon-sm')}<span>Export CSV</span></a>
        </div>
      </div>

      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Customer</th>
              <th>Phone</th>
              <th>Intent</th>
              <th>Budget</th>
              <th>Score</th>
              <th>Stage</th>
              <th>Updated</th>
              <th style="text-align:right;">Chat</th>
            </tr>
          </thead>
          <tbody>
            ${filtered.length === 0 ? `
              <tr><td colspan="8" style="text-align:center;padding:36px;color:var(--ink-muted);">No leads captured yet. High-intent WhatsApp chats automatically appear here.</td></tr>
            ` : filtered.map((l) => `
              <tr>
                <td style="font-weight:500;">${escHtml(l.name)}</td>
                <td class="mono">${escHtml(l.phone)}</td>
                <td>${escHtml(l.intent || '—')}</td>
                <td class="mono">${escHtml(l.budget || '—')}</td>
                <td>
                  <span class="pill ${l.score === 'hot' ? 'pill-rose' : l.score === 'warm' ? 'pill-amber' : 'pill-sky'}" style="text-transform:uppercase;font-size:10px;">
                    ${escHtml(l.score || 'warm')}
                  </span>
                </td>
                <td>
                  <select class="select lead-stage" data-id="${escHtml(l._id)}" style="height:30px;padding:4px 8px;font-size:12px;">
                    ${['new', 'contacted', 'converted', 'lost'].map((st) => `<option value="${st}" ${l.stage === st ? 'selected' : ''}>${st}</option>`).join('')}
                  </select>
                </td>
                <td class="tabular muted">${relativeTime(l.updatedAt)} ago</td>
                <td style="text-align:right;">
                  <button class="btn-3d btn-3d-secondary btn-sm open-conv" data-cid="${escHtml(l.conversationId || '')}">Open Inbox</button>
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `;

    container.querySelector('#leads-q').addEventListener('input', (e) => {
      search = e.target.value;
      paint();
    });

    container.querySelectorAll('.lead-stage').forEach((sel) => {
      sel.addEventListener('change', async () => {
        await api(`/api/leads/${encodeURIComponent(sel.dataset.id)}`, { method: 'PATCH', body: { stage: sel.value } });
        toast('Lead stage updated.');
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
