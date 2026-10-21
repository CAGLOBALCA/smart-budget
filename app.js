'use strict';
let L, predict, current = null, lang = localStorage.getItem('sbp.lang') || (navigator.language || 'en').slice(0, 2);
const qp = new URLSearchParams(location.search).get('lang'); if (qp) lang = qp;
if (!I18N[lang]) lang = 'en';
const $ = id => document.getElementById(id), t = (k, v = {}) => (I18N[lang][k] || I18N.en[k] || k).replace(/\{(\w+)\}/g, (_, a) => v[a]);
function applyLang() {
  document.documentElement.lang = lang; document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr'; $('lang').value = lang;
  document.querySelectorAll('[data-i]').forEach(e => e.textContent = t(e.dataset.i)); renderScans(); if (current) renderReview();
}
$('lang').onchange = e => { lang = e.target.value; localStorage.setItem('sbp.lang', lang); applyLang(); };
const ready = Promise.all([fetch('layouts.json').then(r => r.json()), fetch('model/digits.json').then(r => r.json())]).then(([l, m]) => { L = l; predict = SBP.loadModel(m); });
if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js');

function status(msg, cls = '') { const s = $('status'); s.textContent = msg; s.className = 'status ' + cls; }
async function processImage(img) {
  await ready; status(t('reading'));
  await new Promise(r => setTimeout(r, 30));
  const sc = Math.min(1, 2000 / Math.max(img.naturalWidth, img.naturalHeight)), w = Math.round(img.naturalWidth * sc), h = Math.round(img.naturalHeight * sc);
  const c = document.createElement('canvas'); c.width = w; c.height = h; const cx = c.getContext('2d'); cx.drawImage(img, 0, 0, w, h);
  const d = cx.getImageData(0, 0, w, h).data, g = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) g[i] = (d[4 * i] * 0.299 + d[4 * i + 1] * 0.587 + d[4 * i + 2] * 0.114) | 0;
  const t0 = performance.now(), r = SBP.readPage(g, w, h, L, predict), ms = Math.round(performance.now() - t0);
  const pv = $('preview'); pv.hidden = false; pv.width = w; pv.height = h; const p = pv.getContext('2d'); p.drawImage(c, 0, 0);
  if (r.corners) { p.strokeStyle = '#e0204a'; p.lineWidth = Math.max(3, w / 300); p.beginPath(); r.corners.forEach((q, i) => i ? p.lineTo(q[0], q[1]) : p.moveTo(q[0], q[1])); p.closePath(); p.stroke(); }
  if (!r.ok) { status(t(r.error === 'markers' ? 'fail_markers' : 'fail_pageid'), 'err'); $('reviewCard').hidden = true; current = null; return; }
  current = { id: Date.now(), typeId: r.typeId, typeName: r.typeName, values: {}, conf: {} };
  for (const f of r.fields) { current.values[f.key] = f.value; current.conf[f.key] = f.conf; }
  status(t('read_ok', { name: r.typeName }) + ` (${ms} ms)`, 'ok'); renderReview(); $('reviewCard').hidden = false;
}
function inputFor(f, v, low) {
  if (f.kind === 'digits') return `<input type="text" inputmode="numeric" data-k="${f.key}" value="${v ?? ''}" class="${low ? 'low' : ''}">`;
  if (f.kind === 'check') return `<input type="checkbox" data-k="${f.key}" ${v ? 'checked' : ''}>`;
  return `<select data-k="${f.key}" class="${low ? 'low' : ''}"><option value=""></option>${f.options.map(o => `<option ${o === v ? 'selected' : ''}>${o}</option>`).join('')}</select>`;
}
function renderReview() {
  const T = L.types[current.typeId], meta = T.fields.filter(f => f.row === '_meta'), rows = [...new Set(T.fields.filter(f => f.row !== '_meta').map(f => f.row))];
  const low = k => current.conf[k] < 0.8;
  $('meta').innerHTML = `<b>${T.name}</b> &nbsp; ` + meta.map(f => `${t(f.key)}: ${inputFor(f, current.values[f.key], low(f.key))}`).join(' &nbsp; ');
  let h = `<tr><th>${T.rowsLabel}</th>${T.columns.map(c => `<th>${c}</th>`).join('')}</tr>`;
  for (const r of rows) h += `<tr><td>${r}</td>${T.columns.map(c => { const f = T.fields.find(z => z.row === r && z.col === c); return `<td>${f ? inputFor(f, current.values[f.key], low(f.key)) : ''}</td>`; }).join('')}</tr>`;
  $('review').innerHTML = h;
  document.querySelectorAll('#reviewCard [data-k]').forEach(e => e.onchange = () => { current.values[e.dataset.k] = e.type === 'checkbox' ? e.checked : e.value.replace(/[^\d]/g, '') || e.value; current.conf[e.dataset.k] = 1; e.classList.remove('low'); });
}
const load = () => JSON.parse(localStorage.getItem('sbp.scans') || '[]'), store = a => localStorage.setItem('sbp.scans', JSON.stringify(a));
$('save').onclick = () => { const a = load(); a.push({ id: current.id, typeId: current.typeId, typeName: current.typeName, values: current.values }); store(a); status(t('saved'), 'ok'); renderScans(); };
function renderScans() {
  const a = load(); $('scans').innerHTML = a.length ? a.map(s => `<li>${s.typeName} — ${s.values.month || '??'}/${s.values.year || '????'}${s.values.week ? ' · W' + s.values.week : ''} <button class="btn sec" data-del="${s.id}">${t('del')}</button></li>`).join('') : `<li>${t('none')}</li>`;
  document.querySelectorAll('[data-del]').forEach(b => b.onclick = () => { store(load().filter(s => String(s.id) !== b.dataset.del)); renderScans(); });
}
$('clear').onclick = () => { if (confirm(t('confirm_clear'))) { localStorage.removeItem('sbp.scans'); renderScans(); } };
const num = v => (v === '' || v == null) ? null : (/^\d+$/.test(String(v)) ? Number(v) : v);
$('export').onclick = async () => {
  await ready; const a = load(), wb = XLSX.utils.book_new();
  for (const [tid, T] of Object.entries(L.types)) {
    const scans = a.filter(s => String(s.typeId) === tid); if (!scans.length) continue;
    const rowsOf = [...new Set(T.fields.filter(f => f.row !== '_meta').map(f => f.row))], aoa = [['Year', 'Month', ...(tid === '3' ? ['Week'] : []), T.rowsLabel, ...T.columns]];
    for (const s of scans) for (const r of rowsOf) {
      const vals = T.columns.map(c => { const f = T.fields.find(z => z.row === r && z.col === c); return f ? (f.kind === 'check' ? (s.values[f.key] ? 'yes' : '') : num(s.values[f.key])) : null; });
      if (tid === '2' && vals.every(v => v == null || v === '')) continue;
      aoa.push([num(s.values.year), num(s.values.month), ...(tid === '3' ? [num(s.values.week)] : []), r, ...vals]);
    }
    const ws = XLSX.utils.aoa_to_sheet(aoa); ws['!cols'] = aoa[0].map(() => ({ wch: 16 })); XLSX.utils.book_append_sheet(wb, ws, T.name.slice(0, 31));
  }
  const tr = a.filter(s => s.typeId === 2);   // category totals from expense tracker
  if (tr.length) {
    const tot = {}; for (const s of tr) for (let i = 1; i <= 18; i++) { const r = String(i).padStart(2, '0'), cat = s.values[`t${r}.cat`] || 'Uncategorized', amt = Number(s.values[`t${r}.amt`] || 0); if (!amt) continue; const k = `${s.values.year}|${s.values.month}|${cat}`; tot[k] = (tot[k] || 0) + amt; }
    const aoa = [['Year', 'Month', 'Category', 'Total']].concat(Object.entries(tot).map(([k, v]) => { const [y, m, c] = k.split('|'); return [num(y), num(m), c, v]; }));
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), 'Tracker totals');
  }
  if (!wb.SheetNames.length) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['No data yet']]), 'Empty');
  XLSX.writeFile(wb, `smart-budget-${new Date().toISOString().slice(0, 10)}.xlsx`);
};
$('file').onchange = e => { const f = e.target.files[0]; if (!f) return; const img = new Image(); img.onload = () => processImage(img); img.src = URL.createObjectURL(f); };
$('demo').onclick = () => { const img = new Image(); img.onload = () => processImage(img); img.src = 'demo/sample-tracker.jpg'; };
applyLang();
if (location.hash === '#demo' || location.hash === '#demo-budget') { const img = new Image(); img.onload = () => processImage(img); img.src = location.hash === '#demo' ? 'demo/sample-tracker.jpg' : 'demo/sample-budget.jpg'; }
