import { api, escHtml, toast } from './api.js';
import { icon } from './icons.js';
import { renderOnboarding } from './views/onboarding.js';
import { renderOverviewView } from './views/overview.js';
import { renderInboxView } from './views/inbox.js';
import { renderBrainView } from './views/brain.js';
import { renderSafetyView } from './views/safety.js';
import { renderLeadsView, renderLogsView, renderChannelsView } from './views/leads_logs.js';

const root = document.getElementById('app-root');

const state = {
  user: null,
  activeTab: 'overview',
  initialConvId: null,
  sse: null,
  activeListener: null,
  cmdOpen: false,
  theme: localStorage.getItem('wa_theme') || 'dark'
};

if (state.theme === 'light') {
  document.documentElement.setAttribute('data-theme', 'light');
}

function toggleTheme() {
  state.theme = state.theme === 'dark' ? 'light' : 'dark';
  localStorage.setItem('wa_theme', state.theme);
  if (state.theme === 'light') document.documentElement.setAttribute('data-theme', 'light');
  else document.documentElement.removeAttribute('data-theme');
}

async function boot() {
  try {
    const me = await api('/api/auth/me');
    if (me.authenticated) {
      state.user = me.user;
      connectSSE();
      if (!state.user.onboardingDone) {
        renderOnboardingScreen();
      } else {
        renderShell();
      }
      return;
    }
    if (me.suspended) {
      renderLoginScreen('Your workspace is currently paused. Contact your administrator.');
      return;
    }
  } catch {}
  renderLoginScreen();
}

function renderLoginScreen(bannerErr = '') {
  if (state.sse) { state.sse.close(); state.sse = null; }
  root.innerHTML = `
    <div class="auth-stage">
      <form id="login-form" class="auth-card">
        <div class="row-gap" style="margin-bottom:22px;">
          <div class="brand-mark">${icon('logo', 'icon-lg')}</div>
          <div>
            <h1 style="font-size:19px;">Client Workspace</h1>
            <div class="card-sub">Sign in to WhatsApp AI Automation</div>
          </div>
        </div>

        ${bannerErr ? `<div style="padding:10px 12px;border-radius:8px;background:var(--rose-tint);border:1px solid var(--rose-border);color:var(--rose);font-size:12px;margin-bottom:14px;">${escHtml(bannerErr)}</div>` : ''}

        <div class="field">
          <label for="u-name">Username</label>
          <input id="u-name" name="username" class="input mono" autocomplete="username" placeholder="Enter your username" required />
        </div>

        <div class="field">
          <label for="u-pass">Password</label>
          <div class="input-wrap">
            <input id="u-pass" name="password" class="input" type="password" autocomplete="current-password" placeholder="Enter password" required />
            <button type="button" id="login-eye" class="input-eye" title="Show/Hide">${icon('eye', 'icon-sm')}</button>
          </div>
        </div>

        <div class="row-between" style="margin:6px 0 16px;">
          <span class="card-sub" style="font-size:11px;">Session persists automatically for 14 days</span>
        </div>

        <button type="submit" id="login-submit" class="btn-3d btn-3d-primary btn-lg btn-full">
          <span>Sign In to Workspace</span>
          ${icon('arrowRight', 'icon-sm')}
        </button>
      </form>
    </div>
  `;

  const passEl = root.querySelector('#u-pass');
  root.querySelector('#login-eye').addEventListener('click', () => {
    passEl.type = passEl.type === 'password' ? 'text' : 'password';
  });

  root.querySelector('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = root.querySelector('#login-submit');
    btn.disabled = true;
    try {
      await api('/api/auth/login', {
        method: 'POST',
        body: {
          username: root.querySelector('#u-name').value.trim(),
          password: passEl.value
        }
      });
      const me = await api('/api/auth/me');
      state.user = me.user;
      connectSSE();
      if (!state.user.onboardingDone) renderOnboardingScreen();
      else renderShell();
    } catch (err) {
      toast(err.message, 'err');
      btn.disabled = false;
    }
  });
}

function renderOnboardingScreen() {
  state.activeListener = renderOnboarding(root, {
    user: state.user,
    onOnboardingDone: () => {
      state.user.onboardingDone = true;
      state.activeTab = 'inbox';
      renderShell();
    }
  });
}

const NAV_ITEMS = [
  { id: 'overview', label: 'Overview', icon: 'overview' },
  { id: 'inbox', label: 'Inbox & Preview', icon: 'inbox' },
  { id: 'leads', label: 'Leads CRM', icon: 'leads' },
  { id: 'brain', label: 'Business Brain', icon: 'brain' },
  { id: 'safety', label: 'Safety & Rules', icon: 'shield' },
  { id: 'logs', label: 'Live Logs', icon: 'terminal' },
  { id: 'channels', label: 'Channels', icon: 'plug' }
];

function navigate(tab, opts = {}) {
  state.activeTab = tab;
  state.initialConvId = opts.convId || null;
  renderActiveView();
  document.querySelectorAll('.nav-item[data-tab]').forEach((b) => {
    b.classList.toggle('active', b.dataset.tab === tab);
  });
  const titleEl = document.getElementById('top-title');
  if (titleEl) titleEl.textContent = NAV_ITEMS.find((n) => n.id === tab)?.label || 'Workspace';
}

function renderShell() {
  const u = state.user;

  root.innerHTML = `
    <div class="app-shell">
      <aside class="sidebar">
        <div class="sidebar-header">
          <div class="brand-mark" style="width:32px;height:32px;">${icon('logo', 'icon')}</div>
          <div style="min-width:0;">
            <div style="font-weight:600;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escHtml(u.businessName)}</div>
            <div class="mono muted" style="font-size:11px;">@${escHtml(u.username)}</div>
          </div>
        </div>

        <nav class="nav-group">
          ${NAV_ITEMS.map((item) => `
            <button class="nav-item ${state.activeTab === item.id ? 'active' : ''}" data-tab="${item.id}">
              <span class="nav-item-left">${icon(item.icon, 'icon')}<span>${item.label}</span></span>
            </button>
          `).join('')}
        </nav>

        <div style="margin-top:auto;padding-top:12px;border-top:1px solid var(--border-hairline);display:flex;flex-direction:column;gap:8px;">
          <button type="button" id="sidebar-wa-pill" class="pill ${u.waStatus === 'open' ? 'pill-emerald' : 'pill-amber'}" style="justify-content:space-between;padding:7px 10px;width:100%;cursor:pointer;" title="Manage WhatsApp Connection">
            <span class="row-gap"><span class="dot ${u.waStatus === 'open' ? 'dot-emerald' : 'dot-amber'}"></span><span>${u.waStatus === 'open' ? 'WhatsApp Live' : 'WA ' + escHtml(u.waStatus)}</span></span>
          </button>
          <button id="btn-logout" class="nav-item">${icon('logout', 'icon-sm')}<span>Sign Out</span></button>
        </div>
      </aside>

      <div class="main-col">
        ${u.impersonating ? `
          <div class="impersonate-bar">
            <span>Agency Admin Impersonation Active &middot; Viewing <strong>${escHtml(u.businessName)}</strong></span>
            <button id="exit-impersonate" class="btn-3d btn-3d-secondary btn-sm">Exit to Admin</button>
          </div>
        ` : ''}

        <header class="topbar">
          <div class="row-gap">
            <h1 id="top-title" style="font-size:16px;">${escHtml(NAV_ITEMS.find((n) => n.id === state.activeTab)?.label || 'Overview')}</h1>
          </div>
          <div class="row-gap">
            <button id="open-cmd" class="btn-3d btn-3d-secondary btn-sm" title="Quick Jump (Ctrl/Cmd+K)">${icon('command', 'icon-sm')}<span>Quick Jump</span><kbd>⌘K</kbd></button>
            <button id="top-theme" class="btn-3d btn-3d-secondary btn-sm" title="Switch Light/Dark">${icon('sun', 'icon-sm')}</button>
          </div>
        </header>

        <main id="view-slot" class="page-body"></main>
      </div>
    </div>
    <div id="cmd-slot"></div>
  `;

  root.querySelectorAll('.nav-item[data-tab]').forEach((b) => {
    b.addEventListener('click', () => navigate(b.dataset.tab));
  });
  root.querySelector('#sidebar-wa-pill')?.addEventListener('click', () => navigate('channels'));
  root.querySelector('#top-theme').addEventListener('click', toggleTheme);
  root.querySelector('#open-cmd').addEventListener('click', openCmdPalette);
  root.querySelector('#btn-logout').addEventListener('click', async () => {
    await api('/api/auth/logout', { method: 'POST' });
    state.user = null;
    renderLoginScreen();
  });
  root.querySelector('#exit-impersonate')?.addEventListener('click', async () => {
    await api('/api/admin/exit-impersonate', { method: 'POST' });
    window.location.href = '/admin';
  });

  renderActiveView();
}

function renderActiveView() {
  const slot = document.getElementById('view-slot');
  if (!slot) return;

  const ctx = {
    user: state.user,
    initialConvId: state.initialConvId,
    navigate,
    toggleTheme,
    syncStatusUi
  };

  if (state.activeTab === 'overview') state.activeListener = renderOverviewView(slot, ctx);
  else if (state.activeTab === 'inbox') state.activeListener = renderInboxView(slot, ctx);
  else if (state.activeTab === 'leads') state.activeListener = renderLeadsView(slot, ctx);
  else if (state.activeTab === 'brain') state.activeListener = renderBrainView(slot, ctx);
  else if (state.activeTab === 'safety') state.activeListener = renderSafetyView(slot, ctx);
  else if (state.activeTab === 'logs') state.activeListener = renderLogsView(slot, ctx);
  else if (state.activeTab === 'channels') state.activeListener = renderChannelsView(slot, ctx);
}

function syncStatusUi() {
  const pill = document.getElementById('sidebar-wa-pill');
  if (!pill || !state.user) return;
  const open = state.user.waStatus === 'open';
  pill.className = `pill ${open ? 'pill-emerald' : 'pill-amber'}`;
  pill.innerHTML = `<span class="row-gap"><span class="dot ${open ? 'dot-emerald' : 'dot-amber'}"></span><span>${open ? 'WhatsApp Live' : 'WA ' + escHtml(state.user.waStatus)}</span></span>`;
}

function connectSSE() {
  if (state.sse) state.sse.close();
  const es = new EventSource('/api/stream');
  state.sse = es;

  const dispatch = (eventType) => (ev) => {
    try {
      const data = JSON.parse(ev.data);
      if (eventType === 'wa_qr' || eventType === 'wa_status') {
        if (data.status && state.user) state.user.waStatus = data.status;
        if (data.qrDataUrl !== undefined && state.user) state.user.qrDataUrl = data.qrDataUrl;
        if (data.waPhone && state.user) state.user.waPhone = data.waPhone;
        syncStatusUi();
      }
      if (typeof state.activeListener === 'function') {
        state.activeListener(eventType, data);
      }
    } catch {}
  };

  ['wa_qr', 'wa_status', 'inbox_msg', 'log'].forEach((ev) => es.addEventListener(ev, dispatch(ev)));
}

function openCmdPalette() {
  const slot = document.getElementById('cmd-slot');
  if (!slot) return;
  slot.innerHTML = `
    <div class="modal-backdrop" id="cmd-backdrop">
      <div class="modal" style="padding:14px;">
        <input id="cmd-input" class="input" placeholder="Type section name (Inbox, Brain, Safety, Logs)..." autofocus />
        <div style="margin-top:10px;display:flex;flex-direction:column;gap:4px;">
          ${NAV_ITEMS.map((item) => `
            <button class="nav-item cmd-opt" data-tab="${item.id}">
              <span class="nav-item-left">${icon(item.icon, 'icon-sm')}<span>Go to ${item.label}</span></span>
            </button>
          `).join('')}
        </div>
      </div>
    </div>
  `;
  const close = () => { slot.innerHTML = ''; };
  slot.querySelector('#cmd-backdrop').addEventListener('click', (e) => { if (e.target.id === 'cmd-backdrop') close(); });
  slot.querySelectorAll('.cmd-opt').forEach((b) => {
    b.addEventListener('click', () => { close(); navigate(b.dataset.tab); });
  });
  slot.querySelector('#cmd-input').addEventListener('input', (e) => {
    const q = e.target.value.toLowerCase();
    slot.querySelectorAll('.cmd-opt').forEach((b) => {
      b.style.display = b.textContent.toLowerCase().includes(q) ? 'flex' : 'none';
    });
  });
}

window.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
    if (!state.user) return;
    e.preventDefault();
    const slot = document.getElementById('cmd-slot');
    if (slot && slot.innerHTML) slot.innerHTML = '';
    else openCmdPalette();
  }
});

// Gentle active-tab ping every 10 min only while visible (helps avoid sudden SSE idle drops during work)
setInterval(() => {
  if (state.user && document.visibilityState === 'visible') {
    fetch('/api/ping', { method: 'POST' }).catch(() => {});
  }
}, 600_000);

boot();
