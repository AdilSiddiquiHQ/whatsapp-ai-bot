import { api, escHtml, toast } from '../api.js';
import { icon } from '../icons.js';

export function renderOnboarding(container, ctx) {
  let mode = 'qr'; // qr | pairing
  let pairingCode = ctx.user.pairingCode || '';
  let unlockedFired = false;

  function paint() {
    const waStatus = ctx.user.waStatus || 'disconnected';
    const qrUrl = ctx.user.qrDataUrl || '';

    // Strict WhatsApp-only gate: unlocks automatically once WhatsApp connects!
    if (waStatus === 'open' && !unlockedFired) {
      unlockedFired = true;
      setTimeout(() => ctx.onOnboardingDone(), 900);
    }

    container.innerHTML = `
      <div class="auth-stage" style="align-items:center;padding:24px;">
        <div style="width:100%;max-width:500px;">
          ${ctx.user.impersonating ? `
            <div class="impersonate-bar" style="border-radius:10px;margin-bottom:14px;border:1px solid var(--amber-border);">
              <span>Admin View &middot; ${escHtml(ctx.user.businessName)}</span>
              <button id="ob-admin-bypass" class="btn-3d btn-3d-secondary btn-sm">Preview Dashboard</button>
            </div>
          ` : ''}

          <div class="card" style="padding:28px;">
            <div class="row-between" style="margin-bottom:18px;">
              <div class="row-gap">
                <div class="brand-mark">${icon('logo', 'icon-lg')}</div>
                <div>
                  <h1 style="font-size:19px;">Link Your WhatsApp</h1>
                  <div class="card-sub">${escHtml(ctx.user.businessName || ctx.user.username)} &middot; Required to unlock workspace</div>
                </div>
              </div>
              ${waStatus === 'open'
                ? `<span class="pill pill-emerald"><span class="dot dot-emerald"></span>Connected</span>`
                : waStatus === 'qr_ready'
                  ? `<span class="pill pill-amber"><span class="dot dot-amber"></span>Scan Now</span>`
                  : `<span class="pill"><span class="dot dot-muted"></span>${escHtml(waStatus)}</span>`}
            </div>

            ${waStatus === 'open' ? `
              <div style="padding:34px 20px;text-align:center;background:var(--bg-inset);border:1px solid var(--emerald-border);border-radius:12px;">
                <div style="color:var(--emerald);margin-bottom:10px;">${icon('check', 'icon-lg')}</div>
                <div style="font-weight:600;font-size:16px;">WhatsApp Connected!</div>
                <div class="mono" style="color:var(--ink-secondary);margin-top:4px;">${escHtml(ctx.user.waPhone || 'Active')}</div>
                <div class="card-sub" style="margin-top:10px;">Opening your AI Inbox &amp; Dashboard...</div>
              </div>
            ` : `
              <div class="row-gap" style="margin-bottom:14px;">
                <button id="ob-mode-qr" class="chip ${mode === 'qr' ? 'active' : ''}">${icon('qr', 'icon-sm')} Scan QR Code</button>
                <button id="ob-mode-pair" class="chip ${mode === 'pairing' ? 'active' : ''}">${icon('phone', 'icon-sm')} Link with Phone Number</button>
              </div>

              ${mode === 'qr' ? `
                <div style="text-align:center;padding:18px;background:var(--bg-inset);border-radius:12px;border:1px solid var(--border-hairline);">
                  ${qrUrl ? `
                    <div class="qr-frame"><img src="${qrUrl}" alt="WhatsApp QR Code" /></div>
                    <div style="text-align:left;margin-top:14px;font-size:12px;color:var(--ink-secondary);line-height:1.6;">
                      1. Open <strong>WhatsApp</strong> on your phone<br/>
                      2. Tap <strong>Settings</strong> or <strong>&vellip; Menu</strong> &rarr; <strong>Linked Devices</strong><br/>
                      3. Tap <strong>Link a Device</strong> and scan this code
                    </div>
                  ` : `
                    <div style="padding:40px 16px;">
                      <p class="card-sub" style="margin-bottom:14px;">Runs 24/7 in cloud even after closing this tab.</p>
                      <button id="ob-gen-qr" class="btn-3d btn-3d-primary btn-lg">${icon('qr', 'icon-sm')}<span>Generate Live QR</span></button>
                    </div>
                  `}
                </div>
              ` : `
                <div style="padding:18px;background:var(--bg-inset);border-radius:12px;border:1px solid var(--border-hairline);">
                  <form id="ob-pair-form">
                    <div class="field">
                      <label>WhatsApp Phone Number (with country code, e.g. 91...)</label>
                      <input id="ob-phone-input" class="input mono" placeholder="919876543210" required />
                    </div>
                    <button type="submit" id="ob-pair-btn" class="btn-3d btn-3d-primary btn-full">${icon('phone', 'icon-sm')}<span>Get 8-Digit Pairing Code</span></button>
                  </form>
                  ${pairingCode ? `
                    <div class="pairing-display">${escHtml(pairingCode)}</div>
                    <div class="card-sub" style="text-align:center;">WhatsApp &rarr; Linked Devices &rarr; Link a Device &rarr; <strong>Link with phone number instead</strong></div>
                  ` : ''}
                </div>
              `}

              <div style="margin-top:14px;padding:10px 12px;border-radius:8px;border:1px dashed var(--border-medium);background:var(--bg-inset);display:flex;justify-content:space-between;align-items:center;">
                <span class="card-sub" style="font-size:11px;">Instagram &amp; Facebook Messenger</span>
                <span class="pill" style="font-size:10px;">Unlocks in Phase 2</span>
              </div>
            `}
          </div>
        </div>
      </div>
    `;

    container.querySelector('#ob-admin-bypass')?.addEventListener('click', () => ctx.onOnboardingDone());
    container.querySelector('#ob-mode-qr')?.addEventListener('click', () => { mode = 'qr'; paint(); });
    container.querySelector('#ob-mode-pair')?.addEventListener('click', () => { mode = 'pairing'; paint(); });

    container.querySelector('#ob-gen-qr')?.addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      btn.textContent = 'Generating QR...';
      try {
        await api('/api/wa/connect', { method: 'POST' });
        toast('Connecting to WhatsApp...');
      } catch (err) {
        toast(err.message, 'err');
        btn.disabled = false;
        paint();
      }
    });

    container.querySelector('#ob-pair-form')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = container.querySelector('#ob-pair-btn');
      btn.disabled = true;
      const phone = container.querySelector('#ob-phone-input').value;
      try {
        const res = await api('/api/wa/pairing-code', { method: 'POST', body: { phone } });
        pairingCode = res.code;
        toast('8-digit pairing code ready.');
        paint();
      } catch (err) {
        toast(err.message, 'err');
        btn.disabled = false;
      }
    });
  }

  paint();

  return (eventType, data) => {
    if (eventType === 'wa_qr' || eventType === 'wa_status') {
      if (data.status) ctx.user.waStatus = data.status;
      if (data.qrDataUrl !== undefined) ctx.user.qrDataUrl = data.qrDataUrl;
      if (data.waPhone) ctx.user.waPhone = data.waPhone;
      if (data.pairingCode !== undefined) pairingCode = data.pairingCode || pairingCode;
      paint();
    }
  };
}
