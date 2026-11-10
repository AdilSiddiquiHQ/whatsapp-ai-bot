import { escHtml } from './api.js';

function smoothPath(points) {
  if (!points.length) return '';
  if (points.length === 1) return `M ${points[0].x} ${points[0].y}`;
  let d = `M ${points[0].x.toFixed(1)} ${points[0].y.toFixed(1)}`;
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i];
    const p1 = points[i + 1];
    const cx = ((p0.x + p1.x) / 2).toFixed(1);
    d += ` C ${cx} ${p0.y.toFixed(1)}, ${cx} ${p1.y.toFixed(1)}, ${p1.x.toFixed(1)} ${p1.y.toFixed(1)}`;
  }
  return d;
}

export function renderTrafficChart(container, series = []) {
  if (!container) return;
  const W = 720;
  const H = 220;
  const padL = 36;
  const padR = 14;
  const padT = 14;
  const padB = 26;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  const maxVal = Math.max(4, ...series.map((s) => Math.max(s.inbound || 0, (s.aiOut || 0) + (s.humanOut || 0))));
  const count = Math.max(2, series.length);

  const mapPt = (val, i) => ({
    x: padL + (i / (count - 1)) * plotW,
    y: padT + plotH - (val / maxVal) * plotH
  });

  const inPts = series.map((s, i) => mapPt(s.inbound || 0, i));
  const aiPts = series.map((s, i) => mapPt(s.aiOut || 0, i));

  const aiLine = smoothPath(aiPts);
  const inLine = smoothPath(inPts);
  const aiArea = aiPts.length
    ? `${aiLine} L ${aiPts[aiPts.length - 1].x.toFixed(1)} ${(padT + plotH).toFixed(1)} L ${aiPts[0].x.toFixed(1)} ${(padT + plotH).toFixed(1)} Z`
    : '';

  const yTicks = [0, 0.33, 0.66, 1].map((r) => ({
    val: Math.round(maxVal * r),
    y: (padT + plotH - r * plotH).toFixed(1)
  }));

  const stepLabel = series.length > 14 ? 4 : series.length > 9 ? 2 : 1;

  container.innerHTML = `
    <div style="position:relative;width:100%;">
      <svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;display:block;overflow:visible;">
        <defs>
          <linearGradient id="aiGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="#10B981" stop-opacity="0.28"/>
            <stop offset="100%" stop-color="#10B981" stop-opacity="0.00"/>
          </linearGradient>
        </defs>
        ${yTicks.map((t) => `
          <line x1="${padL}" y1="${t.y}" x2="${W - padR}" y2="${t.y}" stroke="rgba(255,255,255,0.05)" stroke-width="1"/>
          <text x="${padL - 8}" y="${Number(t.y) + 3}" text-anchor="end" fill="#71717A" font-family="JetBrains Mono,monospace" font-size="10">${t.val}</text>
        `).join('')}
        ${series.map((s, i) => {
          if (i % stepLabel !== 0 && i !== series.length - 1) return '';
          const x = (padL + (i / (count - 1)) * plotW).toFixed(1);
          return `<text x="${x}" y="${H - 6}" text-anchor="middle" fill="#71717A" font-family="JetBrains Mono,monospace" font-size="10">${escHtml(s.label)}</text>`;
        }).join('')}
        ${aiArea ? `<path d="${aiArea}" fill="url(#aiGrad)"/>` : ''}
        ${inLine ? `<path d="${inLine}" fill="none" stroke="#71717A" stroke-width="1.5" stroke-dasharray="4 3"/>` : ''}
        ${aiLine ? `<path d="${aiLine}" fill="none" stroke="#10B981" stroke-width="2"/>` : ''}
        <line id="chart-crosshair" x1="0" y1="${padT}" x2="0" y2="${padT + plotH}" stroke="rgba(255,255,255,0.22)" stroke-dasharray="3 3" visibility="hidden"/>
        <circle id="chart-dot-ai" cx="0" cy="0" r="4" fill="#10B981" stroke="#09090B" stroke-width="2" visibility="hidden"/>
        <rect id="chart-hit" x="${padL}" y="${padT}" width="${plotW}" height="${plotH}" fill="transparent" style="cursor:crosshair;"/>
      </svg>
      <div id="chart-tip" style="display:none;position:absolute;top:10px;background:#121216;border:1px solid rgba(255,255,255,0.14);border-radius:8px;padding:7px 10px;font-size:11px;pointer-events:none;box-shadow:0 8px 24px rgba(0,0,0,0.45);"></div>
    </div>
  `;

  const hit = container.querySelector('#chart-hit');
  const cross = container.querySelector('#chart-crosshair');
  const dot = container.querySelector('#chart-dot-ai');
  const tip = container.querySelector('#chart-tip');
  if (!hit || !series.length) return;

  hit.addEventListener('pointermove', (e) => {
    const rect = hit.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    const idx = Math.round(ratio * (series.length - 1));
    const item = series[idx];
    const pt = aiPts[idx];
    if (!item || !pt) return;

    cross.setAttribute('x1', pt.x.toFixed(1));
    cross.setAttribute('x2', pt.x.toFixed(1));
    cross.setAttribute('visibility', 'visible');
    dot.setAttribute('cx', pt.x.toFixed(1));
    dot.setAttribute('cy', pt.y.toFixed(1));
    dot.setAttribute('visibility', 'visible');

    tip.style.display = 'block';
    const pct = (pt.x / W) * 100;
    tip.style.left = pct > 65 ? `${pct - 24}%` : `${pct + 2}%`;
    tip.innerHTML = `
      <div style="color:#A1A1AA;margin-bottom:3px;font-weight:500;">${escHtml(item.label)}</div>
      <div class="tabular" style="color:#10B981;">AI Replies: ${item.aiOut}</div>
      <div class="tabular" style="color:#E4E4E7;">Inbound: ${item.inbound}</div>
      ${item.humanOut ? `<div class="tabular" style="color:#F59E0B;">Human: ${item.humanOut}</div>` : ''}
    `;
  });

  hit.addEventListener('pointerleave', () => {
    cross.setAttribute('visibility', 'hidden');
    dot.setAttribute('visibility', 'hidden');
    tip.style.display = 'none';
  });
}

export function renderHourlyChart(container, hourly = []) {
  if (!container) return;
  const vals = hourly.length === 24 ? hourly : Array(24).fill(0);
  const maxV = Math.max(1, ...vals);
  const W = 440;
  const H = 160;
  const barW = 12;
  const gap = 5.5;

  container.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;display:block;">
      ${vals.map((v, hr) => {
        const barH = Math.max(4, (v / maxV) * 112);
        const x = 10 + hr * (barW + gap);
        const y = 130 - barH;
        const opacity = v === 0 ? 0.16 : 0.45 + 0.55 * (v / maxV);
        const label = hr % 6 === 0 ? `${String(hr).padStart(2, '0')}h` : '';
        return `
          <rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW}" height="${barH.toFixed(1)}" rx="3" fill="#10B981" fill-opacity="${opacity.toFixed(2)}">
            <title>${String(hr).padStart(2, '0')}:00 — ${v} inbound</title>
          </rect>
          ${label ? `<text x="${(x + barW / 2).toFixed(1)}" y="150" text-anchor="middle" fill="#71717A" font-family="JetBrains Mono,monospace" font-size="9.5">${label}</text>` : ''}
        `;
      }).join('')}
    </svg>
  `;
}
