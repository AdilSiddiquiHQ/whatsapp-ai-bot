import { api, escHtml, toast } from '../api.js';
import { icon } from '../icons.js';

export function renderOnboarding(container, ctx) {
  let mode = 'qr'; // qr | pairing
  let pairingCode = ctx.user.pairingCode || '';

  async function paint() {
    const waStatus = ctx.user.waStatus || 'disconnected';
    const qrUrl = ctx.user.qrDataUrl || '';

    container.innerHTML = `
      <div class="auth-stage" style="align-items:flex-start;padding-top:42px;">
        <div style="width:100%;max-width:920px;">
          <div class="row-between" style="margin-bottom:22px;">
            <div class="row-gap">
              <div class="brand-mark">${icon('logo', 'icon-lg')}</div>
              <div>
                <h1 style="font-size:21px;">Welcome, ${escHtml(ctx.user.businessName || ctx.user.username)}</h1>
                <div class="card-sub">Step 1 of 2 &middot; Link WhatsApp &amp; set up your AI assistant</div>
              </div>
            </div>
            <button id="ob-skip" class="btn-3d btn-3d-secondary btn-sm">Skip to Dashboard</button>
          </div>

          <div class="equal-col">
            <div class="card">
              <div class="row-between" style="margin-bottom:14px;">
                <div>
                  <h2 class="card-title">1. Link Your WhatsApp Number</h2>
                  <div class="card-sub">Works 24/7 in cloud &mdash; no browser tab needed after linking</div>
                </div>
                ${waStatus === 'open'
                  ? `<span class="pill pill-emerald"><span class="dot dot-emerald"></span>Connected</span>`
                  : waStatus === 'qr_ready'
                    ? `<span class="pill pill-amber"><span class="dot dot-amber"></span>Ready to Scan</span>`
                    : `<span class="pill"><span class="dot dot-muted"></span>${escHtml(waStatus)}</span>`}
              </div>

              ${waStatus === 'open' ? `
                <div style="padding:26px;text-align:center;background:var(--bg-inset);border:1px solid var(--emerald-border);border-radius:12px;">
                  <div style="color:var(--emerald);margin-bottom:8px;">${icon('check', 'icon-lg')}</div>
                  <div style="font-weight:600;font-size:15px;">WhatsApp Linked &amp; Live</div>
                  <div class="mono" style="color:var(--ink-secondary);margin-top:4px;">${escHtml(ctx.user.waPhone || 'Active Device')}</div>
                </div>
              ` : `
                <div class="row-gap" style="margin-bottom:14px;">
                  <button id="ob-mode-qr" class="chip ${mode === 'qr' ? 'active' : ''}">${icon('qr', 'icon-sm')} Scan QR Code</button>
                  <button id="ob-mode-pair" class="chip ${mode === 'pairing' ? 'active' : ''}">${icon('phone', 'icon-sm')} 8-Digit Phone Code</button>
                </div>

                ${mode === 'qr' ? `
                  <div style="text-align:center;padding:14px;background:var(--bg-inset);border-radius:12px;border:1px solid var(--border-hairline);">
                    ${qrUrl ? `
                      <div class="qr-frame"><img src="${qrUrl}" alt="WhatsApp QR Code" /></div>
                      <div class="card-sub" style="margin-top:10px;">WhatsApp &rarr; Linked Devices &rarr; Link a Device</div>
                    ` : `
                      <div style="padding:44px 16px;">
                        <p class="card-sub" style="margin-bottom:14px;">Click below to generate your live QR code.</p>
                        <button id="ob-gen-qr" class="btn-3d btn-3d-primary">${icon('qr', 'icon-sm')}<span>Generate Live QR</span></button>
                      </div>
                    `}
                  </div>
                ` : `
                  <div style="padding:14px;background:var(--bg-inset);border-radius:12px;border:1px solid var(--border-hairline);">
                    <form id="ob-pair-form">
                      <div class="field">
                        <label>Phone Number (with country code, no +)</label>
                        <input id="ob-phone-input" class="input mono" placeholder="e.g. 919876543210" required />
                      </div>
                      <button type="submit" class="btn-3d btn-3d-primary btn-full">${icon('phone', 'icon-sm')}<span>Get 8-Digit Code</span></button>
                    </form>
                    ${pairingCode ? `<div class="pairing-display">${escHtml(pairingCode)}</div>
                      <div class="card-sub" style="text-align:center;">In WhatsApp: Linked Devices &rarr; Link with phone number instead</div>` : ''}
                  </div>
                `}
              `}

              <div style="margin-top:16px;padding:12px;border-radius:10px;border:1px dashed var(--border-medium);background:var(--bg-inset);">
                <div class="row-between">
                  <span style="font-size:12px;font-weight:500;">Instagram &amp; Facebook Messenger</span>
                  <span class="pill">Phase 2</span>
                </div>
                <div class="card-sub" style="margin-top:4px;">WhatsApp goes live today. Instagram DM &amp; Facebook connect in the next upgrade.</div>
              </div>
            </div>

            <div class="card" style="display:flex;flex-direction:column;justify-content:space-between;">
              <div>
                <h2 class="card-title" style="margin-bottom:4px;">2. Quick Business Identity</h2>
                <div class="card-sub" style="margin-bottom:16px;">Tell your AI what store it represents (editable anytime in Business Brain)</div>

                <form id="ob-brain-form">
                  <div class="field">
                    <label>Business Name</label>
                    <input name="businessName" class="input" value="${escHtml(ctx.user.businessName || '')}" required />
                  </div>
                  <div class="field">
                    <label>Category / Services</label>
                    <input name="industry" class="input" placeholder="e.g. Dental Clinic, Real Estate, Footwear Store" />
                  </div>
                  <div class="equal-col" style="gap:10px;">
                    <div class="field">
                      <label>Currency</label>
                      <select name="currency" class="select">
                        <option value="INR">INR (₹)</option>
                        <option value="USD">USD ($)</option>
                        <option value="AED">AED</option>
                        <option value="GBP">GBP (£)</option>
                      </select>
                    </div>
                    <div class="field">
                      <label>Reply Language</label>
                      <select name="language" class="select">
                        <option value="Auto (Match Customer)">Auto Match</option>
                        <option value="English">English</option>
                        <option value="Hinglish (English + Hindi)">Hinglish</option>
                      </select>
                    </div>
                  </div>
                  <div class="field">
                    <label>First Service &amp; Price (Optional)</label>
                    <div class="row-gap">
                      <input name="firstProd" class="input" placeholder="Service name" />
                      <input name="firstPrice" class="input mono" style="max-width:110px;" placeholder="Price" />
                    </div>
                  </div>
                  <button type="submit" class="btn-3d btn-3d-primary btn-lg btn-full" style="margin-top:8px;">
                    <span>Save &amp; Enter Dashboard</span>
                    ${icon('arrowRight', 'icon-sm')}
                  </button>
                </form>
              </div>
            </div>
          </div>
        </div>
      </div>
    `;

    container.querySelector('#ob-skip')?.addEventListener('click', finishOnboarding);
    container.querySelector('#ob-mode-qr')?.addEventListener('click', () => { mode = 'qr'; paint(); });
    container.querySelector('#ob-mode-pair')?.addEventListener('click', () => { mode = 'pairing'; paint(); });

    container.querySelector('#ob-gen-qr')?.addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      btn.textContent = 'Generating QR...';
      try {
        await api('/api/wa/connect', { method: 'POST' });
        toast('Starting WhatsApp session...');
      } catch (err) {
        toast(err.message, 'err');
        btn.disabled = false;
        paint();
      }
    });

    container.querySelector('#ob-pair-form')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const phone = container.querySelector('#ob-phone-input').value;
      try {
        const res = await api('/api/wa/pairing-code', { method: 'POST', body: { phone } });
        pairingCode = res.code;
        toast('Pairing code generated.');
        paint();
      } catch (err) {
        toast(err.message, 'err');
      }
    });

    container.querySelector('#ob-brain-form')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      try {
        const brain = await api('/api/brain');
        const nextCfg = {
          ...brain.botConfig,
          businessName: fd.get('businessName'),
          industry: fd.get('industry') || brain.botConfig.industry,
          currency: fd.get('currency'),
          language: fd.get('language')
        };
        const pName = String(fd.get('firstProd') || '').trim();
        const pPrice = String(fd.get('firstPrice') || '').trim();
        if (pName) {
          nextCfg.products = [{ name: pName, price: pPrice || 'Custom', note: '', active: true }, ...(brain.botConfig.products || [])];
        }
        await api('/api/brain', { method: 'PUT', body: { botConfig: nextCfg } });
        await finishOnboarding();
      } catch (err) {
        toast(err.message, 'err');
      }
    });
  }

  async function finishOnboarding() {
    await api('/api/onboarding/complete', { method: 'POST' }).catch(() => {});
    ctx.onOnboardingDone();
  }

  paint();

  // Live SSE reactivity while on onboarding
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
