import { api, escHtml, formatTimeMs, relativeTime, toast } from './api.js';
import { icon } from './icons.js';

const root = document.getElementById('admin-root');
let state = { configured: true, authenticated: false, overview: null, modal: null, testReply: null };

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
  const { system, tenants, systemAlerts } = state.overview || { system: {}, tenants: [], systemAlerts: [] };
  const db = system.dbStorage;
  const prov = system.providers || {};

  root.innerHTML = `
    <div style="min-height:100vh;display:flex;flex-direction:column;">
      <header class="topbar">
        <div class="row-gap">
          <div class="brand-mark" style="width:30px;height:30px;">${icon('shield', 'icon-sm')}</div>
          <div class="display" style="font-size:15px;font-weight:600;">Agency Control Plane</div>
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
            <div class="kpi-label"><span>Client Workspaces</span>${icon('leads', 'icon-sm')}</div>
            <div class="kpi-value tabular">${tenants.length}</div>
            <div class="kpi-foot">${tenants.filter((t) => t.status === 'active').length} active &middot; ${tenants.filter((t) => t.waStatus === 'open').length} WhatsApp live</div>
          </div>
          <div class="kpi-card">
            <div class="kpi-label"><span>Container RAM</span>${icon('spark', 'icon-sm')}</div>
            <div class="kpi-value tabular">${system.rssMb || 0} <span style="font-size:14px;color:var(--ink-muted);">/ ${system.maxRamMb || 512} MB</span></div>
            <div class="kpi-foot">Sockets active: <span class="tabular">${system.activeSockets || 0} / ${system.maxSockets || 5}</span></div>
          </div>
          <div class="kpi-card">
            <div class="kpi-label"><span>MongoDB Atlas M0</span>${icon('overview', 'icon-sm')}</div>
            <div class="kpi-value tabular">${db ? `${db.totalMb}` : '—'} <span style="font-size:14px;color:var(--ink-muted);">/ 512 MB</span></div>
            <div class="kpi-foot">${db ? `${db.percentUsed}% used &middot; ${db.objects} docs` : 'Stats unavailable'}</div>
          </div>
          <div class="kpi-card">
            <div class="kpi-label"><span>LLM Fallback Chain</span>${icon('brain', 'icon-sm')}</div>
            <div class="kpi-value tabular" style="font-size:15px;margin-top:12px;">
              ${prov.gemini ? '<span class="pill pill-emerald">Gemini</span> ' : ''}
              ${prov.openrouter ? '<span class="pill pill-sky">OpenRouter</span> ' : ''}
              ${prov.groq ? '<span class="pill">Groq</span>' : ''}
            </div>
            <div class="kpi-foot">Uptime ${Math.floor((system.uptimeSec || 0) / 60)}m</div>
          </div>
        </div>

        <div class="card" style="padding:0;overflow:hidden;margin-bottom:16px;">
          <div class="row-between" style="padding:16px 18px;border-bottom:1px solid var(--border-hairline);">
            <div>
              <h2 class="card-title">Client Accounts, System Prompts &amp; WhatsApp Links</h2>
              <div class="card-sub">Set Category, Core System Prompt, AI Model &amp; Caps per client &mdash; zero client data wiped on edits.</div>
            </div>
          </div>
          <div class="table-wrap" style="border:none;border-radius:0;">
            <table>
              <thead>
                <tr>
                  <th>Client &amp; Category</th>
                  <th>Username</th>
                  <th>WhatsApp</th>
                  <th>Model / Budget</th>
                  <th>Traffic / Leads</th>
                  <th>Status</th>
                  <th style="text-align:right;">Agency Controls</th>
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
                      : t.waStatus === 'cooldown' || t.waStatus === 'forbidden'
                        ? `<span class="pill pill-rose">${escHtml(t.waStatus)}</span>`
                        : `<span class="pill"><span class="dot dot-muted"></span>Offline</span>`;
                  const statusBadge = t.status === 'active'
                    ? `<span class="pill pill-emerald">Active</span>`
                    : `<span class="pill pill-rose">Suspended</span>`;
                  return `
                    <tr>
                      <td>
                        <div style="font-weight:500;">${escHtml(t.name)}</div>
                        <div class="card-sub">${escHtml(t.industry || 'General')} &middot; ${t.onboardingDone ? 'Setup Complete' : 'Needs WA Link'}</div>
                      </td>
                      <td class="mono">${escHtml(t.username || '—')}</td>
                      <td>${waBadge}</td>
                      <td>
                        <div class="mono" style="font-size:11px;">${escHtml(t.aiConfig?.primaryModel || 'auto')} (T=${t.aiConfig?.temperature ?? 0.42})</div>
                        <div class="card-sub tabular">~${t.digestTokens || 0} tok &middot; cap ${t.safety?.maxDailyOut || t.maxDailyOut}/d</div>
                      </td>
                      <td class="tabular">
                        <div>${t.msgsIn} in / ${t.msgsAiOut} AI</div>
                        <div class="card-sub">${t.leadsCount} leads ${t.needsHumanCount ? `&middot; <span style="color:var(--amber);">${t.needsHumanCount} escalations</span>` : ''}</div>
                      </td>
                      <td>${statusBadge}</td>
                      <td style="text-align:right;">
                        <div class="row-gap" style="justify-content:flex-end;">
                          <button class="btn-3d btn-3d-secondary btn-sm" data-act="config" data-id="${escHtml(t.id)}" title="Edit Prompt, Model & Config">${icon('brain', 'icon-sm')}<span>Prompt &amp; Config</span></button>
                          <button class="btn-3d btn-3d-primary btn-sm" data-act="impersonate" data-id="${escHtml(t.id)}">${icon('arrowRight', 'icon-sm')}<span>Open</span></button>
                          <button class="btn-3d btn-3d-secondary btn-sm" data-act="resetpw" data-id="${escHtml(t.id)}" data-name="${escHtml(t.username)}" title="Reset Password">${icon('key', 'icon-sm')}</button>
                          <button class="btn-3d btn-3d-secondary btn-sm" data-act="toggle" data-id="${escHtml(t.id)}" data-next="${t.status === 'active' ? 'suspended' : 'active'}">${t.status === 'active' ? 'Suspend' : 'Activate'}</button>
                          <button class="btn-3d btn-3d-danger btn-sm" data-act="delete" data-id="${escHtml(t.id)}" data-name="${escHtml(t.name)}" title="Delete">${icon('trash', 'icon-sm')}</button>
                        </div>
                      </td>
                    </tr>
                  `;
                }).join('')}
              </tbody>
            </table>
          </div>
        </div>

        <div class="card" style="padding:0;overflow:hidden;">
          <div style="padding:14px 18px;border-bottom:1px solid var(--border-hairline);">
            <h3 class="card-title">Cross-Client Warnings &amp; Human Escalation Feed</h3>
            <div class="card-sub">Monitors handoffs, rate limits &amp; circuit-breaker alerts across every tenant</div>
          </div>
          <div style="max-height:240px;overflow-y:auto;background:var(--bg-inset);font-family:var(--font-mono);font-size:12px;">
            ${!systemAlerts || systemAlerts.length === 0
              ? `<div style="padding:20px;text-align:center;" class="muted">All workspaces healthy &mdash; zero warnings right now.</div>`
              : systemAlerts.map((a) => `
                <div class="log-row ${escHtml(a.level)}">
                  <span class="tabular muted">${formatTimeMs(a.createdAt)}</span>
                  <span class="pill ${a.level === 'err' ? 'pill-rose' : 'pill-amber'}" style="font-size:10px;padding:1px 6px;">${escHtml((a.level || 'warn').toUpperCase())}</span>
                  <span style="color:var(--ink-secondary);overflow:hidden;text-overflow:ellipsis;">${escHtml(a.tenantName)}</span>
                  <span>${escHtml(a.msg)}</span>
                </div>
              `).join('')}
          </div>
        </div>
      </main>
    </div>
    ${renderModal()}
  `;

  root.querySelector('#refresh-btn').addEventListener('click', refreshOverview);
  root.querySelector('#new-client-btn').addEventListener('click', () => {
    state.testReply = null;
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
        } else if (act === 'config') {
          const tenant = tenants.find((x) => x.id === id);
          state.testReply = null;
          state.modal = { type: 'config', tenant };
          render();
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
  const templates = state.overview?.promptTemplates || {};
  const existingTenants = state.overview?.tenants || [];

  if (state.modal.type === 'create') {
    return `
      <div class="modal-backdrop">
        <form id="modal-create-form" class="modal" style="max-width:580px;max-height:92vh;overflow-y:auto;">
          <div class="row-between" style="margin-bottom:14px;">
            <h3 class="card-title" style="font-size:16px;">Create Client &amp; Configure AI</h3>
            <button type="button" id="close-modal" class="btn-3d btn-3d-secondary btn-sm">Close</button>
          </div>

          <div class="equal-col" style="gap:10px;">
            <div class="field">
              <label>Business / Store Name</label>
              <input name="businessName" class="input" placeholder="e.g. Ninja Electronics" required />
            </div>
            <div class="field">
              <label>Business Category (Client won't edit this)</label>
              <input name="industry" id="cr-industry" class="input" placeholder="e.g. Clinic, Dental, Clothing Store" value="Service & Retail Business" required />
            </div>
            <div class="field">
              <label>Client Login Username</label>
              <input name="username" class="input mono" placeholder="e.g. ninja" required pattern="[a-zA-Z0-9._-]{3,32}" />
            </div>
            <div class="field">
              <label>Client Password</label>
              <input name="password" class="input mono" type="text" placeholder="e.g. ninja69" required minlength="4" />
            </div>
          </div>

          <div class="equal-col" style="gap:10px;">
            <div class="field">
              <label>Quick Vertical Prompt Preset</label>
              <select id="cr-tpl" class="select">
                <option value="">-- Select Template (Optional) --</option>
                ${Object.entries(templates).map(([k, t]) => `<option value="${k}">${escHtml(t.label)}</option>`).join('')}
              </select>
            </div>
            <div class="field">
              <label>Clone Prompt &amp; Catalog From Existing Client</label>
              <select name="cloneFromTenantId" class="select">
                <option value="">Start Fresh</option>
                ${existingTenants.map((t) => `<option value="${escHtml(t.id)}">${escHtml(t.name)} (@${escHtml(t.username)})</option>`).join('')}
              </select>
            </div>
          </div>

          <div class="field">
            <label>Core Agency System Prompt (Locked from client edits)</label>
            <textarea name="agencySystemPrompt" id="cr-prompt" class="textarea" rows="4" required placeholder="Define persona, booking goal, tone, and what team handles...">${escHtml(templates.sales_concierge?.prompt || '')}</textarea>
          </div>

          <div class="equal-col" style="gap:10px;">
            <div class="field">
              <label>Primary AI Model</label>
              <select name="primaryModel" class="select">
                <option value="auto">Auto Two-Lane (Text: Groq -> Gemini -> OpenRouter | Media: Gemini)</option>
                <option value="groq">Groq First (openai/gpt-oss-20b fast)</option>
                <option value="gemini-3.5-flash-lite">gemini-3.5-flash-lite (Fast Minimal Think)</option>
                <option value="gemini-3.8-flash">gemini-3.8-flash (Low Think)</option>
                <option value="gemini-3.1-flash-lite">gemini-3.1-flash-lite</option>
                <option value="openrouter">OpenRouter Free First</option>
              </select>
            </div>
            <div class="field">
              <label>Daily AI Reply Cap</label>
              <input name="maxDailyOut" type="number" class="input mono" value="90" min="5" max="1000" />
            </div>
          </div>

          <div class="field">
            <label>Bulk Import Catalog / Offers / FAQs JSON (Optional)</label>
            <textarea name="brainJsonText" class="textarea mono" rows="3" placeholder='Optional: paste JSON {"offers":[...],"products":[...],"faqs":[...]}'></textarea>
          </div>

          <button type="submit" class="btn-3d btn-3d-primary btn-full">${icon('plus', 'icon-sm')}<span>Create Client Account</span></button>
        </form>
      </div>
    `;
  }

  if (state.modal.type === 'config') {
    const t = state.modal.tenant;
    const ai = t.aiConfig || {};
    const saf = t.safety || {};

    return `
      <div class="modal-backdrop">
        <div class="modal" style="max-width:660px;max-height:92vh;overflow-y:auto;">
          <div class="row-between" style="margin-bottom:14px;">
            <div>
              <h3 class="card-title" style="font-size:16px;">Configure Workspace &middot; ${escHtml(t.name)}</h3>
              <div class="card-sub mono">@${escHtml(t.username)} &middot; ${escHtml(t.id)} &middot; Zero data loss on update</div>
            </div>
            <button type="button" id="close-modal" class="btn-3d btn-3d-secondary btn-sm">Close</button>
          </div>

          <form id="modal-config-form">
            <div class="equal-col" style="gap:10px;">
              <div class="field">
                <label>Business Name</label>
                <input name="businessName" class="input" value="${escHtml(t.name)}" required />
              </div>
              <div class="field">
                <label>Business Category / Industry</label>
                <input name="industry" id="ed-industry" class="input" value="${escHtml(t.industry || '')}" required />
              </div>
            </div>

            <div class="field">
              <div class="row-between" style="margin-bottom:4px;">
                <label style="margin:0;">Core System Prompt (Client cannot view or overwrite this)</label>
                <select id="ed-tpl" class="select" style="width:auto;height:28px;padding:2px 8px;font-size:11px;">
                  <option value="">Insert Vertical Template...</option>
                  ${Object.entries(templates).map(([k, tp]) => `<option value="${k}">${escHtml(tp.label)}</option>`).join('')}
                </select>
              </div>
              <textarea name="agencySystemPrompt" id="ed-prompt" class="textarea" rows="5" required>${escHtml(t.agencySystemPrompt || '')}</textarea>
            </div>

            <div class="equal-col" style="gap:10px;">
              <div class="field">
                <label>Preferred Model</label>
                <select name="primaryModel" id="ed-model" class="select">
                  ${[
                    { v: 'auto', l: 'Auto Two-Lane (Text: Groq -> Gemini -> OR | Media: Gemini)' },
                    { v: 'groq', l: 'Groq First (openai/gpt-oss-20b)' },
                    { v: 'gemini-3.5-flash-lite', l: 'gemini-3.5-flash-lite (Fast Minimal Think)' },
                    { v: 'gemini-3.8-flash', l: 'gemini-3.8-flash (Low Think)' },
                    { v: 'gemini-3.1-flash-lite', l: 'gemini-3.1-flash-lite' },
                    { v: 'openrouter', l: 'OpenRouter Free First' }
                  ].map((o) => `<option value="${o.v}" ${(ai.primaryModel || 'auto') === o.v ? 'selected' : ''}>${o.l}</option>`).join('')}
                </select>
              </div>
              <div class="field">
                <label>Temperature (<span id="ed-temp-val" class="mono">${ai.temperature ?? 0.42}</span> &middot; Lower = Less Hallucination)</label>
                <input name="temperature" id="ed-temp" type="range" min="0.1" max="0.7" step="0.05" value="${ai.temperature ?? 0.42}" style="width:100%;" />
              </div>
              <div class="field">
                <label>Max Output Tokens</label>
                <input name="maxOutputTokens" id="ed-tokens" type="number" class="input mono" min="180" max="750" value="${ai.maxOutputTokens || 460}" />
              </div>
              <div class="field">
                <label>Daily / Hourly Reply Cap</label>
                <div class="row-gap">
                  <input name="maxDailyOut" type="number" class="input mono" value="${saf.maxDailyOut || 90}" min="5" max="1000" title="Daily" />
                  <input name="maxHourlyOut" type="number" class="input mono" value="${saf.maxHourlyOut || 18}" min="2" max="100" title="Hourly" />
                </div>
              </div>
            </div>

            <div class="equal-col" style="gap:8px;margin-bottom:14px;">
              <label class="row-between" style="padding:8px 10px;background:var(--bg-inset);border:1px solid var(--border-hairline);border-radius:8px;font-size:12px;">
                <span>Allow Client to Edit Offers/Prices/FAQs</span>
                <input type="checkbox" name="allowClientBrainEdit" ${ai.allowClientBrainEdit !== false ? 'checked' : ''} />
              </label>
              <label class="row-between" style="padding:8px 10px;background:var(--bg-inset);border:1px solid var(--border-hairline);border-radius:8px;font-size:12px;">
                <span>AI Master Enabled</span>
                <input type="checkbox" name="aiEnabled" ${saf.aiEnabled !== false ? 'checked' : ''} />
              </label>
              <label class="row-between" style="padding:8px 10px;background:var(--bg-inset);border:1px solid var(--border-hairline);border-radius:8px;font-size:12px;">
                <span>Voice Note Transcription</span>
                <input type="checkbox" name="voiceNotesEnabled" ${saf.voiceNotesEnabled !== false ? 'checked' : ''} />
              </label>
              <label class="row-between" style="padding:8px 10px;background:var(--bg-inset);border:1px solid var(--border-hairline);border-radius:8px;font-size:12px;">
                <span>Bypass Strict WA Link Gate</span>
                <input type="checkbox" name="onboardingDone" ${t.onboardingDone ? 'checked' : ''} />
              </label>
            </div>

            <div class="field">
              <label>Bulk Replace Offers / Prices / FAQs via JSON (Optional &mdash; leave blank to keep existing)</label>
              <textarea name="brainJsonText" class="textarea mono" rows="3" placeholder='Paste JSON {"announcement":"...","offers":[...],"products":[...],"faqs":[...]}'></textarea>
            </div>

            <div class="row-gap" style="margin-bottom:14px;">
              <button type="submit" class="btn-3d btn-3d-primary" style="flex:1;">${icon('check', 'icon-sm')}<span>Save Prompt &amp; Config</span></button>
              <button type="button" id="ed-wa-reconnect" class="btn-3d btn-3d-secondary btn-sm">Reconnect WA</button>
              <button type="button" id="ed-clear-breaker" class="btn-3d btn-3d-secondary btn-sm">Clear Cooldown</button>
            </div>
          </form>

          <div style="padding:12px;background:var(--bg-inset);border:1px solid var(--border-hairline);border-radius:10px;">
            <div style="font-size:12px;font-weight:500;margin-bottom:8px;">Test This Client's AI Prompt Live</div>
            <form id="ed-test-form" class="row-gap">
              <input id="ed-test-input" class="input" placeholder="Ask something covered OR unmentioned (to check zero hallucination)..." required />
              <button type="submit" id="ed-test-btn" class="btn-3d btn-3d-secondary btn-sm">Test</button>
            </form>
            ${state.testReply ? `
              <div style="margin-top:10px;padding:10px;border-radius:8px;background:var(--bg-surface);border:1px solid var(--border-hairline);font-size:12px;">
                <div style="white-space:pre-wrap;">${escHtml(state.testReply.reply)}</div>
                <div class="mono muted" style="font-size:10px;margin-top:6px;">
                  ${escHtml(state.testReply.model)} &middot; ${state.testReply.latencyMs}ms &middot; ${state.testReply.promptChars} prompt chars
                  ${state.testReply.handoffData ? ` &middot; <span style="color:var(--amber);">HANDOFF TRIGGERED (${escHtml(state.testReply.handoffData.reason)})</span>` : ''}
                </div>
              </div>
            ` : ''}
          </div>
        </div>
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

  const templates = state.overview?.promptTemplates || {};
  root.querySelector('#cr-tpl')?.addEventListener('change', (e) => {
    const tp = templates[e.target.value];
    if (tp) {
      root.querySelector('#cr-industry').value = tp.industry;
      root.querySelector('#cr-prompt').value = tp.prompt;
    }
  });
  root.querySelector('#ed-tpl')?.addEventListener('change', (e) => {
    const tp = templates[e.target.value];
    if (tp) {
      root.querySelector('#ed-industry').value = tp.industry;
      root.querySelector('#ed-prompt').value = tp.prompt;
    }
  });
  root.querySelector('#ed-temp')?.addEventListener('input', (e) => {
    root.querySelector('#ed-temp-val').textContent = e.target.value;
  });

  const cf = root.querySelector('#modal-create-form');
  if (cf) {
    cf.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(cf);
      let brainJson = null;
      const rawJson = String(fd.get('brainJsonText') || '').trim();
      if (rawJson) {
        try { brainJson = JSON.parse(rawJson); }
        catch (err) { toast(`Invalid Brain JSON: ${err.message}`, 'err'); return; }
      }
      try {
        await api('/api/admin/tenants', {
          method: 'POST',
          body: {
            businessName: fd.get('businessName'),
            industry: fd.get('industry'),
            username: fd.get('username'),
            password: fd.get('password'),
            agencySystemPrompt: fd.get('agencySystemPrompt'),
            cloneFromTenantId: fd.get('cloneFromTenantId'),
            primaryModel: fd.get('primaryModel'),
            maxDailyOut: Number(fd.get('maxDailyOut') || 90),
            ...(brainJson ? { brainJson } : {})
          }
        });
        toast('Client created with custom system prompt.');
        state.modal = null;
        await refreshOverview();
      } catch (err) {
        toast(err.message, 'err');
      }
    });
  }

  const edf = root.querySelector('#modal-config-form');
  if (edf) {
    const tid = state.modal.tenant.id;
    edf.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(edf);
      let brainJson = null;
      const rawJson = String(fd.get('brainJsonText') || '').trim();
      if (rawJson) {
        try { brainJson = JSON.parse(rawJson); }
        catch (err) { toast(`Invalid Brain JSON: ${err.message}`, 'err'); return; }
      }
      try {
        await api(`/api/admin/tenants/${encodeURIComponent(tid)}`, {
          method: 'PATCH',
          body: {
            businessName: fd.get('businessName'),
            industry: fd.get('industry'),
            agencySystemPrompt: fd.get('agencySystemPrompt'),
            onboardingDone: Boolean(fd.get('onboardingDone')),
            aiConfig: {
              primaryModel: fd.get('primaryModel'),
              temperature: Number(fd.get('temperature')),
              maxOutputTokens: Number(fd.get('maxOutputTokens')),
              allowClientBrainEdit: Boolean(fd.get('allowClientBrainEdit'))
            },
            safety: {
              maxDailyOut: Number(fd.get('maxDailyOut')),
              maxHourlyOut: Number(fd.get('maxHourlyOut')),
              aiEnabled: Boolean(fd.get('aiEnabled')),
              voiceNotesEnabled: Boolean(fd.get('voiceNotesEnabled'))
            },
            ...(brainJson ? { brainJson, brainMode: 'replace' } : {})
          }
        });
        toast('Saved prompt & configuration (zero data lost).');
        state.modal = null;
        await refreshOverview();
      } catch (err) {
        toast(err.message, 'err');
      }
    });

    root.querySelector('#ed-wa-reconnect')?.addEventListener('click', async () => {
      try {
        await api(`/api/admin/tenants/${encodeURIComponent(tid)}/wa`, { method: 'POST', body: { action: 'connect' } });
        toast('Triggered WhatsApp reconnect.');
        await refreshOverview();
      } catch (err) { toast(err.message, 'err'); }
    });

    root.querySelector('#ed-clear-breaker')?.addEventListener('click', async () => {
      await api(`/api/admin/tenants/${encodeURIComponent(tid)}`, { method: 'PATCH', body: { clearCircuitBreaker: true } });
      toast('Circuit breaker cleared.');
      await refreshOverview();
    });

    root.querySelector('#ed-test-form')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = root.querySelector('#ed-test-btn');
      btn.disabled = true;
      try {
        state.testReply = await api(`/api/admin/tenants/${encodeURIComponent(tid)}/test-prompt`, {
          method: 'POST',
          body: {
            text: root.querySelector('#ed-test-input').value,
            agencySystemPrompt: root.querySelector('#ed-prompt').value,
            aiConfig: {
              primaryModel: root.querySelector('#ed-model').value,
              temperature: Number(root.querySelector('#ed-temp').value),
              maxOutputTokens: Number(root.querySelector('#ed-tokens').value)
            }
          }
        });
        render();
      } catch (err) {
        toast(err.message, 'err');
        btn.disabled = false;
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
