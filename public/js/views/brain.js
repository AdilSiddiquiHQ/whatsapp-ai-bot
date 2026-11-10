import { api, escHtml, toast } from '../api.js';
import { icon } from '../icons.js';

export function renderBrainView(container, ctx) {
  let botConfig = null;
  let quickReplies = [];
  let limits = { maxOffers: 8, maxProducts: 30, maxFaqs: 25, maxRules: 10, maxQuickReplies: 12, maxAnnouncementChars: 350 };
  let industry = '';
  let budget = null;
  let allowEdit = true;

  async function init() {
    container.innerHTML = `<div class="card"><span class="card-sub">Loading Business Brain...</span></div>`;
    try {
      const data = await api('/api/brain');
      botConfig = data.botConfig;
      quickReplies = data.quickReplies || [];
      limits = data.limits || limits;
      industry = data.industry || '';
      budget = data.budget;
      allowEdit = data.allowClientBrainEdit !== false;
      paint();
    } catch (err) {
      toast(err.message, 'err');
    }
  }

  function paint() {
    const offers = botConfig.offers || [];
    const products = botConfig.products || [];
    const faqs = botConfig.faqs || [];
    const rules = botConfig.customRules || [];
    const tokUsed = budget?.estimatedTokens || 0;
    const tokMax = budget?.maxTokens || 950;
    const tokPct = Math.min(100, Math.round((tokUsed / tokMax) * 100));

    container.innerHTML = `
      <div class="row-between" style="margin-bottom:14px;">
        <div>
          <div class="row-gap">
            <h2 style="font-size:18px;">Business Offers, Prices &amp; Knowledge</h2>
            ${industry ? `<span class="pill">${escHtml(industry)}</span>` : ''}
          </div>
          <div class="card-sub">Update offers, holiday notices, pricing &amp; FAQs here anytime &mdash; agency core prompt &amp; zero-hallucination shield remain active underneath.</div>
        </div>
        <div class="row-gap">
          <button id="brain-test-btn" class="btn-3d btn-3d-secondary">${icon('spark', 'icon-sm')}<span>Test in Preview</span></button>
          ${allowEdit ? `<button id="brain-save-btn" class="btn-3d btn-3d-primary">${icon('check', 'icon-sm')}<span>Save &amp; Sync AI</span></button>` : ''}
        </div>
      </div>

      ${!allowEdit ? `
        <div class="card" style="margin-bottom:14px;border-color:var(--amber-border);background:var(--amber-tint);">
          <div style="font-weight:500;color:var(--amber);">Read-Only Mode</div>
          <div style="font-size:12px;">Your agency administrator manages knowledge updates on this workspace plan.</div>
        </div>
      ` : ''}

      <!-- Live Token Budget & Digest Compression Status -->
      <div class="card" style="margin-bottom:14px;padding:12px 16px;">
        <div class="row-between" style="margin-bottom:6px;">
          <span style="font-size:12px;font-weight:500;">
            AI Prompt Memory Budget &nbsp;&middot;&nbsp;
            <span class="mono muted">Offers ${offers.length}/${limits.maxOffers} &middot; Catalog ${products.length}/${limits.maxProducts} &middot; FAQs ${faqs.length}/${limits.maxFaqs} &middot; Rules ${rules.length}/${limits.maxRules}</span>
          </span>
          <span class="tabular" style="font-size:12px;">
            ~${tokUsed} / ${tokMax} tokens
            ${budget?.compressedByAi ? `<span class="pill pill-emerald" style="margin-left:6px;font-size:10px;">Smart Compressed</span>` : ''}
          </span>
        </div>
        <div style="height:6px;background:var(--bg-inset);border-radius:999px;overflow:hidden;border:1px solid var(--border-hairline);">
          <div style="height:100%;width:${tokPct}%;background:${tokPct > 85 ? 'var(--amber)' : 'var(--emerald)'};transition:width 200ms ease;"></div>
        </div>
      </div>

      <!-- Recurring Weekly/Monthly Self-Serve: Live Offers + Announcement -->
      <div class="equal-col" style="margin-bottom:14px;">
        <div class="card">
          <div class="card-header">
            <div>
              <div class="card-title">Live Offers &amp; Promo Codes (${offers.length}/${limits.maxOffers})</div>
              <div class="card-sub">Toggle festive deals ON/OFF immediately without bothering your agency</div>
            </div>
            <button id="add-offer" class="btn-3d btn-3d-secondary btn-sm" ${offers.length >= limits.maxOffers ? 'disabled' : ''}>${icon('plus', 'icon-sm')}<span>Add Offer</span></button>
          </div>
          <div id="offer-list" style="display:flex;flex-direction:column;gap:8px;">
            ${offers.length === 0 ? `<div class="card-sub" style="padding:10px 0;">No active offers. Click Add Offer for weekend/seasonal discounts.</div>` : offers.map((o, i) => `
              <div class="row-gap offer-row" data-idx="${i}">
                <input class="input o-title" style="flex:1.1;" placeholder="Offer title (e.g. Diwali Offer)" value="${escHtml(o.title)}" maxlength="60" />
                <input class="input o-deal" style="flex:1.4;" placeholder="Deal (e.g. 20% off above 999)" value="${escHtml(o.deal)}" maxlength="100" />
                <input class="input mono o-code" style="max-width:95px;" placeholder="Code" value="${escHtml(o.code || '')}" maxlength="32" />
                <label class="switch" title="Active"><input type="checkbox" class="o-active" ${o.active !== false ? 'checked' : ''} /><span class="slider"></span></label>
                <button type="button" class="btn-3d btn-3d-secondary btn-sm del-offer" data-idx="${i}">${icon('trash', 'icon-sm')}</button>
              </div>
            `).join('')}
          </div>
        </div>

        <div class="card">
          <div class="card-title" style="margin-bottom:6px;">Store Voice &amp; Today's Live Notice</div>
          <div class="equal-col" style="gap:10px;margin-bottom:10px;">
            <div class="field" style="margin:0;"><label>Store Display Name</label><input id="b-name" class="input" value="${escHtml(botConfig.businessName || '')}" maxlength="80" /></div>
            <div class="field" style="margin:0;"><label>City / Area</label><input id="b-city" class="input" value="${escHtml(botConfig.city || '')}" maxlength="60" /></div>
            <div class="field" style="margin:0;"><label>Currency</label>
              <select id="b-curr" class="select">
                ${['INR', 'USD', 'AED', 'GBP', 'EUR'].map((c) => `<option value="${c}" ${botConfig.currency === c ? 'selected' : ''}>${c}</option>`).join('')}
              </select>
            </div>
            <div class="field" style="margin:0;"><label>Language / Tone</label>
              <select id="b-lang" class="select">
                ${['Auto (Match Customer)', 'English', 'Hinglish (English + Hindi)', 'Hindi', 'Arabic', 'Spanish'].map((l) => `<option value="${l}" ${botConfig.language === l ? 'selected' : ''}>${l}</option>`).join('')}
              </select>
            </div>
          </div>
          <div class="field" style="margin-bottom:0;">
            <label>Live Store Announcement / Holiday Update (max ${limits.maxAnnouncementChars} chars)</label>
            <textarea id="b-ann" class="textarea" rows="2" maxlength="${limits.maxAnnouncementChars}" placeholder="e.g. Closed this Sunday for renovation. Same-day orders before 4 PM only.">${escHtml(botConfig.announcement || '')}</textarea>
          </div>
        </div>
      </div>

      <!-- Services & Prices Catalog -->
      <div class="card" style="margin-bottom:14px;">
        <div class="card-header">
          <div>
            <div class="card-title">Services &amp; Pricing Catalog (${products.length}/${limits.maxProducts})</div>
            <div class="card-sub">Keep items crisp &mdash; disabled/deleted rows vanish immediately from AI memory on Save</div>
          </div>
          <button id="add-prod" class="btn-3d btn-3d-secondary btn-sm" ${products.length >= limits.maxProducts ? 'disabled' : ''}>${icon('plus', 'icon-sm')}<span>Add Item</span></button>
        </div>
        <div id="prod-list" style="display:flex;flex-direction:column;gap:8px;">
          ${products.map((p, i) => `
            <div class="row-gap prod-row" data-idx="${i}">
              <input class="input p-name" style="flex:1.3;" placeholder="Service or item name" value="${escHtml(p.name)}" maxlength="70" />
              <input class="input mono p-price" style="max-width:125px;" placeholder="Price" value="${escHtml(p.price)}" maxlength="35" />
              <input class="input p-note" style="flex:2;" placeholder="Short description (max 120 chars)" value="${escHtml(p.note || '')}" maxlength="120" />
              <label class="switch" title="Active in AI"><input type="checkbox" class="p-active" ${p.active !== false ? 'checked' : ''} /><span class="slider"></span></label>
              <button type="button" class="btn-3d btn-3d-secondary btn-sm del-prod" data-idx="${i}">${icon('trash', 'icon-sm')}</button>
            </div>
          `).join('')}
        </div>
      </div>

      <div class="equal-col" style="margin-bottom:14px;">
        <div class="card">
          <div class="card-header">
            <div>
              <div class="card-title">FAQ Knowledge (${faqs.length}/${limits.maxFaqs})</div>
              <div class="card-sub">Auto-compressed cleanly when >1350 chars to save free tokens</div>
            </div>
            <button id="add-faq" class="btn-3d btn-3d-secondary btn-sm" ${faqs.length >= limits.maxFaqs ? 'disabled' : ''}>${icon('plus', 'icon-sm')}<span>Add FAQ</span></button>
          </div>
          <div id="faq-list" style="display:flex;flex-direction:column;gap:10px;">
            ${faqs.map((f, i) => `
              <div style="padding:10px;background:var(--bg-inset);border:1px solid var(--border-hairline);border-radius:8px;" class="faq-row" data-idx="${i}">
                <div class="row-gap" style="margin-bottom:6px;">
                  <input class="input f-q" placeholder="Customer question" value="${escHtml(f.q)}" maxlength="140" />
                  <button type="button" class="btn-3d btn-3d-secondary btn-sm del-faq" data-idx="${i}">${icon('trash', 'icon-sm')}</button>
                </div>
                <textarea class="textarea f-a" rows="2" style="min-height:52px;" placeholder="Verified factual answer" maxlength="360">${escHtml(f.a)}</textarea>
              </div>
            `).join('')}
          </div>
        </div>

        <div class="card" style="display:flex;flex-direction:column;gap:14px;">
          <div>
            <div class="card-title" style="margin-bottom:6px;">Strict Do's &amp; Don'ts (${rules.length}/${limits.maxRules} lines)</div>
            <textarea id="b-rules" class="textarea" rows="4" placeholder="One rule per line (max 10 rules)...">${escHtml(rules.join('\n'))}</textarea>
          </div>
          <div>
            <div class="row-between" style="margin-bottom:8px;">
              <div>
                <div class="card-title">Inbox Quick Replies (${quickReplies.length}/${limits.maxQuickReplies})</div>
                <div class="card-sub">Manual canned replies in Inbox</div>
              </div>
              <button id="add-qr" class="btn-3d btn-3d-secondary btn-sm" ${quickReplies.length >= limits.maxQuickReplies ? 'disabled' : ''}>${icon('plus', 'icon-sm')}</button>
            </div>
            <div id="qr-list" style="display:flex;flex-direction:column;gap:8px;">
              ${quickReplies.map((q, i) => `
                <div style="padding:8px;background:var(--bg-inset);border:1px solid var(--border-hairline);border-radius:8px;" class="qr-row" data-idx="${i}">
                  <div class="row-gap" style="margin-bottom:4px;">
                    <input class="input q-title" placeholder="Title" value="${escHtml(q.title)}" maxlength="40" />
                    <button type="button" class="btn-3d btn-3d-secondary btn-sm del-qr" data-idx="${i}">${icon('trash', 'icon-sm')}</button>
                  </div>
                  <input class="input q-body" placeholder="Quick reply text" value="${escHtml(q.body)}" maxlength="400" />
                </div>
              `).join('')}
            </div>
          </div>
        </div>
      </div>
    `;

    const collectDraft = () => {
      botConfig.businessName = container.querySelector('#b-name').value;
      botConfig.city = container.querySelector('#b-city').value;
      botConfig.currency = container.querySelector('#b-curr').value;
      botConfig.language = container.querySelector('#b-lang').value;
      botConfig.announcement = container.querySelector('#b-ann').value;
      botConfig.customRules = container.querySelector('#b-rules').value.split('\n').map((s) => s.trim()).filter(Boolean).slice(0, limits.maxRules);

      botConfig.offers = [...container.querySelectorAll('.offer-row')].map((row) => ({
        title: row.querySelector('.o-title').value.trim(),
        deal: row.querySelector('.o-deal').value.trim(),
        code: row.querySelector('.o-code').value.trim(),
        active: row.querySelector('.o-active').checked
      }));

      botConfig.products = [...container.querySelectorAll('.prod-row')].map((row) => ({
        name: row.querySelector('.p-name').value.trim(),
        price: row.querySelector('.p-price').value.trim(),
        note: row.querySelector('.p-note').value.trim(),
        active: row.querySelector('.p-active').checked
      }));

      botConfig.faqs = [...container.querySelectorAll('.faq-row')].map((row) => ({
        q: row.querySelector('.f-q').value.trim(),
        a: row.querySelector('.f-a').value.trim()
      }));

      quickReplies = [...container.querySelectorAll('.qr-row')].map((row, idx) => ({
        id: `qr_${idx}`,
        title: row.querySelector('.q-title').value.trim(),
        body: row.querySelector('.q-body').value.trim()
      }));
    };

    container.querySelector('#add-offer')?.addEventListener('click', () => {
      collectDraft();
      if (botConfig.offers.length < limits.maxOffers) {
        botConfig.offers.push({ title: '', deal: '', code: '', active: true });
        paint();
      }
    });
    container.querySelectorAll('.del-offer').forEach((b) => b.addEventListener('click', () => {
      collectDraft();
      botConfig.offers.splice(Number(b.dataset.idx), 1);
      paint();
    }));

    container.querySelector('#add-prod')?.addEventListener('click', () => {
      collectDraft();
      if (botConfig.products.length < limits.maxProducts) {
        botConfig.products.push({ name: '', price: '', note: '', active: true });
        paint();
      }
    });
    container.querySelectorAll('.del-prod').forEach((b) => b.addEventListener('click', () => {
      collectDraft();
      botConfig.products.splice(Number(b.dataset.idx), 1);
      paint();
    }));

    container.querySelector('#add-faq')?.addEventListener('click', () => {
      collectDraft();
      if (botConfig.faqs.length < limits.maxFaqs) {
        botConfig.faqs.push({ q: '', a: '' });
        paint();
      }
    });
    container.querySelectorAll('.del-faq').forEach((b) => b.addEventListener('click', () => {
      collectDraft();
      botConfig.faqs.splice(Number(b.dataset.idx), 1);
      paint();
    }));

    container.querySelector('#add-qr')?.addEventListener('click', () => {
      collectDraft();
      if (quickReplies.length < limits.maxQuickReplies) {
        quickReplies.push({ id: `qr_${quickReplies.length}`, title: '', body: '' });
        paint();
      }
    });
    container.querySelectorAll('.del-qr').forEach((b) => b.addEventListener('click', () => {
      collectDraft();
      quickReplies.splice(Number(b.dataset.idx), 1);
      paint();
    }));

    container.querySelector('#brain-save-btn')?.addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      collectDraft();
      btn.disabled = true;
      try {
        const res = await api('/api/brain', { method: 'PUT', body: { botConfig, quickReplies } });
        botConfig = res.botConfig;
        quickReplies = res.quickReplies;
        budget = res.budget;
        toast('Saved & synchronized AI knowledge digest.');
        paint();
      } catch (err) {
        toast(err.message, 'err');
        btn.disabled = false;
      }
    });

    container.querySelector('#brain-test-btn').addEventListener('click', async () => {
      if (allowEdit) {
        collectDraft();
        await api('/api/brain', { method: 'PUT', body: { botConfig, quickReplies } }).catch(() => {});
      }
      ctx.navigate('inbox');
    });
  }

  init();
  return null;
}
