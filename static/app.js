const $ = (id) => document.getElementById(id);

const state = { info: null, mode: 'video', quality: 'best' };
const config = { public: false, file_ttl_minutes: 60 };
const jobEls = new Map();
const autoSaved = new Set();
let pollTimer = null;

// A random id per browser, so each visitor only sees their own downloads.
const visitor = (() => {
  const make = () => (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2) + Date.now()).replace(/[^A-Za-z0-9_-]/g, '');
  try {
    let id = localStorage.getItem('visitor');
    if (!id) { id = make(); localStorage.setItem('visitor', id); }
    return id;
  } catch {
    return make();
  }
})();

const ICONS = {
  save: '<svg viewBox="0 0 24 24"><path d="M12 4v11m0 0-4.5-4.5M12 15l4.5-4.5M6 20h12"/></svg>',
  play: '<svg viewBox="0 0 24 24"><path d="M7 4.5v15l12-7.5z"/></svg>',
  folder: '<svg viewBox="0 0 24 24"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>',
  retry: '<svg viewBox="0 0 24 24"><path d="M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5"/></svg>',
  close: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg>',
};

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json', 'X-Visitor': visitor },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

/* ---------- formatting ---------- */
function fmtDuration(s) {
  if (!s && s !== 0) return '';
  s = Math.round(s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}
function fmtBytes(b) {
  if (!b) return '';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
  return `${b.toFixed(b < 10 && i ? 1 : 0)} ${u[i]}`;
}
function fmtViews(n) {
  if (!n) return '';
  return new Intl.NumberFormat('en', { notation: 'compact' }).format(n) + ' views';
}
function qualityName(h) {
  return { 4320: '8K', 2160: '4K', 1440: '2K' }[h] || `${h}p`;
}
function qualityTag(h) {
  if (h >= 2160) return 'Ultra HD';
  if (h >= 1080) return 'Full HD';
  if (h >= 720) return 'HD';
  return '';
}

function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, 2600);
}

function showError(msg) {
  const e = $('error');
  e.textContent = msg || '';
  e.hidden = !msg;
}

/* ---------- fetch info ---------- */
$('searchForm').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const url = $('url').value.trim();
  if (!url) return;
  const btn = $('fetchBtn');
  btn.disabled = true;
  btn.classList.add('loading');
  btn.querySelector('.btn-label').textContent = 'Looking…';
  showError('');
  try {
    state.info = await api('/api/info', { method: 'POST', body: { url } });
    renderPreview();
  } catch (err) {
    $('preview').hidden = true;
    showError(err.message);
  } finally {
    btn.disabled = false;
    btn.classList.remove('loading');
    btn.querySelector('.btn-label').textContent = 'Get video';
  }
});

$('pasteBtn').addEventListener('click', async () => {
  try {
    const text = await navigator.clipboard.readText();
    if (text) {
      $('url').value = text.trim();
      $('searchForm').requestSubmit();
    }
  } catch {
    $('url').focus();
    toast('Press Ctrl+V to paste the link');
  }
});

function renderPreview() {
  const i = state.info;
  $('thumb').src = i.thumbnail || '';
  $('thumb').alt = i.title;
  $('duration').textContent = fmtDuration(i.duration);
  $('site').textContent = i.site || 'Video';
  $('title').textContent = i.title;
  $('meta').textContent = [i.uploader, fmtViews(i.views)].filter(Boolean).join(' · ');
  setMode(i.has_video ? 'video' : 'audio');
  $('modeSwitch').querySelector('[data-mode="video"]').disabled = !i.has_video;
  $('preview').hidden = false;
  $('preview').style.animation = 'none';
  void $('preview').offsetWidth;
  $('preview').style.animation = '';
}

/* ---------- options ---------- */
$('modeSwitch').addEventListener('click', (ev) => {
  const btn = ev.target.closest('button[data-mode]');
  if (btn && !btn.disabled) setMode(btn.dataset.mode);
});

function setMode(mode) {
  state.mode = mode;
  const sw = $('modeSwitch');
  sw.classList.toggle('audio', mode === 'audio');
  sw.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
  renderChips();
}

function renderChips() {
  const chips = $('chips');
  let options;
  if (state.mode === 'audio') {
    $('qualityLabel').textContent = 'Audio format';
    options = [
      { value: 'mp3', label: 'MP3', tag: 'Plays anywhere' },
      { value: 'm4a', label: 'M4A', tag: 'Original quality' },
    ];
  } else {
    $('qualityLabel').textContent = 'Quality';
    const heights = (state.info?.heights || []).filter((h) => h >= 240).slice(0, 6);
    options = [{ value: 'best', label: 'Best', tag: heights[0] ? qualityName(heights[0]) : '' }]
      .concat(heights.map((h) => ({ value: String(h), label: qualityName(h), tag: qualityTag(h) })));
  }
  state.quality = options[0].value;
  chips.innerHTML = '';
  for (const o of options) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip' + (o.value === state.quality ? ' active' : '');
    b.dataset.value = o.value;
    b.innerHTML = `${o.label}${o.tag ? ` <small>${o.tag}</small>` : ''}`;
    b.addEventListener('click', () => {
      state.quality = o.value;
      chips.querySelectorAll('.chip').forEach((c) => c.classList.toggle('active', c === b));
      updateDownloadLabel();
    });
    chips.appendChild(b);
  }
  updateDownloadLabel();
}

function updateDownloadLabel() {
  let label;
  if (state.mode === 'audio') label = `Download ${state.quality.toUpperCase()}`;
  else if (state.quality === 'best') label = 'Download best quality';
  else label = `Download ${qualityName(Number(state.quality))}`;
  $('downloadLabel').textContent = label;
}

/* ---------- download ---------- */
$('downloadBtn').addEventListener('click', async () => {
  if (!state.info) return;
  const btn = $('downloadBtn');
  btn.disabled = true;
  try {
    await api('/api/download', {
      method: 'POST',
      body: {
        url: state.info.url, mode: state.mode, quality: state.quality,
        title: state.info.title, thumbnail: state.info.thumbnail,
      },
    });
    toast('Download started');
    await refreshJobs();
    document.querySelector('.downloads').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (err) {
    toast(err.message);
  } finally {
    btn.disabled = false;
  }
});

$('openFolder').addEventListener('click', () => api('/api/open-folder', { method: 'POST' }).catch((e) => toast(e.message)));

/* ---------- jobs list ---------- */
function createJobEl(job) {
  const li = document.createElement('li');
  li.className = 'job card';
  li.innerHTML = `
    <div class="job-thumb"><span class="kind"></span></div>
    <div class="job-body">
      <div class="job-title"></div>
      <div class="bar"><span></span></div>
      <div class="job-status"><span class="dot"></span><span class="status-text"></span></div>
    </div>
    <div class="job-actions">
      <button class="icon-btn play" data-act="save" title="Save to this device" hidden>${ICONS.save}</button>
      <button class="icon-btn play" data-act="open" title="Open file" hidden>${ICONS.play}</button>
      <button class="icon-btn" data-act="reveal" title="Show in folder" hidden>${ICONS.folder}</button>
      <button class="icon-btn" data-act="retry" title="Try again" hidden>${ICONS.retry}</button>
      <button class="icon-btn" data-act="remove" title="Remove from list" hidden>${ICONS.close}</button>
    </div>`;
  li.querySelector('.job-thumb').style.backgroundImage = job.thumbnail ? `url("${job.thumbnail}")` : '';
  li.querySelector('.kind').textContent = job.mode === 'audio' ? job.quality : (job.quality === 'best' ? 'Best' : qualityName(Number(job.quality)));
  li.querySelector('.job-title').textContent = job.title;
  li.querySelector('.job-title').title = job.title;
  li.querySelector('.job-actions').addEventListener('click', (ev) => {
    const b = ev.target.closest('button[data-act]');
    if (b) jobAction(li.dataset.id, b.dataset.act, li._job);
  });
  return li;
}

function statusText(j) {
  switch (j.status) {
    case 'queued': return 'Starting…';
    case 'downloading': {
      const parts = [];
      if (j.percent != null) parts.push(`${j.percent.toFixed(0)}%`);
      if (j.total) parts.push(`${fmtBytes(j.downloaded)} of ${fmtBytes(j.total)}`);
      if (j.speed) parts.push(`${fmtBytes(j.speed)}/s`);
      if (j.eta != null) parts.push(`${fmtDuration(j.eta)} left`);
      return parts.join('  ·  ') || 'Downloading…';
    }
    case 'processing': return `${j.stage || 'Finishing up'}…`;
    case 'done': return ['Saved', fmtBytes(j.size), j.filename].filter(Boolean).join('  ·  ');
    case 'error': return j.error || 'Download failed';
    default: return '';
  }
}

function updateJobEl(li, j) {
  li._job = j;
  li.dataset.id = j.id;
  li.className = `job card ${j.status}`;
  li.querySelector('.bar span').style.width = `${Math.max(2, j.percent || 0)}%`;
  li.querySelector('.status-text').textContent = statusText(j);
  const finished = j.status === 'done' || j.status === 'error';
  li.querySelector('[data-act="save"]').hidden = !(j.status === 'done' && config.public);
  li.querySelector('[data-act="open"]').hidden = !(j.status === 'done' && !config.public);
  li.querySelector('[data-act="reveal"]').hidden = !(j.status === 'done' && !config.public);
  if (config.public && j.status === 'done' && !autoSaved.has(j.id)) {
    autoSaved.add(j.id);
    if (li._wasActive) saveFile(j.id);
  }
  li._wasActive = !finished;
  li.querySelector('[data-act="retry"]').hidden = j.status !== 'error';
  li.querySelector('[data-act="remove"]').hidden = !finished;
}

function saveFile(id) {
  const a = document.createElement('a');
  a.href = `/api/jobs/${id}/file?v=${encodeURIComponent(visitor)}`;
  a.download = '';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

async function jobAction(id, act, job) {
  try {
    if (act === 'save') { saveFile(id); return; }
    if (act === 'open') await api(`/api/jobs/${id}/open`, { method: 'POST' });
    if (act === 'reveal') await api(`/api/jobs/${id}/reveal`, { method: 'POST' });
    if (act === 'remove') { await api(`/api/jobs/${id}`, { method: 'DELETE' }); }
    if (act === 'retry') {
      await api('/api/download', { method: 'POST', body: { url: job.url, mode: job.mode, quality: job.quality, title: job.title, thumbnail: job.thumbnail } });
      await api(`/api/jobs/${id}`, { method: 'DELETE' });
    }
    await refreshJobs();
  } catch (err) {
    toast(err.message === 'Request failed (404)' ? 'That file was moved or deleted' : err.message);
  }
}

async function refreshJobs() {
  let list = [];
  try { list = await api('/api/jobs'); } catch { /* server restarting */ }
  const ul = $('jobs');
  const seen = new Set();
  list.forEach((j, idx) => {
    seen.add(j.id);
    let li = jobEls.get(j.id);
    if (!li) { li = createJobEl(j); jobEls.set(j.id, li); }
    updateJobEl(li, j);
    if (ul.children[idx] !== li) ul.insertBefore(li, ul.children[idx] || null);
  });
  for (const [id, li] of jobEls) {
    if (!seen.has(id)) { li.remove(); jobEls.delete(id); }
  }
  $('empty').hidden = list.length > 0;
  const active = list.filter((j) => !['done', 'error'].includes(j.status)).length;
  $('count').textContent = list.length ? (active ? `${active} in progress` : `${list.length} total`) : '';
  document.title = active ? `(${active}) Downloading… · Downloader` : 'Downloader';

  clearTimeout(pollTimer);
  pollTimer = setTimeout(refreshJobs, active ? 700 : 4000);
}

async function init() {
  try { Object.assign(config, await api('/api/config')); } catch { /* use defaults */ }
  if (config.public) {
    $('openFolder').hidden = true;
    $('ttlNote').textContent = ` Files are deleted from the server after ${config.file_ttl_minutes} minutes.`;
  }
  refreshJobs();
}

init();
$('url').focus();
