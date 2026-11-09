'use strict';
const $ = (id) => document.getElementById(id);
const video = $('video');
const state = {
  stream: null, track: null, facing: 'environment', resIdx: 0,
  mode: 'photo',             // 'photo' | 'video'
  photoMirror: true,         // front photo saved like preview
  videoMirror: false,        // front video: raw (unmirrored) by default — mirroring needs a per-frame canvas copy
  audio: null,               // mic stream, requested only when entering video mode
  rec: null, recording: false, file: null, starting: false,
};
const RES = [
  { name: '4:3 최대', w: 4032, h: 3024 },
  { name: '16:9 4K', w: 3840, h: 2160 },
  { name: '1080p', w: 1920, h: 1080 },
];
const MIME_CANDIDATES = [
  'video/mp4;codecs=avc1,mp4a', 'video/mp4;codecs="avc1.640028,mp4a.40.2"', 'video/mp4',
  'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm',
];

function toast(msg, ms = 2200) {
  const t = $('toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), ms);
}
function stamp() {
  const d = new Date(), p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
function setUrl(el, url) { if (el._url) URL.revokeObjectURL(el._url); el._url = url; if (url) el.src = url; else el.removeAttribute('src'); }

/* ---------- Camera ---------- */
function stopStream() {
  if (state.stream) state.stream.getTracks().forEach((t) => t.stop());
  state.stream = null; state.track = null;
}
async function startCamera() {
  if (state.starting || state.recording) return; state.starting = true;
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
    state.track.addEventListener('ended', () => {
      if (state.recording) stopRecording();
      if (!document.hidden) { toast('카메라가 꺼졌어요. 다시 켜는 중…'); startCamera(); }
    });
    video.srcObject = stream;
    await video.play().catch(() => {});
    await new Promise((res) => (video.videoWidth ? res() : video.addEventListener('loadedmetadata', res, { once: true })));
    const st = state.track.getSettings ? state.track.getSettings() : {};
    if (st.facingMode) state.facing = st.facingMode === 'user' ? 'user' : 'environment';
    video.classList.toggle('mirror', state.facing === 'user');
    $('startScreen').hidden = true;
    updateRes(); updateMirrorBtn();
  } catch (e) {
    $('startScreen').hidden = false;
    let t = e && e.friendly ? e.message : '카메라를 켤 수 없어요: ' + (e && (e.name || e.message));
    if (e && e.name === 'NotAllowedError') t = '카메라 권한이 거부됐어요. 설정 > Safari > 카메라에서 "허용"으로 바꾼 뒤 다시 눌러 주세요.';
    if (navigator.standalone) t += ' (홈 화면 앱에서 계속 안 되면 Safari에서 열어 주세요.)';
    $('startMsg').textContent = t;
  } finally { state.starting = false; }
}
function updateRes() {
  const w = video.videoWidth, h = video.videoHeight;
  $('resLabel').textContent = w ? `${w}×${h} (${((w * h) / 1e6).toFixed(1)}MP)` : '—';
}
video.addEventListener('resize', updateRes);

/* ---------- Mirror option (separate for photo / video) ---------- */
function mirrorOn() { return state.mode === 'video' ? state.videoMirror : state.photoMirror; }
function updateMirrorBtn() {
  const b = $('btnMirror'); b.hidden = state.facing !== 'user';
  b.textContent = mirrorOn() ? '반전 저장 켬' : '반전 저장 끔';
  b.classList.toggle('on', mirrorOn());
}
$('btnMirror').onclick = () => {
  if (state.recording) return;
  if (state.mode === 'video') {
    state.videoMirror = !state.videoMirror;
    if (state.videoMirror) toast('반전 동영상은 화면을 한 번 더 그려서 녹화해요. 화질이 조금 낮아질 수 있어요(최대 1080p).', 3500);
  } else state.photoMirror = !state.photoMirror;
  updateMirrorBtn();
};

/* ---------- Photo: raw video frame, no filters ---------- */
async function shootPhoto() {
  if (!state.track || !video.videoWidth) return toast('카메라가 아직 준비되지 않았어요');
  $('shutter').disabled = true;
  try {
    const w = video.videoWidth, h = video.videoHeight;
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    const mirror = state.facing === 'user' && state.photoMirror;
    if (mirror) { ctx.translate(w, 0); ctx.scale(-1, 1); }
    ctx.drawImage(video, 0, 0, w, h); // exact live frame, no photo pipeline
    flash();
    state.file = null; $('btnSave').textContent = '준비 중…';
    const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.95));
    if (!blob) throw new Error('이미지 만들기 실패');
    state.file = new File([blob], `rawcam_${stamp()}.jpg`, { type: 'image/jpeg', lastModified: Date.now() });
    showReview(blob, `${w}×${h} · ${state.facing === 'user' ? '전면' : '후면'}${mirror ? ' · 좌우반전' : ''}`);
  } catch (e) {
    console.error(e); toast('촬영 오류: ' + (e.name || e.message));
  } finally { $('shutter').disabled = false; }
}
function flash() {
  const f = $('flash'); f.classList.add('on');
  requestAnimationFrame(() => requestAnimationFrame(() => f.classList.remove('on')));
}

/* ---------- Video ---------- */
function pickMime() {
  if (!window.MediaRecorder) return null;
  if (!MediaRecorder.isTypeSupported) return '';
  return MIME_CANDIDATES.find((m) => MediaRecorder.isTypeSupported(m)) || '';
}
function bitrateFor(w, h) { // ~16 Mbps at 4K, scaled by pixel count, clamped 4–20 Mbps
  return Math.round(Math.min(20e6, Math.max(4e6, w * h * 1.93)));
}
async function ensureMic() {
  if (state.audio && state.audio.getAudioTracks().some((t) => t.readyState === 'live')) return true;
  try {
    state.audio = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    return true;
  } catch (e) {
    state.audio = null;
    toast('마이크를 쓸 수 없어서 소리 없이 녹화해요. (설정 > Safari > 마이크)', 3500);
    return false;
  }
}
function releaseMic() { if (state.audio) state.audio.getTracks().forEach((t) => t.stop()); state.audio = null; }

let mirrorLoop = null;
async function startRecording() {
  if (!state.track || !video.videoWidth) return toast('카메라가 아직 준비되지 않았어요');
  const mime = pickMime();
  if (mime === null) return toast('이 브라우저는 동영상 녹화를 지원하지 않아요');
  await ensureMic();
  let vTrack = state.track, w = video.videoWidth, h = video.videoHeight, mirrored = false;
  if (state.facing === 'user' && state.videoMirror) {
    const sc = Math.min(1, 1920 / Math.max(w, h)); // cap mirrored canvas at 1080p for smoothness
    const cw = Math.round(w * sc / 2) * 2, ch = Math.round(h * sc / 2) * 2;
    const c = document.createElement('canvas'); c.width = cw; c.height = ch;
    const ctx = c.getContext('2d'); ctx.translate(cw, 0); ctx.scale(-1, 1);
    const draw = () => { ctx.drawImage(video, 0, 0, cw, ch); mirrorLoop = requestAnimationFrame(draw); };
    draw();
    vTrack = c.captureStream(30).getVideoTracks()[0]; w = cw; h = ch; mirrored = true;
  }
  const tracks = [vTrack, ...(state.audio ? state.audio.getAudioTracks() : [])];
  const opts = { videoBitsPerSecond: bitrateFor(w, h), audioBitsPerSecond: 128000 };
  if (mime) opts.mimeType = mime;
  let rec;
  try { rec = new MediaRecorder(new MediaStream(tracks), opts); } catch (e) {
    try { rec = new MediaRecorder(new MediaStream(tracks)); } catch (e2) { stopMirrorLoop(vTrack, mirrored); return toast('녹화 시작 실패: ' + (e2.name || e2.message)); }
  }
  const chunks = [];
  rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  rec.onstop = () => {
    stopMirrorLoop(vTrack, mirrored);
    const type = (rec.mimeType || mime || 'video/mp4').split(';')[0];
    const blob = new Blob(chunks, { type });
    finishRecording(blob, type, `${w}×${h} · ${state.facing === 'user' ? '전면' : '후면'}${mirrored ? ' · 좌우반전' : ''}`);
  };
  rec.onerror = (e) => toast('녹화 오류: ' + ((e.error && e.error.name) || '알 수 없음'));
  rec.start(1000);
  state.rec = rec; state.recording = true; state.recStart = Date.now();
  setRecUI(true);
}
function stopMirrorLoop(track, mirrored) {
  if (!mirrored) return;
  cancelAnimationFrame(mirrorLoop); mirrorLoop = null; track.stop();
}
function stopRecording() {
  if (!state.recording) return;
  state.recording = false; setRecUI(false);
  try { state.rec.stop(); } catch (e) { console.error(e); }
}
function finishRecording(blob, type, info) {
  if (!blob.size) return toast('녹화된 내용이 없어요. 다시 시도해 주세요.');
  const ext = type.includes('mp4') ? 'mp4' : type.includes('webm') ? 'webm' : 'mp4';
  state.file = new File([blob], `rawcam_${stamp()}.${ext}`, { type, lastModified: Date.now() });
  $('btnSave').textContent = '저장';
  const secs = Math.round((Date.now() - state.recStart) / 1000);
  showReview(blob, `${info} · ${secs}초 · ${(blob.size / 1e6).toFixed(1)}MB`, true);
}
let recTimer = null;
function setRecUI(on) {
  $('shutter').classList.toggle('rec', on);
  for (const id of ['btnFlip', 'btnRes', 'modePhoto', 'modeVideo']) $(id).disabled = on;
  $('btnMirror').disabled = on;
  $('recTime').hidden = !on;
  clearInterval(recTimer);
  if (on) {
    const tick = () => {
      const s = Math.floor((Date.now() - state.recStart) / 1000);
      $('recTime').querySelector('span').textContent = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
    };
    tick(); recTimer = setInterval(tick, 250);
  }
}

/* ---------- Mode ---------- */
async function setMode(m) {
  if (state.recording || state.mode === m) return;
  state.mode = m;
  $('modePhoto').classList.toggle('on', m === 'photo');
  $('modeVideo').classList.toggle('on', m === 'video');
  $('shutter').classList.toggle('video', m === 'video');
  $('shutter').setAttribute('aria-label', m === 'video' ? '녹화' : '촬영');
  updateMirrorBtn();
  if (m === 'video') await ensureMic(); else releaseMic();
}

/* ---------- Review / save ---------- */
function showReview(blob, info, isVideo = false) {
  const img = $('reviewImg'), vid = $('reviewVideo');
  if (isVideo) {
    setUrl(img, null); img.hidden = true;
    setUrl(vid, URL.createObjectURL(blob)); vid.hidden = false;
    $('reviewHint').textContent = '저장 버튼 → "동영상 저장"을 누르면 사진 앱에 들어가요.';
  } else {
    vid.pause(); setUrl(vid, null); vid.hidden = true;
    setUrl(img, URL.createObjectURL(blob)); img.hidden = false;
    $('reviewHint').textContent = '저장 버튼 → "이미지 저장"을 누르면 사진 앱에 들어가요. 안 되면 사진을 길게 눌러 저장하세요.';
  }
  $('reviewInfo').textContent = info;
  $('btnSave').textContent = '저장';
  $('review').hidden = false;
}
async function save() {
  const f = state.file; if (!f) return toast('잠시만요, 준비 중이에요');
  if (navigator.canShare && navigator.canShare({ files: [f] })) {
    try { await navigator.share({ files: [f] }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  const a = document.createElement('a'); a.href = URL.createObjectURL(f); a.download = f.name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
  toast('다운로드했어요. 안 되면 길게 눌러 저장하세요.', 3500);
}

/* ---------- UI ---------- */
$('btnStart').onclick = startCamera;
$('shutter').onclick = () => {
  if (state.mode === 'photo') return shootPhoto();
  return state.recording ? stopRecording() : startRecording();
};
$('btnFlip').onclick = () => { if (state.recording) return; state.facing = state.facing === 'user' ? 'environment' : 'user'; startCamera(); };
$('btnRes').onclick = () => { if (state.recording) return; state.resIdx = (state.resIdx + 1) % RES.length; $('btnRes').textContent = RES[state.resIdx].name; startCamera(); };
$('modePhoto').onclick = () => setMode('photo');
$('modeVideo').onclick = () => setMode('video');
$('btnCloseReview').onclick = () => { $('reviewVideo').pause(); $('review').hidden = true; };
$('btnSave').onclick = save;
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { if (state.recording) stopRecording(); return; }
  if (!state.track || state.track.readyState === 'ended' || video.paused) startCamera();
});
startCamera();
window.__rawcam = { state, pickMime, bitrateFor };

/* ---------- Block page pinch-zoom / double-tap zoom (iOS ignores user-scalable=no) ---------- */
for (const ev of ['gesturestart', 'gesturechange', 'gestureend']) document.addEventListener(ev, (e) => e.preventDefault(), { passive: false });
document.addEventListener('touchmove', (e) => { if (e.touches.length > 1) e.preventDefault(); }, { passive: false });
let lastTouchEnd = 0;
document.addEventListener('touchend', (e) => {
  const now = Date.now();
  const t = e.target;
  if (now - lastTouchEnd < 350 && t.id !== 'reviewImg' && t.id !== 'reviewVideo') {
    e.preventDefault(); const b = t.closest('button'); if (b && !b.disabled) b.click();
  }
  lastTouchEnd = now;
}, { passive: false });
document.addEventListener('dblclick', (e) => e.preventDefault(), { passive: false });
