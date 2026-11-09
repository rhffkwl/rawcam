'use strict';
const $ = (id) => document.getElementById(id);
const video = $('video');
const state = {
  stream: null, track: null, facing: 'environment', resIdx: 0, timer: 0, grid: false,
  adj: { b: 0, c: 0, t: 0, s: 0 }, saveMirror: true,
  raw: null, rawMirrored: false, file: null, prepToken: 0, starting: false,
};
const RES = [
  { name: '4:3 최대', w: 4032, h: 3024 },
  { name: '16:9 4K', w: 3840, h: 2160 },
  { name: '1080p', w: 1920, h: 1080 },
];

function toast(msg, ms = 2200) {
  const t = $('toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), ms);
}

/* ---------- Adjustments: one definition shared by preview (CSS) and save (pixels) ---------- */
function params() {
  const a = state.adj;
  return {
    b: 1 + a.b / 100,          // brightness() factor
    c: 1 + a.c / 100,          // contrast() factor
    s: 1 + a.s / 100,          // saturate() factor
    k: a.t / 100,              // temperature, -0.5..0.5
  };
}
function isNeutral() { const a = state.adj; return !a.b && !a.c && !a.s && !a.t; }
function wbGains(k) { return [1 + 0.2 * k, 1 + 0.03 * k, 1 - 0.2 * k]; }
function cssFilter() {
  if (isNeutral()) return 'none';
  const p = params();
  return `brightness(${p.b}) contrast(${p.c}) saturate(${p.s})` + (p.k ? ' url(#wb)' : '');
}
function updateFilters() {
  const [r, g, b] = wbGains(params().k);
  $('wbm').setAttribute('values', `${r} 0 0 0 0  0 ${g} 0 0 0  0 0 ${b} 0 0  0 0 0 1 0`);
  const f = cssFilter();
  video.style.filter = f; $('reviewImg').style.filter = f;
  for (const k of ['b', 'c', 't', 's']) $('o_' + k).textContent = (state.adj[k] > 0 ? '+' : '') + state.adj[k];
}
// Same math as CSS Filter Effects spec: brightness -> contrast -> saturate -> WB matrix, clamped per step.
function applyPixels(ctx, w, h) {
  if (isNeutral()) return;
  const p = params();
  const lut = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    let v = Math.min(1, (i / 255) * p.b);
    v = Math.min(1, Math.max(0, (v - 0.5) * p.c + 0.5));
    lut[i] = v;
  }
  const s = p.s;
  const m = [0.213 + 0.787 * s, 0.715 - 0.715 * s, 0.072 - 0.072 * s,
             0.213 - 0.213 * s, 0.715 + 0.285 * s, 0.072 - 0.072 * s,
             0.213 - 0.213 * s, 0.715 - 0.715 * s, 0.072 + 0.928 * s];
  const [gr, gg, gb] = wbGains(p.k);
  const doSat = s !== 1;
  const img = ctx.getImageData(0, 0, w, h); const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    let r = lut[d[i]], g = lut[d[i + 1]], b = lut[d[i + 2]];
    if (doSat) {
      const r2 = m[0] * r + m[1] * g + m[2] * b, g2 = m[3] * r + m[4] * g + m[5] * b, b2 = m[6] * r + m[7] * g + m[8] * b;
      r = r2 < 0 ? 0 : r2 > 1 ? 1 : r2; g = g2 < 0 ? 0 : g2 > 1 ? 1 : g2; b = b2 < 0 ? 0 : b2 > 1 ? 1 : b2;
    }
    d[i] = r * gr * 255 + 0.5; d[i + 1] = g * gg * 255 + 0.5; d[i + 2] = b * gb * 255 + 0.5; // Uint8Clamped clamps
  }
  ctx.putImageData(img, 0, 0);
}

/* ---------- Camera ---------- */
function stopStream() {
  if (state.stream) state.stream.getTracks().forEach((t) => t.stop());
  state.stream = null; state.track = null;
}
async function startCamera() {
  if (state.starting) return; state.starting = true;
  const msg = $('startMsg');
  try {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw Object.assign(new Error('이 화면에서는 카메라를 쓸 수 없어요. Safari로 직접 열어 주세요 (https 주소 필요).'), { friendly: true });
    }
    stopStream();
    const r = RES[state.resIdx];
    const tries = [
      { video: { facingMode: { ideal: state.facing }, width: { ideal: r.w }, height: { ideal: r.h } }, audio: false },
      { video: { facingMode: { ideal: state.facing } }, audio: false },
      { video: true, audio: false },
    ];
    let stream, lastErr;
    for (const c of tries) {
      try { stream = await navigator.mediaDevices.getUserMedia(c); break; } catch (e) {
        lastErr = e; if (e.name === 'NotAllowedError' || e.name === 'SecurityError') break;
      }
    }
    if (!stream) throw lastErr;
    state.stream = stream; state.track = stream.getVideoTracks()[0];
    state.track.addEventListener('ended', () => { if (!document.hidden) toast('카메라가 꺼졌어요. 다시 켜는 중…'), startCamera(); });
    video.srcObject = stream;
    await video.play().catch(() => {});
    await new Promise((res) => (video.videoWidth ? res() : video.addEventListener('loadedmetadata', res, { once: true })));
    const st = state.track.getSettings ? state.track.getSettings() : {};
    if (st.facingMode) state.facing = st.facingMode === 'user' ? 'user' : 'environment';
    video.classList.toggle('mirror', state.facing === 'user');
    $('mirrorRow').hidden = state.facing !== 'user';
    $('startScreen').hidden = true;
    updateRes(); buildControls(); layoutGrid();
  } catch (e) {
    $('startScreen').hidden = false;
    let t = e && e.friendly ? e.message : '카메라를 켤 수 없어요: ' + (e && (e.name || e.message));
    if (e && e.name === 'NotAllowedError') t = '카메라 권한이 거부됐어요. 설정 > Safari > 카메라에서 "허용"으로 바꾼 뒤 다시 눌러 주세요.';
    if (navigator.standalone) t += ' (홈 화면 앱에서 계속 안 되면 Safari에서 열어 주세요.)';
    msg.textContent = t;
  } finally { state.starting = false; }
}
function updateRes() {
  const w = video.videoWidth, h = video.videoHeight;
  $('resLabel').textContent = w ? `${w}×${h} (${((w * h) / 1e6).toFixed(1)}MP)` : '—';
}
video.addEventListener('resize', () => { updateRes(); layoutGrid(); });
window.addEventListener('resize', layoutGrid);

function layoutGrid() {
  const g = $('grid'), vw = video.videoWidth, vh = video.videoHeight;
  if (!vw) return;
  const W = innerWidth, H = innerHeight, sc = Math.min(W / vw, H / vh);
  const w = vw * sc, h = vh * sc;
  Object.assign(g.style, { width: w + 'px', height: h + 'px', left: (W - w) / 2 + 'px', top: (H - h) / 2 + 'px' });
}

/* ---------- Capability-driven controls ---------- */
const CAP_LABEL = {
  zoom: '줌', exposureCompensation: '노출 보정', iso: 'ISO', exposureTime: '셔터(노출시간)',
  colorTemperature: '색온도(K, 카메라)', focusDistance: '초점 거리',
  exposureMode: '노출 모드', whiteBalanceMode: '화이트밸런스 모드', focusMode: '초점 모드',
};
const MODE_LABEL = { continuous: '자동', manual: '고정/수동', 'single-shot': '한 번 맞춤', none: '없음' };
const NEEDS_MANUAL = { iso: 'exposureMode', exposureTime: 'exposureMode', colorTemperature: 'whiteBalanceMode', focusDistance: 'focusMode' };
async function setConstraint(obj) {
  try {
    await state.track.applyConstraints({ advanced: [obj] });
  } catch (e) { toast('적용 실패: ' + (e.name || e.message)); }
  refreshControlValues();
}
function buildControls() {
  const box = $('camControls'); box.innerHTML = '';
  const tr = state.track; $('btnTorch').hidden = true;
  const caps = tr && tr.getCapabilities ? tr.getCapabilities() : {};
  const supported = [];
  for (const key of ['exposureMode', 'whiteBalanceMode', 'focusMode']) {
    const v = caps[key]; if (!Array.isArray(v) || !v.length) continue; supported.push(key);
    const lab = document.createElement('label'); lab.textContent = CAP_LABEL[key];
    const sel = document.createElement('select'); sel.dataset.key = key;
    for (const m of v) { const o = document.createElement('option'); o.value = m; o.textContent = MODE_LABEL[m] || m; sel.appendChild(o); }
    sel.onchange = () => setConstraint({ [key]: sel.value });
    lab.appendChild(sel); box.appendChild(lab);
  }
  for (const key of ['zoom', 'exposureCompensation', 'iso', 'exposureTime', 'colorTemperature', 'focusDistance']) {
    const v = caps[key]; if (!v || typeof v.max !== 'number' || v.max <= v.min) continue; supported.push(key);
    const lab = document.createElement('label'); lab.innerHTML = `${CAP_LABEL[key]} <output></output>`;
    const inp = document.createElement('input'); inp.type = 'range'; inp.dataset.key = key;
    inp.min = v.min; inp.max = v.max; inp.step = v.step || (v.max - v.min) / 100;
    inp.oninput = () => { lab.querySelector('output').textContent = fmt(key, +inp.value); };
    inp.onchange = () => {
      const o = { [key]: +inp.value }; const mk = NEEDS_MANUAL[key];
      if (mk && Array.isArray(caps[mk]) && caps[mk].includes('manual')) o[mk] = 'manual';
      setConstraint(o);
    };
    lab.appendChild(inp); box.appendChild(lab);
  }
  if (caps.torch === true || (Array.isArray(caps.torch) && caps.torch.includes(true))) { supported.push('torch'); $('btnTorch').hidden = false; }
  $('capsInfo').textContent = supported.length
    ? '이 브라우저가 지원하는 제어: ' + supported.map((k) => CAP_LABEL[k] || '손전등').join(', ') + '. (지원 안 되는 ISO·셔터 등은 숨겼어요)'
    : '이 브라우저는 카메라 수동 제어(ISO·셔터·노출 고정)를 지원하지 않아요. 위 보정 슬라이더를 쓰세요.';
  refreshControlValues();
}
function fmt(key, v) {
  if (key === 'exposureTime') return v >= 10000 ? (v / 10000).toFixed(2) + '초' : '1/' + Math.round(10000 / v) + '초';
  if (key === 'zoom') return v.toFixed(1) + '×';
  if (key === 'colorTemperature') return Math.round(v) + 'K';
  return Math.round(v * 100) / 100 + '';
}
function refreshControlValues() {
  if (!state.track || !state.track.getSettings) return;
  const st = state.track.getSettings();
  document.querySelectorAll('#camControls [data-key]').forEach((el) => {
    const k = el.dataset.key; if (st[k] === undefined) return;
    el.value = st[k];
    const out = el.parentElement.querySelector('output'); if (out) out.textContent = fmt(k, +st[k]);
  });
  const tb = $('btnTorch'); tb.textContent = st.torch ? '🔦 켬' : '🔦 끔'; tb.classList.toggle('on', !!st.torch);
}
$('btnTorch').onclick = () => setConstraint({ torch: !(state.track.getSettings().torch) });

/* ---------- Capture ---------- */
function stamp() {
  const d = new Date(), p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
async function shoot() {
  if (!state.track || !video.videoWidth) return toast('카메라가 아직 준비되지 않았어요');
  $('shutter').disabled = true;
  try {
    for (let n = state.timer; n > 0; n--) {
      $('countdown').hidden = false; $('countdown').textContent = n;
      await new Promise((r) => setTimeout(r, 1000));
    }
    $('countdown').hidden = true;
    const w = video.videoWidth, h = video.videoHeight;
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    const mirror = state.facing === 'user' && state.saveMirror;
    if (mirror) { ctx.translate(w, 0); ctx.scale(-1, 1); }
    ctx.drawImage(video, 0, 0, w, h); // exact live frame, no photo pipeline
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const f = $('flash'); f.classList.add('on'); requestAnimationFrame(() => requestAnimationFrame(() => f.classList.remove('on')));
    state.raw = c;
    const rawUrl = await blobUrl(c, 0.95);
    setImg($('reviewImg'), rawUrl); // CSS filter shows adjustments on top of raw
    $('reviewInfo').textContent = `${w}×${h} · ${state.facing === 'user' ? '전면' : '후면'}${mirror ? ' · 좌우반전' : ''}`;
    $('review').hidden = false;
    await prepareFile();
  } catch (e) {
    console.error(e); toast('촬영 오류: ' + (e.name || e.message));
  } finally { $('shutter').disabled = false; $('countdown').hidden = true; }
}
function blobUrl(canvas, q) {
  return new Promise((res, rej) => canvas.toBlob((b) => (b ? res(URL.createObjectURL(b)) : rej(new Error('toBlob 실패'))), 'image/jpeg', q));
}
function setImg(img, url) { if (img._url && img._url !== $('thumbImg')._url) URL.revokeObjectURL(img._url); img._url = url; img.src = url; }
// Build the final processed JPEG ahead of time so the save tap can call navigator.share immediately.
async function prepareFile() {
  if (!state.raw) return;
  const token = ++state.prepToken; state.file = null; $('btnSave').textContent = '준비 중…';
  const src = state.raw, w = src.width, h = src.height;
  let out = src;
  if (!isNeutral()) {
    out = document.createElement('canvas'); out.width = w; out.height = h;
    const ctx = out.getContext('2d', { willReadFrequently: true }); ctx.drawImage(src, 0, 0);
    applyPixels(ctx, w, h);
  }
  const blob = await new Promise((r) => out.toBlob(r, 'image/jpeg', 0.95));
  if (token !== state.prepToken || !blob) return;
  state.file = new File([blob], `rawcam_${stamp()}.jpg`, { type: 'image/jpeg', lastModified: Date.now() });
  const u = URL.createObjectURL(blob); const ti = $('thumbImg');
  if (ti._url) URL.revokeObjectURL(ti._url); ti._url = u; ti.src = u;
  $('btnSave').textContent = '저장';
}
async function save() {
  const f = state.file; if (!f) return toast('잠시만요, 사진 준비 중이에요');
  if (navigator.canShare && navigator.canShare({ files: [f] })) {
    try { await navigator.share({ files: [f] }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  const a = document.createElement('a'); a.href = URL.createObjectURL(f); a.download = f.name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
  toast('다운로드했어요. 안 되면 사진을 길게 눌러 "사진에 저장"을 고르세요.', 3500);
  // Long-press fallback: show final processed image without CSS filter
  setImg($('reviewImg'), URL.createObjectURL(f)); $('reviewImg').style.filter = 'none';
}

/* ---------- UI wiring ---------- */
$('btnStart').onclick = startCamera;
$('shutter').onclick = shoot;
$('btnFlip').onclick = () => { state.facing = state.facing === 'user' ? 'environment' : 'user'; startCamera(); };
$('btnRes').onclick = () => { state.resIdx = (state.resIdx + 1) % RES.length; $('btnRes').textContent = RES[state.resIdx].name; startCamera(); };
$('btnTimer').onclick = () => { state.timer = state.timer ? 0 : 3; $('btnTimer').textContent = state.timer ? '⏱ 3초' : '⏱ 끔'; $('btnTimer').classList.toggle('on', !!state.timer); };
$('btnGrid').onclick = () => { state.grid = !state.grid; $('grid').hidden = !state.grid; $('btnGrid').textContent = state.grid ? '격자 켬' : '격자 끔'; $('btnGrid').classList.toggle('on', state.grid); layoutGrid(); };
$('btnPanel').onclick = () => { $('panel').hidden = !$('panel').hidden; };
$('btnClosePanel').onclick = () => { $('panel').hidden = true; };
$('btnAdjustReview').onclick = () => { $('panel').hidden = false; };
$('thumb').onclick = () => { if (state.raw) { $('reviewImg').style.filter = cssFilter(); $('review').hidden = false; } };
$('btnCloseReview').onclick = () => { $('review').hidden = true; $('panel').hidden = true; };
$('btnSave').onclick = save;
$('chkMirror').onchange = (e) => { state.saveMirror = e.target.checked; };
let prepT;
for (const k of ['b', 'c', 't', 's']) {
  $('s_' + k).addEventListener('input', (e) => {
    state.adj[k] = +e.target.value; updateFilters();
    if (!$('review').hidden) { clearTimeout(prepT); prepT = setTimeout(prepareFile, 300); }
  });
}
$('btnReset').onclick = () => {
  for (const k of ['b', 'c', 't', 's']) { state.adj[k] = 0; $('s_' + k).value = 0; }
  updateFilters(); if (!$('review').hidden) prepareFile();
};
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  if (!state.track || state.track.readyState === 'ended' || video.paused) startCamera();
});
updateFilters();
startCamera();
window.__rawcam = { state, applyPixels, shoot, save };
