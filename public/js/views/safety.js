import { api, escHtml, toast } from '../api.js';
import { icon } from '../icons.js';

export function renderSafetyView(container, ctx) {
  let safety = null;
  let blacklist = [];
  let optedOut = [];
  let presets = {};
  let runtime = {};

  async function init() {
    container.innerHTML = `<div class="card"><span class="card-sub">Loading Guardrails &amp; Automations...</span></div>`;
    try {
      const res = await api('/api/safety');
      safety = res.safety;
      blacklist = res.blacklist || [];
      optedOut = res.optedOut || [];
      presets = res.warmupPresets || {};
      runtime = res.runtime || {};
      paint();
    } catch (err) {
      toast(err.message, 'err');
    }
  }

  function paint() {
    const breakerActive = runtime.circuitBreakerUntil && runtime.circuitBreakerUntil > Date.now();

    container.innerHTML = `
      <div class="row-between" style="margin-bottom:16px;">
        <div>
          <h2 style="font-size:18px;">Automations, Safety &amp; Anti-Ban Shield</h2>
          <div class="card-sub">Controls human takeover detection, voice/image understanding, warmup caps &amp; operating schedule.</div>
        </div>
        <button id="safety-save" class="btn-3d btn-3d-primary">${icon('check', 'icon-sm')}<span>Save Guardrails</span></button>
      </div>

      ${breakerActive ? `
        <div class="card" style="margin-bottom:14px;border-color:var(--amber-border);background:var(--amber-tint);">
          <div class="row-between">
            <div>
              <div style="font-weight:600;color:var(--amber);">Circuit Breaker Active</div>
              <div style="font-size:12px;">${escHtml(runtime.circuitReason || 'Temporary rate protection cooldown')}</div>
            </div>
            <button id="clear-breaker" class="btn-3d btn-3d-secondary btn-sm">Clear Cooldown</button>
          </div>
        </div>
      ` : ''}

      <div class="equal-col" style="margin-bottom:14px;">
        <div class="card">
          <div class="card-title" style="margin-bottom:12px;">Core AI &amp; WhatsApp Behaviors</div>
          <div style="display:flex;flex-direction:column;gap:12px;">
            ${toggleRow('s-aiEnabled', 'Master AI Auto-Responder', 'When OFF, Inbox stays live but AI sends zero WhatsApp replies', safety.aiEnabled)}
            ${toggleRow('s-voice', 'Voice Note Understanding (Gemini)', 'Listens & transcribes WhatsApp audio in RAM (zero DB audio stored; >90s held for team)', safety.voiceNotesEnabled !== false)}
            ${toggleRow('s-image', 'Photo & Receipt Vision', 'Reads photos/screenshots safely (never auto-confirms UPI payment receipts)', safety.imageVisionEnabled !== false)}
            ${toggleRow('s-read', 'Smart Read Receipts (Blue Ticks)', 'Marks read ONLY when replying; keeps unknown/off-topic chats unseen on your phone!', safety.readReceipts !== false)}
            ${toggleRow('s-phatic', 'Closure Emoji Reactions (👍)', 'Reacts 👍 to closing "Ok / Thanks" replies at zero AI cost', safety.phaticReactionEnabled !== false)}
            ${toggleRow('s-quote', 'Smart Context Quoting', 'Auto-quotes ONLY on multi-message bursts (3+), >30s delays, or group chats', safety.quoteReplies !== false)}
            ${toggleRow('s-split', '2-Bubble Human Delivery', 'Splits answers from follow-up qualifying questions with realistic typing cadence', safety.splitLongReplies !== false)}
          </div>
        </div>

        <div class="card">
          <div class="card-title" style="margin-bottom:12px;">Alerts, Revival &amp; Warmup Caps</div>
          <div style="display:flex;flex-direction:column;gap:10px;margin-bottom:12px;">
            ${toggleRow('s-hotAlert', 'Instant Hot-Lead & Booking WhatsApp Alerts', 'Pings your Note-to-Self (or Owner Phone below) once when hot lead or slot locks', safety.hotLeadAlertEnabled !== false)}
            ${toggleRow('s-followup', 'Safe 1-Shot Ghosted-Inquiry Revival', 'Sends 1 gentle check-in after inactivity during business hours only', Boolean(safety.followUpEnabled))}
            ${toggleRow('s-digest', 'Daily Evening Summary Digest', 'Sends 1 daily tally to your WhatsApp Note-to-Self at configured hour', Boolean(safety.dailyDigestEnabled))}
          </div>
          <div class="equal-col" style="gap:10px;">
            <div class="field">
              <label>Owner Alert WhatsApp (blank = Note-to-Self)</label>
              <input id="s-ownerPhone" class="input mono" placeholder="Leave blank for Note-to-Self" value="${escHtml(safety.ownerAlertPhone || '')}" />
            </div>
            <div class="field">
              <label>Revival Wait &amp; Digest Hour</label>
              <div class="row-gap">
                <select id="s-followupHrs" class="select">
                  ${[2, 4, 6, 12].map((h) => `<option value="${h}" ${Number(safety.followUpDelayHours || 4) === h ? 'selected' : ''}>After ${h}h</option>`).join('')}
                </select>
                <select id="s-digestHour" class="select">
                  ${[18, 19, 20, 21, 22].map((hr) => `<option value="${hr}" ${Number(safety.dailyDigestHour ?? 20) === hr ? 'selected' : ''}>${hr}:00</option>`).join('')}
                </select>
              </div>
            </div>
          </div>
          <div class="field">
            <label>Owner-Reply Auto-Pause Duration (when you reply from phone/desktop)</label>
            <select id="s-takeover" class="select">
              ${[
                { v: 15, l: '15 Minutes' },
                { v: 30, l: '30 Minutes (Recommended)' },
                { v: 60, l: '1 Hour' },
                { v: 120, l: '2 Hours' },
                { v: 0, l: 'Until Manually Resumed' }
              ].map((o) => `<option value="${o.v}" ${Number(safety.takeoverMinutes) === o.v ? 'selected' : ''}>${o.l}</option>`).join('')}
            </select>
          </div>
          <div class="equal-col" style="gap:10px;">
            <div class="field">
              <label>Warmup Safety Tier</label>
              <select id="s-warmup" class="select">
                ${Object.entries(presets).map(([k, p]) => `<option value="${k}" ${safety.warmupTier === k ? 'selected' : ''}>${escHtml(p.label)} (${p.maxDailyOut}/d)</option>`).join('')}
                <option value="custom" ${safety.warmupTier === 'custom' ? 'selected' : ''}>Custom Limits</option>
              </select>
            </div>
            <div class="field">
              <label>Group Chats Policy</label>
              <select id="s-groups" class="select">
                <option value="ignore_all" ${safety.groupMode === 'ignore_all' ? 'selected' : ''}>Ignore All Groups (Lowest RAM)</option>
                <option value="mentions_only" ${safety.groupMode === 'mentions_only' ? 'selected' : ''}>Reply Only When @Mentioned / !ai</option>
              </select>
            </div>
            <div class="field"><label>Max Daily AI Replies</label><input id="s-daily" type="number" class="input mono" value="${safety.maxDailyOut || 90}" /></div>
            <div class="field"><label>Debounce Wait (ms)</label><input id="s-debounce" type="number" class="input mono" value="${safety.debounceMs || 1800}" /></div>
          </div>
          <div class="field" style="margin-bottom:0;">
            <label>Hot Lead Webhook URL (Zapier / Make / CRM POST)</label>
            <input id="s-webhook" class="input mono" placeholder="https://hooks.zapier.com/..." value="${escHtml(safety.webhookUrl || '')}" />
          </div>
        </div>
      </div>

      <div class="equal-col">
        <div class="card">
          <div class="card-title" style="margin-bottom:12px;">Business Hours &amp; Operating Mode</div>
          <div class="equal-col" style="gap:10px;">
            <div class="field">
              <label>Schedule Mode</label>
              <select id="s-opmode" class="select">
                <option value="always" ${safety.operatingMode === 'always' ? 'selected' : ''}>24/7 AI Active</option>
                <option value="business_hours" ${safety.operatingMode === 'business_hours' ? 'selected' : ''}>Active During Business Hours Only</option>
                <option value="after_hours_only" ${safety.operatingMode === 'after_hours_only' ? 'selected' : ''}>After-Hours Only (Nights &amp; Weekends)</option>
              </select>
            </div>
            <div class="field">
              <label>Timezone (IANA)</label>
              <input id="s-tz" class="input mono" value="${escHtml(safety.timezone || 'Asia/Kolkata')}" />
            </div>
          </div>
          ${toggleRow('s-sendAway', 'Send Deduplicated Away Reply Outside Hours', 'At most 1 reply per customer every 12h', safety.sendAwayMessage)}
          <div class="field" style="margin-top:10px;margin-bottom:0;">
            <label>Away Message</label>
            <textarea id="s-awayMsg" class="textarea" rows="2">${escHtml(safety.awayMessage || '')}</textarea>
          </div>
        </div>

        <div class="card">
          <div class="card-title" style="margin-bottom:12px;">VIP / Family Blocklist &amp; Opt-Outs</div>
          <form id="bl-add-form" class="row-gap" style="margin-bottom:12px;">
            <input id="bl-phone" class="input mono" placeholder="Phone digits e.g. 919876543210" required />
            <input id="bl-label" class="input" placeholder="Label (e.g. Owner Mom)" />
            <button type="submit" class="btn-3d btn-3d-secondary btn-sm">${icon('plus', 'icon-sm')}</button>
          </form>
          <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:14px;">
            ${blacklist.length === 0 ? `<span class="card-sub">No blocked numbers.</span>` : blacklist.map((b, i) => `
              <span class="pill">
                <span class="mono">${escHtml(b.ref)}</span>
                <span class="muted">(${escHtml(b.label)})</span>
                <button type="button" class="del-bl" data-idx="${i}" style="background:none;border:none;color:var(--ink-muted);cursor:pointer;padding:0;">&times;</button>
              </span>
            `).join('')}
          </div>

          <div class="card-sub" style="margin-bottom:6px;">Opted-Out Contacts (${optedOut.length})</div>
          <div style="display:flex;flex-wrap:wrap;gap:6px;">
            ${optedOut.map((o) => `
              <span class="pill pill-rose">
                <span class="mono">${escHtml(o.phoneNumber || o.displayName)}</span>
                <button type="button" class="re-optin" data-id="${escHtml(o._id)}" style="background:none;border:none;color:inherit;cursor:pointer;text-decoration:underline;font-size:11px;">Resume</button>
              </span>
            `).join('')}
          </div>
        </div>
      </div>
    `;

    container.querySelector('#s-warmup').addEventListener('change', (e) => {
      const p = presets[e.target.value];
      if (p) container.querySelector('#s-daily').value = p.maxDailyOut;
    });

    container.querySelector('#bl-add-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const ref = container.querySelector('#bl-phone').value.trim();
      const label = container.querySelector('#bl-label').value.trim() || 'Excluded';
      if (ref) blacklist.push({ ref, label });
      paint();
    });

    container.querySelectorAll('.del-bl').forEach((b) => {
      b.addEventListener('click', () => {
        blacklist.splice(Number(b.dataset.idx), 1);
        paint();
      });
    });

    container.querySelectorAll('.re-optin').forEach((b) => {
      b.addEventListener('click', async () => {
        await api(`/api/conversations/${encodeURIComponent(b.dataset.id)}`, { method: 'PATCH', body: { action: 'resume' } });
        toast('Contact re-enabled.');
        init();
      });
    });

    container.querySelector('#clear-breaker')?.addEventListener('click', async () => {
      await api('/api/safety', { method: 'PUT', body: { clearCircuitBreaker: true } });
      toast('Cooldown cleared.');
      init();
    });

    container.querySelector('#safety-save').addEventListener('click', async () => {
      const nextSafety = {
        ...safety,
        aiEnabled: container.querySelector('#s-aiEnabled').checked,
        voiceNotesEnabled: container.querySelector('#s-voice').checked,
        imageVisionEnabled: container.querySelector('#s-image').checked,
        readReceipts: container.querySelector('#s-read').checked,
        phaticReactionEnabled: container.querySelector('#s-phatic').checked,
        quoteReplies: container.querySelector('#s-quote').checked,
        splitLongReplies: container.querySelector('#s-split').checked,
        hotLeadAlertEnabled: container.querySelector('#s-hotAlert').checked,
        ownerAlertPhone: container.querySelector('#s-ownerPhone').value.trim(),
        followUpEnabled: container.querySelector('#s-followup').checked,
        followUpDelayHours: Number(container.querySelector('#s-followupHrs').value),
        dailyDigestEnabled: container.querySelector('#s-digest').checked,
        dailyDigestHour: Number(container.querySelector('#s-digestHour').value),
        takeoverMinutes: Number(container.querySelector('#s-takeover').value),
        warmupTier: container.querySelector('#s-warmup').value,
        groupMode: container.querySelector('#s-groups').value,
        maxDailyOut: Number(container.querySelector('#s-daily').value),
        debounceMs: Number(container.querySelector('#s-debounce').value),
        webhookUrl: container.querySelector('#s-webhook').value,
        operatingMode: container.querySelector('#s-opmode').value,
        timezone: container.querySelector('#s-tz').value,
        sendAwayMessage: container.querySelector('#s-sendAway').checked,
        awayMessage: container.querySelector('#s-awayMsg').value
      };
      try {
        await api('/api/safety', { method: 'PUT', body: { safety: nextSafety, blacklist } });
        ctx.user.aiEnabled = nextSafety.aiEnabled;
        ctx.syncStatusUi?.();
        toast('Safety & automation rules saved.');
      } catch (err) {
        toast(err.message, 'err');
      }
    });
  }

  function toggleRow(id, title, sub, checked) {
    return `
      <div class="row-between" style="padding:8px 10px;background:var(--bg-inset);border:1px solid var(--border-hairline);border-radius:8px;">
        <div>
          <div style="font-size:13px;font-weight:500;">${escHtml(title)}</div>
          <div class="card-sub" style="font-size:11px;">${escHtml(sub)}</div>
        </div>
        <label class="switch"><input id="${id}" type="checkbox" ${checked ? 'checked' : ''} /><span class="slider"></span></label>
      </div>
    `;
  }

  init();
  return null;
}
