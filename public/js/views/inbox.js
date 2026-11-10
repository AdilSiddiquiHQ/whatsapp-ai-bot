import { api, escHtml, formatWhatsAppHtml, formatClock, relativeTime, toast } from '../api.js';
import { icon } from '../icons.js';

export function renderInboxView(container, ctx) {
  let filter = 'all';
  let searchQ = '';
  let threads = [];
  let selectedId = ctx.initialConvId || null;
  let activeThread = null;
  let activeMessages = [];
  let activeLead = null;
  let quickReplies = [];
  let inspectorTab = 'preview'; // preview | contact
  let sandboxMsgs = [
    { role: 'assistant', text: 'Live Sandbox Ready. Ask any customer question to test your prices, FAQs & AI rules before going live.', meta: 'simulator' }
  ];

  async function init() {
    container.innerHTML = `<div class="card"><span class="card-sub">Loading Unified Inbox...</span></div>`;
    try {
      const [convRes, brainRes] = await Promise.all([
        api(`/api/conversations?filter=${encodeURIComponent(filter)}&q=${encodeURIComponent(searchQ)}`),
        api('/api/brain')
      ]);
      threads = convRes.conversations || [];
      quickReplies = brainRes.quickReplies || [];
      if (!selectedId && threads.length > 0) selectedId = threads[0]._id;
      if (selectedId) await loadThread(selectedId, false);
      paint();
    } catch (err) {
      toast(err.message, 'err');
    }
  }

  async function loadThreadsOnly() {
    const res = await api(`/api/conversations?filter=${encodeURIComponent(filter)}&q=${encodeURIComponent(searchQ)}`);
    threads = res.conversations || [];
  }

  async function loadThread(convId, shouldPaint = true) {
    try {
      const res = await api(`/api/conversations/${encodeURIComponent(convId)}/messages`);
      selectedId = convId;
      activeThread = res.conversation;
      activeMessages = res.messages || [];
      activeLead = res.lead;
      if (shouldPaint) paint();
    } catch (err) {
      toast(err.message, 'err');
    }
  }

  function isPausedNow(c) {
    if (!c) return false;
    return c.pausedUntil && new Date(c.pausedUntil).getTime() > Date.now();
  }

  function paint() {
    const paused = isPausedNow(activeThread);
    const pauseMinsLeft = paused ? Math.max(1, Math.round((new Date(activeThread.pausedUntil).getTime() - Date.now()) / 60000)) : 0;

    container.innerHTML = `
      <div class="inbox-grid">
        <!-- Column 1: Conversations List -->
        <div class="inbox-col">
          <div style="padding:10px;border-bottom:1px solid var(--border-hairline);">
            <div class="input-wrap" style="margin-bottom:8px;">
              <input id="inbox-search" class="input" style="padding-left:30px;height:34px;" placeholder="Search name or phone..." value="${escHtml(searchQ)}" />
              <span style="position:absolute;left:9px;top:9px;color:var(--ink-muted);">${icon('search', 'icon-sm')}</span>
            </div>
            <div class="row-gap" style="flex-wrap:wrap;">
              ${['all', 'active', 'paused', 'opted_out'].map((f) => `
                <button class="chip ${filter === f ? 'active' : ''}" data-filter="${f}">
                  ${f === 'all' ? 'All' : f === 'active' ? 'AI Active' : f === 'paused' ? 'Paused' : 'Opted Out'}
                </button>
              `).join('')}
            </div>
          </div>

          <div class="thread-scroll">
            ${threads.length === 0 ? `
              <div style="padding:28px 14px;text-align:center;" class="card-sub">
                No WhatsApp chats yet. Once customers message your linked WhatsApp number, threads appear here in real time.
              </div>
            ` : threads.map((t) => {
              const p = isPausedNow(t);
              const active = t._id === selectedId;
              return `
                <div class="thread-item ${active ? 'active' : ''}" data-conv-id="${escHtml(t._id)}">
                  <div class="row-between" style="margin-bottom:2px;">
                    <div class="row-gap" style="min-width:0;">
                      <span class="dot ${t.optedOut ? 'dot-rose' : p ? 'dot-amber' : 'dot-emerald'}"></span>
                      <span style="font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escHtml(t.displayName || t.phoneNumber)}</span>
                    </div>
                    <span class="tabular muted" style="font-size:11px;">${relativeTime(t.lastMessageAt)}</span>
                  </div>
                  <div class="mono muted" style="font-size:11px;margin-bottom:3px;">${escHtml(t.phoneNumber || t.externalRef)} &middot; WA</div>
                  <div class="row-between">
                    <span class="card-sub" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escHtml(t.lastMessagePreview || '')}</span>
                    ${t.unreadCount > 0 ? `<span class="pill pill-emerald tabular" style="padding:1px 6px;font-size:10px;">${t.unreadCount}</span>` : ''}
                  </div>
                </div>
              `;
            }).join('')}
          </div>
        </div>

        <!-- Column 2: Active Chat Stream -->
        <div class="inbox-col">
          ${activeThread ? `
            <div style="padding:10px 14px;border-bottom:1px solid var(--border-hairline);background:var(--bg-chrome);" class="row-between">
              <div>
                <div class="row-gap">
                  <span style="font-weight:600;font-size:14px;">${escHtml(activeThread.displayName || activeThread.phoneNumber)}</span>
                  <span class="pill pill-emerald" style="font-size:10px;">WhatsApp</span>
                  ${activeThread.optedOut
                    ? `<span class="pill pill-rose">Opted Out</span>`
                    : paused
                      ? `<span class="pill pill-amber">AI Paused (${pauseMinsLeft > 1000 ? 'Manual' : `${pauseMinsLeft}m`})</span>`
                      : `<span class="pill pill-emerald">AI Active</span>`}
                </div>
                <div class="mono muted" style="font-size:11px;margin-top:2px;">${escHtml(activeThread.phoneNumber || activeThread.externalRef)}</div>
              </div>
              <div class="row-gap">
                ${paused || activeThread.optedOut
                  ? `<button id="btn-resume-ai" class="btn-3d btn-3d-primary btn-sm">${icon('play', 'icon-sm')}<span>Resume AI</span></button>`
                  : `<button id="btn-pause-ai" class="btn-3d btn-3d-secondary btn-sm">${icon('pause', 'icon-sm')}<span>Pause AI</span></button>`}
                <button id="btn-block-ai" class="btn-3d btn-3d-secondary btn-sm" title="Never auto-reply to this contact">${icon('ban', 'icon-sm')}</button>
              </div>
            </div>

            <div id="chat-stream" class="chat-scroll">
              ${activeMessages.map((m) => {
                const isCustomer = m.dir === 'in';
                const cls = isCustomer ? 'in' : m.senderType === 'ai' ? 'out out-ai' : 'out out-human';
                const who = isCustomer ? (activeThread.displayName || 'Customer')
                  : m.senderType === 'ai' ? `AI${m.model ? ` · ${m.model}` : ''}${m.latencyMs ? ` · ${m.latencyMs}ms` : ''}`
                  : m.senderType === 'owner_app' ? 'You (WhatsApp Phone)' : 'You (Dashboard)';
                return `
                  <div class="bubble-row ${cls}">
                    <div class="bubble">${formatWhatsAppHtml(m.text)}</div>
                    <div class="bubble-meta tabular">
                      <span>${escHtml(who)}</span>
                      <span>&middot;</span>
                      <span>${formatClock(m.createdAt)}</span>
                      ${!isCustomer ? `<span style="color:var(--sky);">${icon('doubleTick', 'icon-sm')}</span>` : ''}
                    </div>
                  </div>
                `;
              }).join('')}
            </div>

            <form id="manual-reply-form" class="composer">
              ${quickReplies.length > 0 ? `
                <div class="quick-strip">
                  ${quickReplies.map((q) => `<button type="button" class="chip qr-chip" data-body="${escHtml(q.body)}">${escHtml(q.title)}</button>`).join('')}
                </div>
              ` : ''}
              <div class="row-gap">
                <input id="manual-reply-input" class="input" placeholder="Send manual WhatsApp reply (auto-pauses AI)..." />
                <button type="submit" id="manual-send-btn" class="btn-3d btn-3d-primary">${icon('send', 'icon-sm')}<span>Send</span></button>
              </div>
            </form>
          ` : `
            <div style="flex:1;display:flex;align-items:center;justify-content:center;padding:30px;text-align:center;">
              <div>
                <div style="color:var(--ink-muted);margin-bottom:8px;">${icon('inbox', 'icon-lg')}</div>
                <div style="font-weight:500;">Select a WhatsApp Conversation</div>
                <div class="card-sub" style="margin-top:4px;">Or test your AI right now using the Live Preview pane &rarr;</div>
              </div>
            </div>
          `}
        </div>

        <!-- Column 3: Right Inspector (Live Web Preview + Contact Card) -->
        <div class="inbox-col inspector">
          <div style="padding:10px 12px;border-bottom:1px solid var(--border-hairline);background:var(--bg-chrome);" class="row-between">
            <div class="row-gap">
              <button id="insp-tab-preview" class="chip ${inspectorTab === 'preview' ? 'active' : ''}">${icon('spark', 'icon-sm')} Live Preview</button>
              <button id="insp-tab-contact" class="chip ${inspectorTab === 'contact' ? 'active' : ''}">${icon('userCheck', 'icon-sm')} Contact</button>
            </div>
            ${inspectorTab === 'preview'
              ? `<button id="sbx-reset" class="btn-3d btn-3d-secondary btn-sm" title="Reset Sandbox">${icon('refresh', 'icon-sm')}</button>`
              : ''}
          </div>

          ${inspectorTab === 'preview' ? `
            <div id="sbx-scroll" class="chat-scroll" style="background:var(--bg-inset);">
              ${sandboxMsgs.map((m) => `
                <div class="bubble-row ${m.role === 'user' ? 'out out-human' : 'in'}">
                  <div class="bubble">${formatWhatsAppHtml(m.text)}</div>
                  ${m.meta ? `<div class="bubble-meta tabular">${escHtml(m.meta)}</div>` : ''}
                </div>
              `).join('')}
            </div>
            <div class="composer">
              <div class="quick-strip">
                <button type="button" class="chip sbx-prompt" data-msg="What are your prices?">Prices</button>
                <button type="button" class="chip sbx-prompt" data-msg="What are your timings?">Hours</button>
                <button type="button" class="chip sbx-prompt" data-msg="I want to book, please share details">Booking</button>
              </div>
              <form id="sbx-form" class="row-gap">
                <input id="sbx-input" class="input" placeholder="Test AI reply..." required />
                <button type="submit" id="sbx-send" class="btn-3d btn-3d-primary btn-sm">${icon('send', 'icon-sm')}</button>
              </form>
            </div>
          ` : `
            <div class="inspector-scroll" style="padding:14px;">
              ${activeThread ? `
                <div class="field">
                  <label>Lead Pipeline Stage</label>
                  <select id="insp-stage" class="select">
                    ${['new', 'qualified', 'booked', 'resolved'].map((st) => `<option value="${st}" ${activeThread.stage === st ? 'selected' : ''}>${st.toUpperCase()}</option>`).join('')}
                  </select>
                </div>
                ${activeLead ? `
                  <div style="padding:10px;background:var(--bg-inset);border:1px solid var(--border-hairline);border-radius:8px;margin-bottom:14px;">
                    <div class="row-between" style="margin-bottom:4px;">
                      <span class="card-sub">Captured Lead</span>
                      <span class="pill pill-emerald tabular">${escHtml(activeLead.score || 'warm')}</span>
                    </div>
                    <div style="font-size:12px;"><strong>Intent:</strong> ${escHtml(activeLead.intent || '—')}</div>
                    ${activeLead.budget ? `<div style="font-size:12px;"><strong>Budget:</strong> ${escHtml(activeLead.budget)}</div>` : ''}
                  </div>
                ` : ''}
                <div class="field">
                  <label>Tags (comma separated)</label>
                  <input id="insp-tags" class="input" value="${escHtml((activeThread.tags || []).join(', '))}" placeholder="vip, urgent" />
                </div>
                <div class="field">
                  <label>Internal Team Notes (Private)</label>
                  <textarea id="insp-notes" class="textarea" placeholder="Add private notes...">${escHtml(activeThread.notes || '')}</textarea>
                </div>
                <div class="row-gap">
                  <button id="insp-save" class="btn-3d btn-3d-primary btn-sm" style="flex:1;">Save Details</button>
                  <button id="insp-delete" class="btn-3d btn-3d-danger btn-sm" title="Delete thread">${icon('trash', 'icon-sm')}</button>
                </div>
              ` : `<div class="card-sub">Select a conversation to view contact profile &amp; notes.</div>`}
            </div>
          `}
        </div>
      </div>
    `;

    // Auto-scroll streams to bottom
    const cs = container.querySelector('#chat-stream');
    if (cs) cs.scrollTop = cs.scrollHeight;
    const ss = container.querySelector('#sbx-scroll');
    if (ss) ss.scrollTop = ss.scrollHeight;

    // Bind filter & search
    container.querySelector('#inbox-search')?.addEventListener('change', async (e) => {
      searchQ = e.target.value;
      await loadThreadsOnly();
      paint();
    });
    container.querySelectorAll('[data-filter]').forEach((b) => {
      b.addEventListener('click', async () => {
        filter = b.dataset.filter;
        await loadThreadsOnly();
        paint();
      });
    });
    container.querySelectorAll('[data-conv-id]').forEach((el) => {
      el.addEventListener('click', () => loadThread(el.dataset.convId, true));
    });

    // Pause / Resume / Block AI
    const runThreadPatch = async (body, okMsg) => {
      try {
        const res = await api(`/api/conversations/${encodeURIComponent(selectedId)}`, { method: 'PATCH', body });
        activeThread = res.conversation;
        toast(okMsg);
        paint();
      } catch (err) { toast(err.message, 'err'); }
    };
    container.querySelector('#btn-pause-ai')?.addEventListener('click', () => runThreadPatch({ action: 'pause', minutes: 30 }, 'AI paused for 30m.'));
    container.querySelector('#btn-resume-ai')?.addEventListener('click', () => runThreadPatch({ action: 'resume' }, 'AI resumed for this contact.'));
    container.querySelector('#btn-block-ai')?.addEventListener('click', () => runThreadPatch({ action: 'block' }, 'Contact added to Do-Not-Automate blocklist.'));

    // Quick Replies & Manual Reply
    container.querySelectorAll('.qr-chip').forEach((c) => {
      c.addEventListener('click', () => {
        const inp = container.querySelector('#manual-reply-input');
        if (inp) { inp.value = c.dataset.body; inp.focus(); }
      });
    });

    container.querySelector('#manual-reply-form')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const inp = container.querySelector('#manual-reply-input');
      const txt = inp.value.trim();
      if (!txt) return;
      const btn = container.querySelector('#manual-send-btn');
      btn.disabled = true;
      try {
        await api(`/api/conversations/${encodeURIComponent(selectedId)}/reply`, { method: 'POST', body: { text: txt } });
        inp.value = '';
        await loadThread(selectedId, true);
      } catch (err) {
        toast(err.message, 'err');
        btn.disabled = false;
      }
    });

    // Inspector Tabs
    container.querySelector('#insp-tab-preview')?.addEventListener('click', () => { inspectorTab = 'preview'; paint(); });
    container.querySelector('#insp-tab-contact')?.addEventListener('click', () => { inspectorTab = 'contact'; paint(); });

    container.querySelector('#insp-save')?.addEventListener('click', async () => {
      const stage = container.querySelector('#insp-stage').value;
      const tags = container.querySelector('#insp-tags').value.split(',').map((s) => s.trim()).filter(Boolean);
      const notes = container.querySelector('#insp-notes').value;
      await runThreadPatch({ stage, tags, notes }, 'Contact notes saved.');
    });

    container.querySelector('#insp-delete')?.addEventListener('click', async () => {
      try {
        await api(`/api/conversations/${encodeURIComponent(selectedId)}`, { method: 'DELETE' });
        selectedId = null;
        activeThread = null;
        await loadThreadsOnly();
        if (threads.length > 0) await loadThread(threads[0]._id, false);
        toast('Conversation removed.');
        paint();
      } catch (err) { toast(err.message, 'err'); }
    });

    // Live Preview Sandbox
    container.querySelectorAll('.sbx-prompt').forEach((b) => {
      b.addEventListener('click', () => runSandboxPrompt(b.dataset.msg));
    });
    container.querySelector('#sbx-form')?.addEventListener('submit', (e) => {
      e.preventDefault();
      const inp = container.querySelector('#sbx-input');
      const val = inp.value.trim();
      if (!val) return;
      inp.value = '';
      runSandboxPrompt(val);
    });
    container.querySelector('#sbx-reset')?.addEventListener('click', async () => {
      await api('/api/sandbox/reset', { method: 'DELETE' });
      sandboxMsgs = [{ role: 'assistant', text: 'Sandbox memory cleared. Send a test message below.', meta: 'reset' }];
      paint();
    });
  }

  async function runSandboxPrompt(txt) {
    sandboxMsgs.push({ role: 'user', text: txt, meta: 'now' });
    paint();
    try {
      const res = await api('/api/sandbox/chat', { method: 'POST', body: { text: txt } });
      sandboxMsgs.push({ role: 'assistant', text: res.reply, meta: `${res.model} · ${res.latencyMs}ms` });
    } catch (err) {
      sandboxMsgs.push({ role: 'assistant', text: `Error: ${err.message}`, meta: 'error' });
    }
    paint();
  }

  init();

  // Live SSE updates into Inbox!
  return async (eventType, payload) => {
    if (eventType === 'inbox_msg') {
      await loadThreadsOnly().catch(() => {});
      if (payload.conversationId === selectedId && payload.message) {
        activeMessages.push(payload.message);
        if (payload.aiStatus && activeThread) {
          activeThread.aiStatus = payload.aiStatus;
          activeThread.pausedUntil = payload.pausedUntil;
        }
      }
      paint();
    }
  };
}
