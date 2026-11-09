'use strict';
const $ = (id) => document.getElementById(id);
const video = $('video');
const state = { stream: null, track: null, facing: 'environment', resIdx: 0, saveMirror: true, file: null, starting: false };
const RES = [
  { name: '4:3 최대', w: 4032, h: 3024 },
  { name: '16:9 4K', w: 3840, h: 2160 },
  { name: '1080p', w: 1920, h: 1080 },
];

function toast(msg, ms = 2200) {
  const t = $('toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), ms);
}

/* ---------- Camera ---------- */
function stopStream() {
  if (state.stream) state.stream.getTracks().forEach((t) => t.stop());
  state.stream = null; state.track = null;
}
async function startCamera() {
  if (state.starting) return; state.starting = true;
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
    state.track.addEventListener('ended', () => { if (!document.hidden) { toast('카메라가 꺼졌어요. 다시 켜는 중…'); startCamera(); } });
    video.srcObject = stream;
    await video.play().catch(() => {});
    await new Promise((res) => (video.videoWidth ? res() : video.addEventListener('loadedmetadata', res, { once: true })));
    const st = state.track.getSettings ? state.track.getSettings() : {};
    if (st.facingMode) state.facing = st.facingMode === 'user' ? 'user' : 'environment';
    video.classList.toggle('mirror', state.facing === 'user');
    $('btnMirror').hidden = state.facing !== 'user';
    $('startScreen').hidden = true;
    updateRes();
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

/* ---------- Capture: raw video frame, no filters ---------- */
function stamp() {
  const d = new Date(), p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
function setUrl(img, url) { if (img._url) URL.revokeObjectURL(img._url); img._url = url; img.src = url; }
async function shoot() {
  if (!state.track || !video.videoWidth) return toast('카메라가 아직 준비되지 않았어요');
  $('shutter').disabled = true;
  try {
    const w = video.videoWidth, h = video.videoHeight;
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    const mirror = state.facing === 'user' && state.saveMirror;
    if (mirror) { ctx.translate(w, 0); ctx.scale(-1, 1); }
    ctx.drawImage(video, 0, 0, w, h); // exact live frame, no photo pipeline
    const f = $('flash'); f.classList.add('on'); requestAnimationFrame(() => requestAnimationFrame(() => f.classList.remove('on')));
    state.file = null; $('btnSave').textContent = '준비 중…';
    const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.95));
    if (!blob) throw new Error('이미지 만들기 실패');
    state.file = new File([blob], `rawcam_${stamp()}.jpg`, { type: 'image/jpeg', lastModified: Date.now() });
    setUrl($('reviewImg'), URL.createObjectURL(blob));
    setUrl($('thumbImg'), URL.createObjectURL(blob));
    $('reviewInfo').textContent = `${w}×${h} · ${state.facing === 'user' ? '전면' : '후면'}${mirror ? ' · 좌우반전' : ''}`;
    $('btnSave').textContent = '저장';
    $('review').hidden = false;
  } catch (e) {
    console.error(e); toast('촬영 오류: ' + (e.name || e.message));
  } finally { $('shutter').disabled = false; }
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
}

/* ---------- UI ---------- */
$('btnStart').onclick = startCamera;
$('shutter').onclick = shoot;
$('btnFlip').onclick = () => { state.facing = state.facing === 'user' ? 'environment' : 'user'; startCamera(); };
$('btnRes').onclick = () => { state.resIdx = (state.resIdx + 1) % RES.length; $('btnRes').textContent = RES[state.resIdx].name; startCamera(); };
$('btnMirror').onclick = () => {
  state.saveMirror = !state.saveMirror;
  $('btnMirror').textContent = state.saveMirror ? '반전 저장 켬' : '반전 저장 끔';
  $('btnMirror').classList.toggle('on', state.saveMirror);
};
$('thumb').onclick = () => { if (state.file) $('review').hidden = false; };
$('btnCloseReview').onclick = () => { $('review').hidden = true; };
$('btnSave').onclick = save;
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  if (!state.track || state.track.readyState === 'ended' || video.paused) startCamera();
});
startCamera();
window.__rawcam = { state, shoot, save };
