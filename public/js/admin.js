import { api, escHtml, relativeTime, toast } from './api.js';
import { icon } from './icons.js';

const root = document.getElementById('admin-root');
let state = { configured: true, authenticated: false, overview: null, modal: null };

async function boot() {
  try {
    const st = await api('/api/admin/status');
    state.configured = st.configured;
    state.authenticated = st.authenticated;
    if (state.authenticated) {
      state.overview = await api('/api/admin/overview');
    }
  } catch (err) {
    toast(err.message, 'err');
  }
  render();
}

async function refreshOverview() {
  state.overview = await api('/api/admin/overview');
  render();
}

function renderUnconfigured() {
  root.innerHTML = `
    <div class="auth-stage">
      <div class="auth-card" style="max-width:460px;">
        <div class="row-gap" style="margin-bottom:16px;">
          <div class="brand-mark">${icon('shield', 'icon-lg')}</div>
          <div>
            <h1 style="font-size:18px;">Agency Console Locked</h1>
            <div class="card-sub">Environment configuration required</div>
          </div>
        </div>
        <p style="color:var(--ink-secondary);font-size:13px;line-height:1.6;">
          The server environment variable <code class="mono" style="color:var(--emerald);">ADMIN_SECRET</code> is not configured yet.
          Add <code class="mono">ADMIN_SECRET</code> inside Render Dashboard &rarr; Environment and redeploy to unlock the Agency Console.
        </p>
      </div>
    </div>
  `;
}

function renderLogin() {
  root.innerHTML = `
    <div class="auth-stage">
      <form id="admin-login-form" class="auth-card">
        <div class="row-gap" style="margin-bottom:22px;">
          <div class="brand-mark">${icon('shield', 'icon-lg')}</div>
          <div>
            <h1 style="font-size:19px;">Agency Super-Admin</h1>
            <div class="card-sub">Server-verified ENV access</div>
          </div>
        </div>
        <div class="field">
          <label for="admin-secret">Admin Secret Key</label>
          <div class="input-wrap">
            <input id="admin-secret" class="input mono" type="password" autocomplete="current-password" placeholder="Enter your ADMIN_SECRET" required />
            <button type="button" id="toggle-eye" class="input-eye" title="Show/Hide">${icon('eye', 'icon-sm')}</button>
          </div>
        </div>
        <button type="submit" id="admin-login-btn" class="btn-3d btn-3d-primary btn-lg btn-full" style="margin-top:8px;">
          ${icon('key', 'icon-sm')}
          <span>Unlock Agency Console</span>
        </button>
      </form>
    </div>
  `;

  const inp = root.querySelector('#admin-secret');
  root.querySelector('#toggle-eye').addEventListener('click', () => {
    inp.type = inp.type === 'password' ? 'text' : 'password';
  });

  root.querySelector('#admin-login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = root.querySelector('#admin-login-btn');
    btn.disabled = true;
    try {
      await api('/api/admin/login', { method: 'POST', body: { secret: inp.value } });
      state.authenticated = true;
      await refreshOverview();
    } catch (err) {
      toast(err.message, 'err');
      btn.disabled = false;
    }
  });
}

function renderConsole() {
  const { system, tenants } = state.overview || { system: {}, tenants: [] };
  const db = system.dbStorage;
  const prov = system.providers || {};

  root.innerHTML = `
    <div style="min-height:100vh;display:flex;flex-direction:column;">
      <header class="topbar">
        <div class="row-gap">
          <div class="brand-mark" style="width:30px;height:30px;">${icon('shield', 'icon-sm')}</div>
          <div>
            <div class="display" style="font-size:15px;font-weight:600;">Agency Control Plane</div>
          </div>
          <span class="pill pill-emerald"><span class="dot dot-emerald"></span>ADMIN</span>
        </div>
        <div class="row-gap">
          <button id="refresh-btn" class="btn-3d btn-3d-secondary btn-sm">${icon('refresh', 'icon-sm')}<span>Refresh</span></button>
          <button id="new-client-btn" class="btn-3d btn-3d-primary btn-sm">${icon('plus', 'icon-sm')}<span>Create Client</span></button>
          <button id="admin-logout-btn" class="btn-3d btn-3d-secondary btn-sm">${icon('logout', 'icon-sm')}<span>Lock</span></button>
        </div>
      </header>

      <main class="page-body">
        <div class="kpi-grid">
          <div class="kpi-card">
            <div class="kpi-label"><span>Active Workspaces</span>${icon('leads', 'icon-sm')}</div>
            <div class="kpi-value tabular">${tenants.length}</div>
            <div class="kpi-foot">${tenants.filter((t) => t.status === 'active').length} active · ${tenants.filter((t) => t.waStatus === 'open').length} WhatsApp live</div>
          </div>
          <div class="kpi-card">
            <div class="kpi-label"><span>Container RAM</span>${icon('spark', 'icon-sm')}</div>
            <div class="kpi-value tabular">${system.rssMb || 0} <span style="font-size:14px;color:var(--ink-muted);">/ ${system.maxRamMb || 512} MB</span></div>
            <div class="kpi-foot">Sockets active: <span class="tabular">${system.activeSockets || 0} / ${system.maxSockets || 5}</span></div>
          </div>
          <div class="kpi-card">
            <div class="kpi-label"><span>MongoDB Atlas M0</span>${icon('overview', 'icon-sm')}</div>
            <div class="kpi-value tabular">${db ? `${db.totalMb}` : '—'} <span style="font-size:14px;color:var(--ink-muted);">/ 512 MB</span></div>
            <div class="kpi-foot">${db ? `${db.percentUsed}% used · ${db.objects} docs` : 'Stats unavailable'}</div>
          </div>
          <div class="kpi-card">
            <div class="kpi-label"><span>LLM Fallback Chain</span>${icon('brain', 'icon-sm')}</div>
            <div class="kpi-value tabular" style="font-size:16px;margin-top:12px;">
              ${prov.gemini ? '<span class="pill pill-emerald">Gemini</span> ' : ''}
              ${prov.openrouter ? '<span class="pill pill-sky">OpenRouter</span> ' : ''}
              ${prov.groq ? '<span class="pill">Groq</span>' : ''}
            </div>
            <div class="kpi-foot">Uptime ${Math.floor((system.uptimeSec || 0) / 60)}m</div>
          </div>
        </div>

        <div class="card" style="padding:0;overflow:hidden;">
          <div class="row-between" style="padding:16px 18px;border-bottom:1px solid var(--border-hairline);">
            <div>
              <h2 class="card-title">Client Accounts & WhatsApp Sessions</h2>
              <div class="card-sub">Create client credentials (username + password), inspect sessions, or jump straight into any workspace.</div>
            </div>
          </div>
          <div class="table-wrap" style="border:none;border-radius:0;">
            <table>
              <thead>
                <tr>
                  <th>Client / Workspace</th>
                  <th>Username</th>
                  <th>WhatsApp</th>
                  <th>Messages (In / AI)</th>
                  <th>Leads</th>
                  <th>Status</th>
                  <th style="text-align:right;">Actions</th>
                </tr>
              </thead>
              <tbody>
                ${tenants.length === 0 ? `
                  <tr><td colspan="7" style="text-align:center;padding:36px;color:var(--ink-muted);">No clients yet. Click <strong>Create Client</strong> to issue your first account.</td></tr>
                ` : tenants.map((t) => {
                  const waBadge = t.waStatus === 'open'
                    ? `<span class="pill pill-emerald"><span class="dot dot-emerald"></span><span class="tabular">${escHtml(t.waPhone || 'Live')}</span></span>`
                    : t.waStatus === 'qr_ready'
                      ? `<span class="pill pill-amber"><span class="dot dot-amber"></span>QR Waiting</span>`
                      : `<span class="pill"><span class="dot dot-muted"></span>Offline</span>`;
                  const statusBadge = t.status === 'active'
                    ? `<span class="pill pill-emerald">Active</span>`
                    : `<span class="pill pill-rose">Suspended</span>`;
                  return `
                    <tr>
                      <td>
                        <div style="font-weight:500;">${escHtml(t.name)}</div>
                        <div class="card-sub tabular">${escHtml(t.id)} · ${relativeTime(t.createdAt)} ago</div>
                      </td>
                      <td class="mono">${escHtml(t.username || '—')}</td>
                      <td>${waBadge}</td>
                      <td class="tabular">${t.msgsIn} / ${t.msgsAiOut} <span class="muted" style="font-size:11px;">(cap ${t.maxDailyOut}/d)</span></td>
                      <td class="tabular">${t.leadsCount}</td>
                      <td>${statusBadge}</td>
                      <td style="text-align:right;">
                        <div class="row-gap" style="justify-content:flex-end;">
                          <button class="btn-3d btn-3d-primary btn-sm" data-act="impersonate" data-id="${escHtml(t.id)}">${icon('arrowRight', 'icon-sm')}<span>Open Portal</span></button>
                          <button class="btn-3d btn-3d-secondary btn-sm" data-act="resetpw" data-id="${escHtml(t.id)}" data-name="${escHtml(t.username)}">${icon('key', 'icon-sm')}</button>
                          <button class="btn-3d btn-3d-secondary btn-sm" data-act="toggle" data-id="${escHtml(t.id)}" data-next="${t.status === 'active' ? 'suspended' : 'active'}">${t.status === 'active' ? 'Suspend' : 'Activate'}</button>
                          <button class="btn-3d btn-3d-danger btn-sm" data-act="delete" data-id="${escHtml(t.id)}" data-name="${escHtml(t.name)}">${icon('trash', 'icon-sm')}</button>
                        </div>
                      </td>
                    </tr>
                  `;
                }).join('')}
              </tbody>
            </table>
          </div>
        </div>
      </main>
    </div>
    ${renderModal()}
  `;

  root.querySelector('#refresh-btn').addEventListener('click', refreshOverview);
  root.querySelector('#new-client-btn').addEventListener('click', () => {
    state.modal = { type: 'create' };
    render();
  });
  root.querySelector('#admin-logout-btn').addEventListener('click', async () => {
    await api('/api/admin/logout', { method: 'POST' });
    state.authenticated = false;
    render();
  });

  root.querySelectorAll('[data-act]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const act = btn.dataset.act;
      const id = btn.dataset.id;
      try {
        if (act === 'impersonate') {
          await api(`/api/admin/impersonate/${encodeURIComponent(id)}`, { method: 'POST' });
          window.location.href = '/';
        } else if (act === 'toggle') {
          await api(`/api/admin/tenants/${encodeURIComponent(id)}`, {
            method: 'PATCH',
            body: { status: btn.dataset.next }
          });
          toast(`Workspace marked ${btn.dataset.next}.`);
          await refreshOverview();
        } else if (act === 'resetpw') {
          state.modal = { type: 'resetpw', id, username: btn.dataset.name };
          render();
        } else if (act === 'delete') {
          state.modal = { type: 'delete', id, name: btn.dataset.name };
          render();
        }
      } catch (err) {
        toast(err.message, 'err');
      }
    });
  });

  bindModalEvents();
}

function renderModal() {
  if (!state.modal) return '';
  if (state.modal.type === 'create') {
    return `
      <div class="modal-backdrop">
        <form id="modal-create-form" class="modal">
          <div class="row-between" style="margin-bottom:16px;">
            <h3 class="card-title" style="font-size:16px;">Create Client Account</h3>
            <button type="button" id="close-modal" class="btn-3d btn-3d-secondary btn-sm">Close</button>
          </div>
          <div class="field">
            <label>Business / Workspace Name</label>
            <input name="businessName" class="input" placeholder="e.g. Ninja Store" required />
          </div>
          <div class="field">
            <label>Client Login Username (no email required)</label>
            <input name="username" class="input mono" placeholder="e.g. ninja" required pattern="[a-zA-Z0-9._-]{3,32}" />
          </div>
          <div class="field">
            <label>Client Password</label>
            <input name="password" class="input mono" type="text" placeholder="e.g. ninja69" required minlength="4" />
          </div>
          <button type="submit" class="btn-3d btn-3d-primary btn-full">${icon('plus', 'icon-sm')}<span>Create Workspace</span></button>
        </form>
      </div>
    `;
  }
  if (state.modal.type === 'resetpw') {
    return `
      <div class="modal-backdrop">
        <form id="modal-resetpw-form" class="modal">
          <div class="row-between" style="margin-bottom:16px;">
            <h3 class="card-title">Reset Password (${escHtml(state.modal.username)})</h3>
            <button type="button" id="close-modal" class="btn-3d btn-3d-secondary btn-sm">Close</button>
          </div>
          <div class="field">
            <label>New Password</label>
            <input name="password" class="input mono" type="text" required minlength="4" placeholder="Enter new password" />
          </div>
          <button type="submit" class="btn-3d btn-3d-primary btn-full">Save New Password</button>
        </form>
      </div>
    `;
  }
  if (state.modal.type === 'delete') {
    return `
      <div class="modal-backdrop">
        <div class="modal">
          <h3 class="card-title" style="margin-bottom:8px;">Delete Workspace "${escHtml(state.modal.name)}"?</h3>
          <p class="card-sub" style="margin-bottom:18px;line-height:1.5;">
            This disconnects WhatsApp immediately and permanently deletes this client's login, WhatsApp keys, conversations, and leads.
          </p>
          <div class="row-gap" style="justify-content:flex-end;">
            <button type="button" id="close-modal" class="btn-3d btn-3d-secondary">Cancel</button>
            <button type="button" id="confirm-delete-btn" class="btn-3d btn-3d-danger">Delete Permanently</button>
          </div>
        </div>
      </div>
    `;
  }
  return '';
}

function bindModalEvents() {
  const close = root.querySelector('#close-modal');
  if (close) close.addEventListener('click', () => { state.modal = null; render(); });

  const cf = root.querySelector('#modal-create-form');
  if (cf) {
    cf.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(cf);
      try {
        await api('/api/admin/tenants', {
          method: 'POST',
          body: {
            businessName: fd.get('businessName'),
            username: fd.get('username'),
            password: fd.get('password')
          }
        });
        toast('Client created cleanly.');
        state.modal = null;
        await refreshOverview();
      } catch (err) {
        toast(err.message, 'err');
      }
    });
  }

  const rf = root.querySelector('#modal-resetpw-form');
  if (rf) {
    rf.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(rf);
      try {
        await api(`/api/admin/tenants/${encodeURIComponent(state.modal.id)}/reset-password`, {
          method: 'POST',
          body: { password: fd.get('password') }
        });
        toast('Password updated.');
        state.modal = null;
        render();
      } catch (err) {
        toast(err.message, 'err');
      }
    });
  }

  const del = root.querySelector('#confirm-delete-btn');
  if (del) {
    del.addEventListener('click', async () => {
      try {
        await api(`/api/admin/tenants/${encodeURIComponent(state.modal.id)}`, { method: 'DELETE' });
        toast('Workspace wiped cleanly.');
        state.modal = null;
        await refreshOverview();
      } catch (err) {
        toast(err.message, 'err');
      }
    });
  }
}

function render() {
  if (!state.configured) return renderUnconfigured();
  if (!state.authenticated) return renderLogin();
  return renderConsole();
}

boot();
