import { api, escHtml, toast } from '../api.js';
import { icon } from '../icons.js';

export function renderBrainView(container, ctx) {
  let botConfig = null;
  let quickReplies = [];

  async function init() {
    container.innerHTML = `<div class="card"><span class="card-sub">Loading Business Brain...</span></div>`;
    try {
      const data = await api('/api/brain');
      botConfig = data.botConfig;
      quickReplies = data.quickReplies || [];
      paint();
    } catch (err) {
      toast(err.message, 'err');
    }
  }

  function paint() {
    const products = botConfig.products || [];
    const faqs = botConfig.faqs || [];
    const rules = botConfig.customRules || [];

    container.innerHTML = `
      <div class="row-between" style="margin-bottom:16px;">
        <div>
          <h2 style="font-size:18px;">Business Brain &amp; Catalog</h2>
          <div class="card-sub">Structured store data compiled safely so the AI never hallucinates prices or policies.</div>
        </div>
        <div class="row-gap">
          <button id="brain-test-btn" class="btn-3d btn-3d-secondary">${icon('spark', 'icon-sm')}<span>Test in Preview</span></button>
          <button id="brain-save-btn" class="btn-3d btn-3d-primary">${icon('check', 'icon-sm')}<span>Save Changes</span></button>
        </div>
      </div>

      <div class="equal-col" style="margin-bottom:14px;">
        <div class="card">
          <div class="card-title" style="margin-bottom:12px;">Business Identity &amp; Voice</div>
          <div class="equal-col" style="gap:10px;">
            <div class="field"><label>Business Name</label><input id="b-name" class="input" value="${escHtml(botConfig.businessName || '')}" /></div>
            <div class="field"><label>Industry / Niche</label><input id="b-ind" class="input" value="${escHtml(botConfig.industry || '')}" /></div>
            <div class="field"><label>City / Region</label><input id="b-city" class="input" value="${escHtml(botConfig.city || '')}" /></div>
            <div class="field"><label>Currency</label>
              <select id="b-curr" class="select">
                ${['INR', 'USD', 'AED', 'GBP', 'EUR'].map((c) => `<option value="${c}" ${botConfig.currency === c ? 'selected' : ''}>${c}</option>`).join('')}
              </select>
            </div>
            <div class="field"><label>Language Mode</label>
              <select id="b-lang" class="select">
                ${['Auto (Match Customer)', 'English', 'Hinglish (English + Hindi)', 'Hindi', 'Arabic', 'Spanish'].map((l) => `<option value="${l}" ${botConfig.language === l ? 'selected' : ''}>${l}</option>`).join('')}
              </select>
            </div>
            <div class="field"><label>Reply Tone</label>
              <select id="b-tone" class="select">
                ${['Warm & Professional', 'Concise & Direct', 'Friendly Concierge', 'Consultative Sales'].map((t) => `<option value="${t}" ${botConfig.tone === t ? 'selected' : ''}>${t}</option>`).join('')}
              </select>
            </div>
          </div>
          <div class="field" style="margin-bottom:0;">
            <label>Emoji Style</label>
            <select id="b-emoji" class="select">
              <option value="minimal" ${botConfig.emojiLevel === 'minimal' ? 'selected' : ''}>Minimal (Clean &amp; Restrained)</option>
              <option value="none" ${botConfig.emojiLevel === 'none' ? 'selected' : ''}>None (Strictly Text Only)</option>
              <option value="natural" ${botConfig.emojiLevel === 'natural' ? 'selected' : ''}>Natural</option>
            </select>
          </div>
        </div>

        <div class="card">
          <div class="card-title" style="margin-bottom:12px;">Do's, Don'ts &amp; Extra Guidance</div>
          <div class="field">
            <label>Strict Business Rules (one per line)</label>
            <textarea id="b-rules" class="textarea" rows="5" placeholder="Never promise discounts...">${escHtml(rules.join('\n'))}</textarea>
          </div>
          <div class="field" style="margin-bottom:0;">
            <label>Extra Context / Payment / Booking Links</label>
            <textarea id="b-extra" class="textarea" rows="4" placeholder="Booking URL, store address, UPI or special notes...">${escHtml(botConfig.extraInstructions || '')}</textarea>
          </div>
        </div>
      </div>

      <div class="card" style="margin-bottom:14px;">
        <div class="card-header">
          <div>
            <div class="card-title">Services &amp; Pricing Catalog</div>
            <div class="card-sub">Every active row is injected cleanly into the AI context</div>
          </div>
          <button id="add-prod" class="btn-3d btn-3d-secondary btn-sm">${icon('plus', 'icon-sm')}<span>Add Item</span></button>
        </div>
        <div id="prod-list" style="display:flex;flex-direction:column;gap:8px;">
          ${products.map((p, i) => `
            <div class="row-gap prod-row" data-idx="${i}">
              <input class="input p-name" style="flex:1.3;" placeholder="Service or product name" value="${escHtml(p.name)}" />
              <input class="input mono p-price" style="max-width:130px;" placeholder="Price" value="${escHtml(p.price)}" />
              <input class="input p-note" style="flex:2;" placeholder="Short details / duration" value="${escHtml(p.note || '')}" />
              <label class="switch" title="Active in AI"><input type="checkbox" class="p-active" ${p.active !== false ? 'checked' : ''} /><span class="slider"></span></label>
              <button type="button" class="btn-3d btn-3d-secondary btn-sm del-prod" data-idx="${i}">${icon('trash', 'icon-sm')}</button>
            </div>
          `).join('')}
        </div>
      </div>

      <div class="equal-col">
        <div class="card">
          <div class="card-header">
            <div>
              <div class="card-title">FAQ Knowledge Pairs</div>
              <div class="card-sub">Instant answers to repeat questions</div>
            </div>
            <button id="add-faq" class="btn-3d btn-3d-secondary btn-sm">${icon('plus', 'icon-sm')}<span>Add FAQ</span></button>
          </div>
          <div id="faq-list" style="display:flex;flex-direction:column;gap:10px;">
            ${faqs.map((f, i) => `
              <div style="padding:10px;background:var(--bg-inset);border:1px solid var(--border-hairline);border-radius:8px;" class="faq-row" data-idx="${i}">
                <div class="row-gap" style="margin-bottom:6px;">
                  <input class="input f-q" placeholder="Question" value="${escHtml(f.q)}" />
                  <button type="button" class="btn-3d btn-3d-secondary btn-sm del-faq" data-idx="${i}">${icon('trash', 'icon-sm')}</button>
                </div>
                <textarea class="textarea f-a" rows="2" style="min-height:54px;" placeholder="Exact answer">${escHtml(f.a)}</textarea>
              </div>
            `).join('')}
          </div>
        </div>

        <div class="card">
          <div class="card-header">
            <div>
              <div class="card-title">Inbox Quick Replies (Canned Snippets)</div>
              <div class="card-sub">1-click replies for manual Inbox agents</div>
            </div>
            <button id="add-qr" class="btn-3d btn-3d-secondary btn-sm">${icon('plus', 'icon-sm')}<span>Add Snippet</span></button>
          </div>
          <div id="qr-list" style="display:flex;flex-direction:column;gap:10px;">
            ${quickReplies.map((q, i) => `
              <div style="padding:10px;background:var(--bg-inset);border:1px solid var(--border-hairline);border-radius:8px;" class="qr-row" data-idx="${i}">
                <div class="row-gap" style="margin-bottom:6px;">
                  <input class="input q-title" placeholder="Button title" value="${escHtml(q.title)}" />
                  <button type="button" class="btn-3d btn-3d-secondary btn-sm del-qr" data-idx="${i}">${icon('trash', 'icon-sm')}</button>
                </div>
                <textarea class="textarea q-body" rows="2" style="min-height:54px;" placeholder="Message text">${escHtml(q.body)}</textarea>
              </div>
            `).join('')}
          </div>
        </div>
      </div>
    `;

    const collectDraft = () => {
      botConfig.businessName = container.querySelector('#b-name').value;
      botConfig.industry = container.querySelector('#b-ind').value;
      botConfig.city = container.querySelector('#b-city').value;
      botConfig.currency = container.querySelector('#b-curr').value;
      botConfig.language = container.querySelector('#b-lang').value;
      botConfig.tone = container.querySelector('#b-tone').value;
      botConfig.emojiLevel = container.querySelector('#b-emoji').value;
      botConfig.customRules = container.querySelector('#b-rules').value.split('\n').map((s) => s.trim()).filter(Boolean);
      botConfig.extraInstructions = container.querySelector('#b-extra').value;

      botConfig.products = [...container.querySelectorAll('.prod-row')].map((row) => ({
        name: row.querySelector('.p-name').value.trim(),
        price: row.querySelector('.p-price').value.trim(),
        note: row.querySelector('.p-note').value.trim(),
        active: row.querySelector('.p-active').checked
      })).filter((p) => p.name);

      botConfig.faqs = [...container.querySelectorAll('.faq-row')].map((row) => ({
        q: row.querySelector('.f-q').value.trim(),
        a: row.querySelector('.f-a').value.trim()
      })).filter((f) => f.q && f.a);

      quickReplies = [...container.querySelectorAll('.qr-row')].map((row, idx) => ({
        id: `qr_${idx}`,
        title: row.querySelector('.q-title').value.trim(),
        body: row.querySelector('.q-body').value.trim()
      })).filter((q) => q.title && q.body);
    };

    container.querySelector('#add-prod').addEventListener('click', () => {
      collectDraft();
      botConfig.products.push({ name: '', price: '', note: '', active: true });
      paint();
    });
    container.querySelectorAll('.del-prod').forEach((b) => b.addEventListener('click', () => {
      collectDraft();
      botConfig.products.splice(Number(b.dataset.idx), 1);
      paint();
    }));

    container.querySelector('#add-faq').addEventListener('click', () => {
      collectDraft();
      botConfig.faqs.push({ q: '', a: '' });
      paint();
    });
    container.querySelectorAll('.del-faq').forEach((b) => b.addEventListener('click', () => {
      collectDraft();
      botConfig.faqs.splice(Number(b.dataset.idx), 1);
      paint();
    }));

    container.querySelector('#add-qr').addEventListener('click', () => {
      collectDraft();
      quickReplies.push({ id: `qr_${quickReplies.length}`, title: '', body: '' });
      paint();
    });
    container.querySelectorAll('.del-qr').forEach((b) => b.addEventListener('click', () => {
      collectDraft();
      quickReplies.splice(Number(b.dataset.idx), 1);
      paint();
    }));

    container.querySelector('#brain-save-btn').addEventListener('click', async () => {
      collectDraft();
      try {
        await api('/api/brain', { method: 'PUT', body: { botConfig, quickReplies } });
        toast('Business Brain updated live.');
      } catch (err) {
        toast(err.message, 'err');
      }
    });

    container.querySelector('#brain-test-btn').addEventListener('click', async () => {
      collectDraft();
      await api('/api/brain', { method: 'PUT', body: { botConfig, quickReplies } }).catch(() => {});
      ctx.navigate('inbox');
    });
  }

  init();
  return null;
}
