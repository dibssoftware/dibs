'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const POLL = 4000;
  // How old a view's own data may get before the next poll asks again: the live
  // lists every other board poll, the reports (read from the whole event log) less often.
  const FRESH_MS = 8000;
  const REPORT_MS = 30000;
  const FRESH = 15 * 6e4;                        // a post this recent means the agent is at it
  const FEED_STEP = 80;
  // The Mac app's sidebar, in its order (scratchpad ia.md): the same names on both.
  const VIEWS = ['now', 'questions', 'messages', 'progress', 'queues', 'schedule', 'machines', 'later', 'stats', 'history', 'settings'];
  const TITLES = { now: 'Now', questions: 'Questions', messages: 'Messages', progress: 'Progress', queues: 'Queues', schedule: 'Schedule', machines: 'Machines', later: 'Later', stats: 'Stats', history: 'History', settings: 'Settings' };
  // Views drawn from the board on every poll, as Now is.
  const LIVE = ['now', 'progress', 'queues', 'schedule'];
  // A phone, or a screen with nothing to hover with, is tapped, not clicked. Read each time: a window can narrow.
  const press = () => (matchMedia('(hover: none), (max-width: 760px)').matches ? 'Tap' : 'Click');
  // How calls reach dibs: transport.js when it's loaded (a plain fetch at 127.0.0.1,
  // the encrypted relay anywhere else), or the same plain fetch here without it.
  const T = window.dibsTransport || localTransport();
  function localTransport() {
    // The session token lives in localStorage, which belongs to this port alone (a cookie
    // would go to every server on 127.0.0.1). Private windows may refuse storage: then it
    // lasts as long as the tab.
    const KEY = 'dibs-session';
    let memo = null;
    const token = {
      get: () => { try { return localStorage.getItem(KEY) || memo; } catch { return memo; } },
      set: v => { memo = v; try { v ? localStorage.setItem(KEY, v) : localStorage.removeItem(KEY); } catch {} },
    };
    return {
      remote: false, token, onState() {},
      async fetchApi(method, path, body) {
        const r = await fetch(path, { method, headers: { Accept: 'application/json', Authorization: `Bearer ${token.get() || ''}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
          ...(body ? { body: JSON.stringify(body) } : {}) });
        return { status: r.status, json: await r.json().catch(() => null) };
      },
    };
  }
  const token = T.token;
  const signedIn = () => T.remote || !!token.get();
  // A 401: this browser's sign-in (or, through the relay, its pairing) is gone.
  function unauthorized() { if (!T.remote) token.set(null); signin(true); }
  let data = null, shown = FEED_STEP, timer = 0;
  let [view, chosen] = parseHash();
  let statsSpan = '7d', histSpan = '7d', heatKind = 'run', thread = null, busy = new Set();

  // ---- Reads: one cache for everything the page shows ------------------------
  // Each answer is kept by its path with when it came. A view draws at once from
  // what's kept and asks for fresh data behind it, so switching views never waits
  // on the network. The reports (stats, history: counts and times, no commands
  // or messages) also go to localStorage, so a new tab draws them at once too.
  const cache = new Map(), inflight = new Map();
  const STORED = /^\/api\/(stats|history)\b/;
  const statsPath = () => `/api/stats?since=${statsSpan}${chosen ? `&agent=${encodeURIComponent(chosen)}` : ''}`;
  const histPath = () => `/api/history?since=${histSpan}`;
  const TODAY = '/api/history?since=1d';
  function kept(path) {
    const hit = cache.get(path);
    if (hit) return hit.v;
    if (!STORED.test(path)) return null;
    try {
      const x = JSON.parse(localStorage.getItem(`dibs:${path}`));
      // Kept from an earlier visit: it draws now and counts as stale, so it's asked for again.
      if (x?.v) { cache.set(path, { v: x.v, at: 0 }); return x.v; }
    } catch {}
    return null;
  }
  function pull(path, maxAge = FRESH_MS) {
    const hit = cache.get(path);
    if (hit && Date.now() - hit.at < maxAge) return Promise.resolve(hit.v);
    if (inflight.has(path)) return inflight.get(path);
    const p = get(path).then(v => {
      cache.set(path, { v, at: Date.now() });
      if (STORED.test(path)) {
        // A stats view's top commands stay out of storage: a command line can say more than it should.
        const keep = Array.isArray(v?.agents) ? { ...v, agents: v.agents.map(({ commands, ...a }) => a) } : v;
        try { localStorage.setItem(`dibs:${path}`, JSON.stringify({ v: keep })); } catch {}
      }
      return v;
    }).finally(() => inflight.delete(path));
    inflight.set(path, p);
    return p;
  }
  // What each view reads besides the board, and how fresh it has to be.
  function needs(v) {
    if (v === 'now' || v === 'schedule') return [[TODAY, REPORT_MS]];
    if (v === 'questions') return [['/api/questions', FRESH_MS]];
    if (v === 'messages') return [['/api/threads', FRESH_MS]];
    if (v === 'later') return [['/api/later', FRESH_MS]];
    if (v === 'machines') return [['/api/machines', FRESH_MS], ...(T.remote ? [] : [['/api/machines/pairs', FRESH_MS]])];
    if (v === 'stats') return [[statsPath(), REPORT_MS]];
    if (v === 'history') return [[histPath(), REPORT_MS]];
    if (v === 'settings') return [['/api/settings', FRESH_MS], ...(T.remote ? [] : [['/api/paired', FRESH_MS], ['/api/accounts', FRESH_MS]])];
    return [];
  }
  // The open view's data, asked for when it's stale; drawn again once it lands.
  async function refresh(v = view, force = false) {
    const asks = needs(v).map(([path, age]) => pull(path, force ? 0 : age));
    if (!asks.length) return;
    const r = await Promise.allSettled(asks);
    const bad = r.find(x => x.status === 'rejected')?.reason;
    if (bad && bad.message !== 'signed out' && v === view) toast(`Couldn't load ${TITLES[v] || v}: ${bad.message}`, true);
    if (v === view) render();
  }
  // Another view's data, fetched quietly ahead of a click that's likely to come.
  const prefetch = v => { if (VIEWS.includes(v) && signedIn()) needs(v).forEach(([path, age]) => pull(path, age).catch(() => {})); };
  const side = {
    get questions() { return kept('/api/questions'); },
    get threads() { return kept('/api/threads'); },
    get later() { return kept('/api/later'); },
    get machines() { return kept('/api/machines'); },
    get pairs() { return kept('/api/machines/pairs'); },
    get stats() { return kept(statsPath()); },
    get history() { return kept(histPath()); },
    get settings() { return kept('/api/settings'); },
    get paired() { return kept('/api/paired'); },
    get accounts() { return kept('/api/accounts'); },
    get today() { return kept(TODAY); },
  };

  function parseHash() {
    const [v, ...rest] = decodeURIComponent(location.hash.slice(1)).split('/');
    return VIEWS.includes(v) ? [v, rest.join('/')] : ['now', v && !VIEWS.includes(v) ? [v, ...rest].join('/') : ''];
  }

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function button(cls, text, fn) {
    const b = el('button', cls, text);
    b.type = 'button';
    b.addEventListener('click', fn);
    return b;
  }
  const clock = t => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const dayName = t => new Date(t).toLocaleDateString([], { weekday: 'short', day: 'numeric' });
  function ago(ms) {
    const m = Math.round(ms / 6e4);
    if (m < 1) return 'just now';
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    return h < 24 ? `${h}h ${m % 60 ? `${m % 60}m ` : ''}ago` : `${Math.floor(h / 24)}d ago`;
  }
  function inFor(ms) {
    const m = Math.round(ms / 6e4);
    return m < 60 ? `${Math.max(1, m)}m` : `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ''}`;
  }
  // A span as a person says it: 40s, 12m, 3h 20m, 31h.
  function span(ms) {
    if (ms == null) return '-';
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.round(s / 60);
    if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60);
    return h < 10 ? `${h}h${m % 60 ? ` ${m % 60}m` : ''}` : `${h}h`;
  }
  const pct = x => (x == null ? '-' : `${Math.round(x * 100)}%`);
  const gb = b => (b == null ? '?' : `${(b / 1024 ** 3).toFixed(b < 10 * 1024 ** 3 ? 1 : 0)} GB`);
  // The Mac app's names for each pace (Speed in app/Dibs/Models/Settings.swift).
  const NAMES = { quiet: 'Calm', normal: 'Normal', max: 'Fast', off: 'Off' };
  const plural = (n, w) => `${n.toLocaleString()} ${w}${n === 1 ? '' : 's'}`;

  // The dot colors are the Mac app's: red has a job running now, yellow is waiting
  // its turn, green is busy and fine (posting, nothing queued), a red ring is blocked.
  function stateOf(a, now) {
    if (a.tasks.some(k => k.state === 'blocked' && k.last === a.lastPost?.at)) return 'blocked';
    if (a.jobs.some(j => j.state === 'running' || j.state === 'paused')) return 'running';
    if (a.jobs.length) return 'waiting';
    if (a.lastPost && now - a.lastPost.at < FRESH) return 'busy';
    return 'idle';
  }

  async function get(path) {
    const r = await T.fetchApi('GET', path);
    if (r.status === 401) { unauthorized(); throw new Error('signed out'); }
    if (r.status !== 200) throw new Error(r.json?.error || `the server answered ${r.status}`);
    return r.json;
  }
  // Every change goes through here: the server runs the CLI as you, and says what it did.
  async function post(path, body, key) {
    if (key) { busy.add(key); renderView(); }
    try {
      const r = await T.fetchApi('POST', path, body || {});
      if (r.status === 401) { unauthorized(); return null; }
      const j = r.json || {};
      if (r.status !== 200) { toast(j.error || `That didn't work (${r.status}).`, true); return { error: j.error || '', status: r.status }; }
      if (j.said) toast(j.said.split('\n').filter(Boolean).slice(-1)[0]);
      return j;
    } catch (e) {
      // Through the relay a call can be lost after the Mac got it: say so, as for a CLI timeout.
      toast(`Couldn't reach dibs (${e.message}). ${T.remote ? 'It may or may not have happened; look before trying again.' : 'Nothing changed.'}`, true);
      return null;
    } finally {
      if (key) busy.delete(key);
      load();
      refresh(view, true);
    }
  }

  let toastTimer = 0;
  function toast(text, bad = false) {
    const t = $('toast');
    t.textContent = text;
    t.classList.toggle('bad', bad);
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, bad ? 12000 : 6000);
  }

  async function load() {
    clearTimeout(timer);
    try {
      if (!signedIn()) return signin(true);
      data = await get('/api/board');
      signin(false);
      render();
      refresh();
      // The likeliest next click: a question or a note waiting on the person.
      if (data.questions) prefetch('questions');
      if (data.notes) prefetch('messages');
    } catch (e) {
      if (e.message !== 'signed out') $('eyebrow').textContent = `Can't reach dibs web (${e.message}). Retrying.`;
    }
    if (!document.hidden) timer = setTimeout(load, POLL);
  }

  function signin(show, detail) {
    $('signin').hidden = !show;
    $('app').hidden = show;
    if (!show) return;
    if (!T.remote) return $('code').focus();
    // Away from this Mac there's no code to type: a browser pairs by opening the link dibs pair --remote prints.
    $('signin-form').querySelector('h1').textContent = 'Pair this browser';
    $('signin-form').querySelector('p').textContent = detail || 'Run dibs pair --remote in a terminal on your Mac and open the link it prints here, or scan its code with your phone. Each link works once, for ten minutes.';
    for (const x of $('signin-form').querySelectorAll('label, input, button')) x.hidden = true;
  }
  T.onState(({ state, detail }) => {
    if (state === 'unpaired' || state === 'error') signin(true, detail);
    else if (state === 'offline' || state === 'connecting' || state === 'pairing') $('eyebrow').textContent = state === 'pairing' ? 'Pairing with your Mac.' : detail || 'Connecting to your Mac.';
    else if (state === 'ready') load();
  });

  function go(v, who = chosen) {
    const changed = v !== view || who !== chosen;
    view = v;
    chosen = who;
    history.replaceState(null, '', `#${encodeURIComponent(view)}${chosen ? `/${encodeURIComponent(chosen)}` : ''}`);
    shown = FEED_STEP;
    if (changed) document.querySelector('.panel')?.scrollTo?.(0, 0);
    // Drawn now from what's kept; fresh data follows.
    render();
    refresh();
  }

  function render() {
    if (!data) return;
    const now = data.now;
    const agents = data.agents;
    if (chosen && view === 'now' && !agents.some(a => a.who === chosen) && !side.stats?.agents?.some(a => a.who === chosen)) chosen = '';

    // Rail: the views, then the agents.
    for (const b of document.querySelectorAll('.view')) b.setAttribute('aria-current', String(b.dataset.view === view));
    const jobs = agents.flatMap(a => a.jobs);
    const running = jobs.filter(j => j.state !== 'waiting').length;
    const asks = side.questions ? side.questions.open : data.questions;
    setCount('c-now', jobs.length);
    setCount('c-questions', asks, true);
    setCount('c-messages', side.threads ? side.threads.threads.reduce((n, t) => n + t.unread, 0) : data.notes || 0, true);
    setCount('c-queues', jobs.filter(j => j.state === 'waiting' && !isLock(j)).length);
    setCount('c-later', (side.later || data.later).filter(j => j.state === 'scheduled').length);
    $('agent-count').textContent = agents.length ? String(agents.length) : '';
    $('agent-list').replaceChildren(...agents.map(a => {
      const b = el('button', 'rail-row');
      b.dataset.agent = a.who;
      b.setAttribute('aria-current', String(a.who === chosen));
      b.append(el('span', `dot ${stateOf(a, now)}`), el('span', 'rail-name', a.who));
      const n = a.jobs.length;
      b.append(el('span', 'rail-meta', n ? `${n} job${n > 1 ? 's' : ''}` : a.lastPost ? ago(now - a.lastPost.at) : ''));
      b.title = a.lastPost ? `Last post ${ago(now - a.lastPost.at)}: ${a.lastPost.text}` : a.who;
      return b;
    }));
    document.querySelector('.rail-row[data-agent=""]').setAttribute('aria-current', String(!chosen));
    meters(data.machine);

    $('eyebrow').textContent = `${new Date(now).toLocaleDateString([], { weekday: 'long' })}, ${clock(now)}  ·  ${data.name || 'this Mac'}`;
    // The banners are about what runs now; other views have their own words and the rail's counts.
    $('asks').hidden = !asks || view !== 'now';
    $('asks').replaceChildren();
    if (asks && view === 'now') {
      // The Mac app's words: who asked, and the question itself when there's one.
      const first = side.questions?.questions.find(x => x.state === 'open');
      const who = first && (first.agent || first.who);
      const text = !first ? `${asks} question${asks > 1 ? 's' : ''} from agents ${asks > 1 ? 'are' : 'is'} waiting for you.`
        : asks === 1 ? `1 question from ${who} is waiting for you: ${first.text}` : `${asks} questions from agents are waiting for you, the first from ${who}.`;
      $('asks').append(el('span', 'asks-text', text), button('btn primary', 'Answer', () => go('questions')));
    }
    $('hold').hidden = !data.hold || view !== 'now';
    $('hold').textContent = data.hold ? `Nothing new starts right now: ${data.hold}` : '';
    document.title = running ? `dibs (${running} running)` : 'dibs';
    renderView();
  }

  // A count on the rail: a red pill when it waits on the person, a quiet one otherwise.
  function setCount(id, n, loud = false) {
    const e = $(id);
    e.textContent = n ? String(n) : '';
    e.className = n ? `rail-meta count-pill${loud ? ' hot' : ''}` : 'rail-meta';
  }

  // Views that only change when their own data does are drawn again only then,
  // not on every poll of the board.
  let drawn = null;
  function renderView() {
    if (!data) return;
    for (const v of VIEWS) $(`v-${v}`).hidden = v !== view;
    if ($('job').open) drawSheet();
    if (view !== 'now') $('title').classList.remove('hot');
    if (LIVE.includes(view)) {
      $('title').textContent = TITLES[view];
      if (view === 'now') return now();
      $('summary').replaceChildren();
      return keep($(`v-${view}`), () => (view === 'progress' ? progressView() : view === 'queues' ? queuesView() : scheduleView()));
    }
    const own = { questions: side.questions, messages: side.threads, stats: side.stats, later: side.later, history: side.history, settings: side.settings, machines: side.machines }[view];
    const sig = [view, chosen, thread, statsSpan, histSpan, heatKind, lastW, [...busy].join(), confirmLater, view === 'machines' ? JSON.stringify([side.pairs, machineCode, kickArmed]) : ''].join('|');
    if (drawn && drawn.own === own && drawn.sig === sig && own) return;
    drawn = { own, sig };
    $('title').textContent = view === 'stats' && chosen ? chosen : TITLES[view];
    $('summary').replaceChildren();
    keep($(`v-${view}`), () => {
      if (view === 'questions') return questions();
      if (view === 'messages') return messages();
      if (view === 'stats') return stats();
      if (view === 'later') return later();
      if (view === 'history') return pastView();
      if (view === 'settings') return settings();
      if (view === 'machines') return machinesView();
    });
  }

  // Redrawing a view keeps what you were typing, where your cursor was, and how far
  // up a conversation you had scrolled.
  function keep(box, draw) {
    const was = new Map();
    for (const i of box.querySelectorAll('[data-keep]')) was.set(i.dataset.keep, { value: i.value, focus: document.activeElement === i, a: i.selectionStart, b: i.selectionEnd });
    const log = box.querySelector('.msgs');
    const up = log && log.scrollTop + log.clientHeight < log.scrollHeight - 40 ? log.scrollTop : null;
    draw();
    for (const i of box.querySelectorAll('[data-keep]')) {
      const w = was.get(i.dataset.keep);
      if (!w) continue;
      i.value = w.value;
      if (w.focus) { i.focus(); try { i.setSelectionRange(w.a, w.b); } catch {} }
    }
    const log2 = box.querySelector('.msgs');
    if (log2 && up != null) requestAnimationFrame(() => { log2.scrollTop = up; });
  }

  // ---- Now ---------------------------------------------------------------

  function now() {
    const t = data.now;
    const pick = chosen ? data.agents.filter(a => a.who === chosen) : data.agents;
    const jobs = pick.flatMap(a => a.jobs);
    const running = jobs.filter(j => j.state !== 'waiting').length, waiting = jobs.length - running;
    const working = pick.filter(a => stateOf(a, t) !== 'idle').length;
    const alerts = (data.alerts || []).filter(a => !chosen || a.who == null || a.who === chosen);
    const open = alerts.filter(a => !a.resolvedAt);
    // An alert about a job says more than its Needs card would, so the card goes.
    const alerted = new Set(open.map(a => a.job).filter(x => x != null));
    const needs = needsOf(data.jobs, t).filter(n => !gotIt.has(n.id) && (!chosen || n.who === chosen) && !(n.job && alerted.has(n.job.id)));
    const asks = side.questions ? side.questions.open : data.questions;
    // The Mac app's headline: does anything need the person. An agent picked: its name.
    const n = needs.length + open.filter(a => a.level !== 'note').length + (chosen ? 0 : asks);
    $('title').textContent = chosen || (n ? `${n} thing${n === 1 ? '' : 's'} need${n === 1 ? 's' : ''} you` : 'Nothing needs you');
    // Red when something waits on the person, as the Mac app's headline.
    $('title').classList.toggle('hot', !chosen && n > 0);
    summary(jobs, running, waiting, working, data.agents.length);
    capRow();
    alertsSection(alerts, t);
    needsSection(needs, t);
    schedule(pick, t);
    fileLocks(pick, t);
    todayChart($('today'));
  }

  // A job is a file lock when everything it holds is a file lease.
  const isLock = j => j.res.length && j.res.every(r => r.startsWith('files:'));

  // The machine in the rail's foot: how much room is left, red when it's short.
  // Short means what dibs itself holds jobs for: under 15% memory free, under the
  // 5 GB disk floor, load past the core count.
  function meters(m) {
    $('mach-name').textContent = data.name || 'This Mac';
    const row = (label, value, frac, bad) => {
      const r = el('div', 'meter');
      const top = el('div', 'meter-top');
      top.append(el('span', null, label), el('span', `meter-val${bad ? ' bad' : ''}`, value));
      const track = el('div', 'meter-track');
      const fill = el('i', bad ? 'bad' : '');
      fill.style.width = `${Math.max(2, Math.min(100, frac * 100))}%`;
      track.append(fill);
      r.append(top, track);
      return r;
    };
    const used = m.memFree != null ? 1 - m.memFree / 100 : 0;
    const out = [row('Memory', m.memFree != null ? `${m.memFree}% free` : '?', used, m.memFree != null && m.memFree < 15)];
    if (m.diskFree != null) out.push(row('Disk', `${gb(m.diskFree)} free`, Math.min(1, 5 * 1024 ** 3 / Math.max(1, m.diskFree)), m.diskFree < 5 * 1024 ** 3));
    if (m.load != null) out.push(row('Load', `${m.load.toFixed(1)} on ${m.cores || '?'} cores`, m.cores ? m.load / m.cores : 0, m.cores && m.load > m.cores));
    $('meters').replaceChildren(...out);
  }

  // One plain sentence on the line: what runs, what waits, who goes next.
  function summary(jobs, running, waiting, working, total) {
    const box = $('summary');
    let first;
    if (running || waiting) first = `${running} job${running === 1 ? '' : 's'} running${waiting ? ` and ${waiting} waiting` : ''}${chosen ? '' : `, ${working} of ${total} agents busy`}.`;
    else first = chosen ? 'No jobs right now.' : `No jobs right now${working ? `; ${working} of ${total} agents posting` : ''}.`;
    const next = jobs.filter(j => j.state === 'waiting').sort((x, y) => (x.startsAt || Infinity) - (y.startsAt || Infinity) || x.place - y.place)[0];
    const soon = jobs.filter(j => j.endsAt).sort((x, y) => x.endsAt - y.endsAt)[0];
    box.replaceChildren(first);
    if (next) box.append(' Next: ', el('b', null, next.who), ` on ${next.res.join(', ')}${next.startsAt ? ` around ${clock(next.startsAt)}` : ''}.`);
    else if (soon) box.append(' First to finish: ', el('b', null, soon.who), ` around ${clock(soon.endsAt)}.`);
  }

  // An agent picked: its slowdown, which the person sets with dibs cap.
  function capRow() {
    const box = $('cap');
    box.hidden = !chosen;
    if (!chosen) return;
    const key = `cap-${chosen}`;
    box.replaceChildren(el('span', 'cap-label', `Hold ${chosen} back:`));
    const seg = el('div', 'seg');
    for (const [p, label] of [['off', 'Runs normally'], ['low', 'Behind others'], ['idle', 'Only when idle']]) {
      const b = button('seg-btn', label, () => post('/api/cap', { agent: chosen, prio: p }, key));
      b.disabled = busy.has(key);
      seg.append(b);
    }
    box.append(seg, el('span', 'cap-note', 'Caps every job it runs from now on. dibs cap, logged as you.'));
  }

  // The jobs: one row per job or task with an end, each with a bar on an axis
  // that spans only the time something is in, so a quiet afternoon isn't empty track.
  function schedule(pick, now) {
    const box = $('timeline');
    const items = [];
    for (const a of pick) {
      for (const j of a.jobs) {
        if (isLock(j)) continue;
        const what = j.purpose || j.cmd || j.res.join(', ');
        if (j.state === 'waiting') {
          const from = j.startsAt || now;
          items.push({ job: j, who: a.who, kind: 'wait', what, res: j.res, from, to: from + (j.est || 10 * 6e4),
            when: j.startsAt ? `starts ~${clock(j.startsAt)}` : `waiting, #${j.place} in line`, tip: j.blocked || j.headline || '' });
        } else {
          items.push({ job: j, who: a.who, kind: j.state === 'paused' ? 'paused' : 'run', what, res: j.res, from: j.started || now, to: j.endsAt || now, open: !j.endsAt,
            when: j.state === 'paused' ? 'paused' : j.endsAt ? `ends ~${clock(j.endsAt)}` : `running ${inFor(now - (j.started || now))}`, tip: j.paused || j.ends || '' });
        }
      }
      for (const k of a.tasks) {
        if (k.state !== 'doing' || !k.eta) continue;
        items.push({ who: a.who, kind: k.eta < now ? 'late' : 'task', what: k.task || `work in ${k.project || 'a folder'}`, res: ['task'], from: k.started, to: k.eta,
          when: k.eta < now ? `was due ${clock(k.eta)}` : `done by ${clock(k.eta)}`, tip: k.text });
      }
    }
    if (!items.length) {
      $('tl-note').textContent = '';
      box.replaceChildren(el('p', 'empty pad', chosen ? `${chosen} has no jobs and no task with an end time.` : 'Nothing running or waiting. Jobs show up here as agents run them, and tasks once they post with --eta.'));
      return;
    }
    // The axis: from the earliest start (at most an hour back) to the latest end
    // (at most six hours ahead), never narrower than half an hour around now.
    const lo0 = Math.max(now - 36e5, Math.min(now, ...items.map(x => x.from)));
    const hi0 = Math.min(now + 6 * 36e5, Math.max(now + 15 * 6e4, ...items.map(x => x.to)));
    const pad = Math.max(3 * 6e4, (hi0 - lo0) * 0.04);
    const lo = lo0 - pad, hi = hi0 + pad, width = hi - lo;
    const at = t => ((Math.min(hi, Math.max(lo, t)) - lo) / width) * 100;
    const step = [5, 10, 15, 30, 60, 120].map(m => m * 6e4).find(st => width / st <= 5) || 18e4 * 40;
    const ticks = [];
    for (let t = Math.ceil(lo / step) * step; t < hi; t += step) if (Math.abs(at(t) - at(now)) > 12) ticks.push(t);

    const head = el('div', 'srow s-head');
    const axis = el('div', 's-track');
    for (const t of ticks) { const k = el('span', 's-tick', clock(t)); k.style.left = `${at(t)}%`; axis.append(k); }
    const nowTag = el('span', 's-nowtag', 'now');
    nowTag.style.left = `${at(now)}%`;
    axis.append(nowTag);
    head.append(el('span', 's-who', ''), el('span', 's-what', ''), axis, el('span', 's-when', ''));

    items.sort((x, y) => x.who.localeCompare(y.who) || x.from - y.from);
    const rows = items.map((x, i) => {
      const r = el(x.job ? 'button' : 'div', `srow k-${x.kind}${x.job ? ' act' : ''}`);
      r.title = x.job ? `${x.tip ? `${x.tip}. ` : ''}Click for boost, pause or stop` : x.tip;
      if (x.job) { r.type = 'button'; r.addEventListener('click', () => jobSheet(x.job.id)); }
      const what = el('span', 's-what');
      what.append(el('span', `s-dot k-${x.kind}`), el('span', 's-text', x.what), el('span', 's-res', `#${x.job ? x.job.id : ''} ${x.res.join(', ')}`.replace(/^# /, '')));
      const track = el('span', 's-track');
      for (const t of ticks) { const g = el('i', 's-grid'); g.style.left = `${at(t)}%`; track.append(g); }
      const bar = el('i', `s-bar k-${x.kind}${x.open ? ' open' : ''}`);
      bar.style.left = `${at(x.from)}%`;
      bar.style.width = `${Math.max(0.8, at(x.open ? now : x.to) - at(x.from))}%`;
      const nowLine = el('i', 's-now');
      nowLine.style.left = `${at(now)}%`;
      track.append(bar, nowLine);
      r.append(el('span', 's-who', i && items[i - 1].who === x.who ? '' : x.who), what, track, el('span', 's-when', x.when));
      return r;
    });
    $('tl-note').textContent = `${clock(lo)} to ${clock(hi)}. ${press()} a job to change it.`;
    box.replaceChildren(head, ...rows);
  }

  // File leases from dibs hold 'files:...': who holds which files, and who waits for them.
  function fileLocks(pick, now) {
    const locks = pick.flatMap(a => a.jobs.filter(isLock).map(j => ({ ...j, who: a.who })));
    $('files-sec').hidden = !locks.length;
    if (!locks.length) return;
    const held = locks.filter(j => j.state !== 'waiting');
    $('files-note').textContent = `${plural(held.length, 'lease')} held${locks.length > held.length ? `, ${locks.length - held.length} waiting` : ''}`;
    $('files').replaceChildren(...locks.map(j => {
      const r = el('button', 'lrow');
      r.type = 'button';
      r.addEventListener('click', () => jobSheet(j.id));
      const files = j.res.map(x => x.slice(6));
      const name = el('span', 'l-main');
      name.append(el('b', null, j.who), ` ${j.state === 'waiting' ? 'waits for' : 'holds'} `, el('span', 'mono', files.length === 1 ? files[0] : `${files[0]} and ${files.length - 1} more`));
      r.title = files.join('\n');
      r.append(name, el('span', 'l-side', j.state === 'waiting' ? `#${j.place} in line` : `for ${inFor(now - (j.started || now))}`));
      return r;
    }));
  }

  // Every post, newest first, as one stream.
  let shown2 = FEED_STEP;
  function feed(box, posts, now) {
    const items = posts.slice(0, shown2).map((p, i, arr) => {
      const li = el('li', `post${i && arr[i - 1].who === p.who && arr[i - 1].at - p.at < 30 * 6e4 ? ' same' : ''}`);
      const time = el('time', 'post-time', clock(p.at));
      time.dateTime = new Date(p.at).toISOString();
      time.title = ago(now - p.at);
      const who = el('div', 'post-who', p.who);
      if (p.task) who.append(el('span', 'tag', p.task));
      if (p.state !== 'doing') who.append(el('span', `tag ${p.state}`, p.state));
      const body = el('div');
      body.append(who, el('p', 'post-text', p.text));
      li.append(time, body);
      return li;
    });
    if (posts.length > shown2) {
      const li = el('li');
      li.append(button('more', `Show ${Math.min(FEED_STEP, posts.length - shown2)} more`, () => { shown2 += FEED_STEP; feed(box, posts, now); }));
      items.push(li);
    }
    box.replaceChildren(...items);
  }

  // ---- Needs you: the Mac app's Needs (app/Dibs/Models/Needs.swift), from the board ----

  // The app's thresholds. A deploy held two minutes is worth a look; an urgent or high
  // job ten; anything else half an hour. A running job idle 20 minutes while others
  // wait looks stuck (STUCK_AFTER in src/plain.mjs).
  const SHIP_AFTER = 2 * 6e4, IMPORTANT_AFTER = 10 * 6e4, ANY_AFTER = 30 * 6e4, IDLE_AFTER = 20 * 6e4;
  // Cleared here with Got it or Leave it: the job keeps its turn, the card goes.
  const gotIt = new Set();
  const RES_NAME = { sim: 'Simulator', 'sim-own': 'Private simulators', 'xcode-build': 'Xcode builds', playwright: 'Browser tests', test: 'Test runs', deploy: 'Deploys', heavy: 'Heavy jobs', files: 'File locks' };
  function resName(r) {
    if (RES_NAME[r]) return RES_NAME[r];
    if (r.startsWith('files:')) return `Files: ${r.slice(6)}`;
    if (r === 'quota:asc') return 'App Store Connect budget';
    return r.startsWith('quota:') ? `${r.slice(6)} budget` : r;
  }
  const inSentence = r => (r === 'sim' ? 'the simulator' : ['sim-own', 'playwright', 'test', 'deploy', 'heavy'].includes(r) ? resName(r).toLowerCase() : resName(r));
  const WHY = {
    sim: 'Only one agent can use the iPhone simulator at a time',
    'sim-own': 'This Mac only has memory for a few private simulators at once',
    'xcode-build': 'This Mac only runs a couple of app builds at once, because each one uses a lot of memory',
    playwright: 'This Mac only runs a couple of browser tests at once, because each one opens its own browser',
    test: "This Mac only runs a few test runs at once, so it doesn't slow to a crawl",
    deploy: "Only one deploy per project runs at a time, so two releases of it don't clash",
    heavy: 'Only one heavy job runs at a time, so the Mac stays usable',
  };
  const whyRes = r => WHY[r] || (r.startsWith('quota:') ? `Agents share a limited number of calls to ${resName(r).replace(' budget', '')}` : `Only so many agents can use ${inSentence(r)} at once`);
  // "about 4 min", as the CLI and the app say it.
  function about(ms) {
    const m = Math.round(ms / 6e4);
    if (ms < 6e4) return 'under a minute';
    if (m < 60) return `about ${m} min`;
    return m % 60 ? `about ${Math.floor(m / 60)} hr ${m % 60} min` : `about ${m / 60} hr`;
  }
  const mins = ms => about(ms).replace('about ', '');
  const upper = s => (s ? s[0].toUpperCase() + s.slice(1) : s);
  function fileName(r) {
    if (!r.startsWith('files:')) return null;
    const parts = r.slice(6).split('/').filter(Boolean), last = parts.at(-1);
    if (!last) return r.slice(6);
    if (!last.includes('*')) return last;
    const folder = parts.slice(0, -1).reverse().find(x => !x.includes('*'));
    return folder ? `${folder}/${last}` : 'Every file';
  }
  const isShip = j => j.res.some(r => r === 'deploy' || r.startsWith('deploy-') || r.startsWith('deploy:'))
    || (j.res.includes('quota:asc') && `${j.purpose || ''} ${j.cmd || ''}`.toLowerCase().includes('testflight'));
  const isDisk = j => j.family === 'disk' || (j.waitingFor || '').includes('disk space');
  // Waiting on the Mac or a budget, not behind someone: going first can't help.
  const waitsOnMac = j => !!j.family && j.family !== 'line' && j.family !== 'idle';

  // A queue per resource: who has it, and who waits, by place. Every file lease is one queue.
  function queuesOf(jobs) {
    const qs = new Map();
    for (const j of jobs) for (const r of j.res) {
      const k = r.startsWith('files:') ? 'files' : r;
      if (!qs.has(k)) qs.set(k, { res: k, serving: [], waiting: [] });
      const q = qs.get(k);
      const list = j.state === 'waiting' ? q.waiting : q.serving;
      if (!list.includes(j)) list.push(j);
    }
    for (const q of qs.values()) q.waiting.sort((a, b) => a.place - b.place);
    return [...qs.values()].sort((a, b) => b.waiting.length - a.waiting.length || resName(a.res).localeCompare(resName(b.res)));
  }

  function needsOf(jobs, now) {
    const out = [], seen = new Set(), full = [];
    const qs = queuesOf(jobs);
    // A job holding the line that looks stuck comes first: the person can do most about it.
    for (const q of qs) {
      if (!q.waiting.length) continue;
      for (const j of q.serving) {
        if (j.state !== 'running' || j.kind === 'hold' || (j.idleMs || 0) < IDLE_AFTER || seen.has(j.id)) continue;
        seen.add(j.id);
        const n = q.waiting.length;
        out.push({ kind: 'idle', id: `idle-${j.id}`, job: j, line: q.res, who: j.who, since: now - j.idleMs, title: `${j.who}'s job looks stuck`,
          detail: `${j.purpose ? `Its job (${j.purpose})` : 'Its job'} hasn't done anything for ${mins(j.idleMs)}, and ${n === 1 ? `${q.waiting[0].who} is` : `${n} others are`} waiting for ${inSentence(q.res)}. `
            + `If ${j.who} has stopped working on it, stop it so the next one can start. If it's still working, leave it.` });
      }
    }
    for (const q of qs) {
      const long = [];
      for (const j of q.waiting) {
        if (seen.has(j.id)) continue;
        seen.add(j.id);
        const waited = now - (j.queued || now);
        const why = j.waitingFor ? `Waiting for ${j.waitingFor.replace(/\.$/, '')}.` : '';
        if (isDisk(j)) full.push(j);
        else if (isShip(j) && waited >= SHIP_AFTER) out.push({ kind: 'ship', id: `ship-${j.id}`, job: j, line: q.res, who: j.who, since: j.queued, title: `${j.who} can't ship yet`, detail: [j.purpose && `${upper(j.purpose)}.`, why].filter(Boolean).join(' ') });
        else if ((j.prio === 'urgent' || j.prio === 'high') && waited >= IMPORTANT_AFTER) out.push(stuckNeed(j, q, waited, now));
        else if (waited >= ANY_AFTER) long.push(j);
      }
      // A long line is one problem, not one per job.
      if (long.length) {
        const first = long.reduce((a, b) => ((a.queued || now) <= (b.queued || now) ? a : b));
        const need = long.length === 1 ? stuckNeed(first, q, now - first.queued, now)
          : { kind: 'stuck', line: q.res, who: null, since: first.queued, title: `${long.length} agents have been waiting over half an hour`,
            detail: `${whyRes(q.res)}, so they're taking turns. ${first.who} has waited longest, ${mins(now - first.queued)}. They all start by themselves. If one of them is more urgent, open the queue and let it go first.` };
        need.id = `long-${q.res}`;
        out.push(need);
      }
    }
    if (full.length) {
      const who = [...new Set(full.map(j => j.who))];
      const names = who.length <= 2 ? who.join(' and ') : `${who.slice(0, -1).join(', ')} and ${who.at(-1)}`;
      const w = full[0].waitingFor || '';
      const space = w.includes('(') ? w.slice(w.indexOf('(') + 1).replace(/\)$/, '') : '';
      out.push({ kind: 'disk', id: 'disk', job: full[0], line: full[0].res[0], who: full[0].who, since: Math.min(...full.map(j => j.queued || now)),
        title: `The disk is too full for ${names} to start`, detail: `${space ? `${upper(space)}. ` : ''}Free up some space and ${who.length === 1 ? 'it starts on its own' : 'they start on their own'}.` });
    }
    return out;
  }

  // One agent waiting too long, said for someone who has never heard of a queue.
  function stuckNeed(j, q, waited, now) {
    const me = j.who, holder = q.serving[0]?.who, left = q.serving[0]?.endsAt ? Math.max(0, q.serving[0].endsAt - now) : null;
    const starts = left == null ? 'It starts by itself as soon as the other one is done.' : left < 6e4 ? 'It starts by itself any moment now.' : `It starts by itself in about ${mins(left)}, when the other one is done.`;
    const base = { kind: 'stuck', id: `stuck-${j.id}`, job: j, line: q.res, who: me, since: j.queued };
    const file = q.res === 'files' ? fileName(j.res.find(r => r.startsWith('files:')) || '') : null;
    if (waitsOnMac(j) && j.waitingFor) return { ...base, title: `${me} has been waiting ${mins(waited)} to start`, detail: `It's waiting for ${j.waitingFor.replace(/\.$/, '')}. It starts by itself. Letting it go first won't help, since it isn't waiting behind another agent.` };
    if (file) return { ...base, title: 'Two agents need the same file', detail: `${me} wants to change ${file}, but ${holder || 'another agent'} is changing it right now. ${me} waits so neither one overwrites the other's work. ${starts} You don't need to do anything.` };
    if (holder) return { ...base, title: `${me} has been waiting ${mins(waited)} for its turn`, detail: `${whyRes(q.res)}, and ${holder} is using it now. ${starts} If ${me}'s work is more urgent, you can let it go first.` };
    return { ...base, title: `${me} has been waiting ${mins(waited)} to start`, detail: "This Mac is too busy for more work right now, so new work waits until it calms down. It starts by itself. You don't need to do anything unless it's urgent." };
  }

  let stopArmed = null;
  // ---- Alerts: what's wrong and its one fix (src/alerts.mjs), the same list as dibs alerts ----

  // Red for what holds a person up or breaks dibs, yellow for what's slow, grey for a
  // job that failed; green once it's resolved.
  const ALERT_DOT = { urgent: 'running', warn: 'waiting', note: 'idle' };
  function alertsSection(alerts, now) {
    $('alerts-sec').hidden = !alerts.length;
    if (!alerts.length) return;
    const open = alerts.filter(a => !a.resolvedAt);
    $('alerts-note').textContent = open.length ? `${open.length} open` : 'All resolved';
    $('alerts').replaceChildren(...alerts.map(a => {
      const card = el('article', `need card${a.resolvedAt ? ' done' : ''}`);
      const head = el('div', 'need-head');
      const title = el('h3', 'need-title');
      title.append(el('span', `dot ${a.resolvedAt ? 'busy' : ALERT_DOT[a.level] || 'idle'}`), ' ', el('b', null, a.title));
      head.append(title, el('span', 'need-ago', a.resolvedAt ? `resolved ${clockOf(a.resolvedAt)}` : now - a.since < 6e4 ? 'just now' : `since ${clockOf(a.since)}`));
      card.append(head);
      if (a.resolvedAt) return card;
      const more = [a.why && `Why: ${upper(a.why.replace(/\.$/, ''))}.`, a.detail].filter(Boolean).join(' ');
      if (more) card.append(el('p', 'need-text', more));
      const fix = el('p', 'need-text');
      fix.append(el('b', null, 'Fix: '), a.fix);
      card.append(fix);
      const acts = el('div', 'need-acts');
      const b = button('btn', 'Dismiss', () => post('/api/alerts/dismiss', { id: a.id }, `alert-${a.id}`));
      b.title = 'Clears it for a day. If the cause is still there after that, it comes back.';
      b.disabled = busy.has(`alert-${a.id}`);
      acts.append(b);
      if (a.job != null) acts.append(button('link', 'See the queue', () => go('queues', '')));
      card.append(acts);
      return card;
    }));
  }
  const clockOf = ms => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

  function needsSection(needs, now) {
    $('needs-sec').hidden = !needs.length;
    if (!needs.length) return;
    $('needs-note').textContent = '';
    $('needs').replaceChildren(...needs.map(n => {
      const card = el('article', 'need card');
      const head = el('div', 'need-head');
      const title = el('h3', 'need-title');
      // The agent's name in ink, the rest quieter, as the app says it.
      if (n.who && n.title.startsWith(n.who)) title.append(el('b', null, n.who), el('span', null, n.title.slice(n.who.length)));
      else title.append(el('b', null, n.title));
      head.append(title, el('span', 'need-ago', now - n.since < 6e4 ? 'just now' : `${mins(now - n.since)} ago`));
      card.append(head, el('p', 'need-text', n.detail));
      const acts = el('div', 'need-acts');
      const see = () => { qTab = n.line; go('queues', ''); };
      const key = n.job ? `job-${n.job.id}` : n.id;
      const add = b => { b.disabled = busy.has(key); acts.append(b); return b; };
      if (n.kind === 'idle') {
        const armed = stopArmed === n.id;
        add(button(`btn ${armed ? 'primary' : 'danger'}`, armed ? 'Yes, stop it' : 'Stop it…', () => {
          if (!armed) { stopArmed = n.id; return renderView(); }
          stopArmed = null;
          post(`/api/jobs/${n.job.id}/stop`, { expect: 'running' }, key);
        }));
        add(button('btn', 'Leave it', () => { gotIt.add(n.id); renderView(); })).title = `Clears this. ${n.who} keeps its turn.`;
        acts.append(button('link', 'See the queue', see));
      } else if (n.job && n.kind !== 'disk') {
        add(button('btn primary', 'Got it', () => { gotIt.add(n.id); renderView(); })).title = 'Clears this. It starts by itself when its turn comes.';
        if (n.job.prio !== 'urgent' && n.line !== 'files' && !waitsOnMac(n.job)) add(button('btn', 'Let it go first', () => post(`/api/jobs/${n.job.id}/boost`, { prio: 'urgent' }, key)));
        acts.append(button('link', 'See the queue', see));
      } else acts.append(button('btn primary', 'See the queue', see));
      card.append(acts);
      return card;
    }));
  }

  // ---- Today: the app's TodayChart --------------------------------------------

  // The past 12 hours: at the busiest point of each hour, how many agents ran and how
  // many waited, side by side. The hour in progress is lighter: it isn't done.
  function todayChart(box) {
    const h = side.today;
    if (!h) return box.childElementCount || box.replaceChildren(loading('Reading the past day'));
    const now = data.now, cut = now - 12 * 36e5;
    const hours = h.hourly.filter(x => x.hour >= cut - 36e5 && x.hour <= now);
    if (!hours.length || hours.every(x => !x.held && !x.waiting)) return box.replaceChildren(el('p', 'empty pad', 'Nothing recorded yet.'));
    const W = widthOf(box) - 36, H = 150, L = 4, R = 28, B = 22, T = 8;
    const max = Math.max(1, ...hours.map(x => Math.max(x.held || 0, x.waiting || 0)));
    const { step, top } = nice(max, 3);
    const s = svg('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}`, class: 'chart', role: 'img', 'aria-label': 'Agents running and waiting each hour, past 12 hours' });
    const y = v => T + (H - T - B) * (1 - v / top);
    for (let v = 0; v <= top; v += step) {
      s.append(svg('line', { x1: L, x2: W - R, y1: y(v), y2: y(v), class: v ? 'grid' : 'base' }));
      s.append(svg('text', { x: W - R + 6, y: y(v) + 4, class: 'ax' }, String(v)));
    }
    const slot = (W - L - R) / hours.length, bw = Math.max(3, Math.min(18, slot * 0.32));
    const live = new Date(now); live.setMinutes(0, 0, 0);
    hours.forEach((x, i) => {
      const cx = L + i * slot + slot / 2, cur = x.hour >= +live;
      const g = svg('g', cur ? { opacity: 0.45 } : {});
      g.append(svg('title', {}, `${clock(x.hour)}: ${x.held || 0} running, ${x.waiting || 0} waiting${cur ? ' (so far)' : ''}`));
      g.append(svg('rect', { x: cx - bw - 1, width: bw, y: y(x.held || 0), height: Math.max(0, y(0) - y(x.held || 0)), rx: 3, class: 'f-ran' }));
      g.append(svg('rect', { x: cx + 1, width: bw, y: y(x.waiting || 0), height: Math.max(0, y(0) - y(x.waiting || 0)), rx: 3, class: 'f-wait' }));
      s.append(g);
      if (i % 3 === 0) s.append(svg('text', { x: cx, y: H - 5, class: 'ax mid' }, new Date(x.hour).toLocaleTimeString([], { hour: 'numeric' })));
    });
    const legend = el('div', 'legend chart-legend');
    legend.append(el('i', 'key f-ran'), 'Running', el('i', 'key f-wait'), 'Waiting');
    box.replaceChildren(legend, s);
  }

  // ---- Progress: one block per agent, as the app's Progress -------------------

  // The app's AgentTile: a loud hue by a steady hash, and a monogram.
  const HUES = ['#2F5BFF', '#00C266', '#FF3EA5', '#8A4DFF', '#FF8A00', '#00B8F5', '#FFD000', '#C4F235'];
  function djb2(s) { let h = 5381; for (const ch of s) h = ((h << 5) + h + ch.codePointAt(0)) >>> 0; return h; }
  function monogram(name) {
    const parts = name.split(/[-_/ .]/).filter(Boolean), last = parts.at(-1);
    if (parts.length >= 2 && (last.length <= 2 || (last.length <= 3 && /\d/.test(last)))) return last.toUpperCase();
    if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
    return name.slice(0, 2).toUpperCase();
  }
  function tile(name, size = 28) {
    const hex = HUES[djb2(name) % HUES.length];
    const n = parseInt(hex.slice(1), 16), lum = 0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255);
    const t = el('span', 'tile', monogram(name));
    t.style.cssText = `--size:${size}px;background:${hex};color:${lum > 150 ? '#111113' : '#fff'}`;
    t.setAttribute('aria-hidden', 'true');
    return t;
  }
  // "12m", "1h 5m": the app's short way.
  const short = ms => { const m = Math.ceil(Math.max(0, ms) / 6e4); return m < 60 ? `${m}m` : m % 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m / 60}h`; };
  const taskLate = (k, now) => k.state === 'doing' && k.eta && k.eta < now;
  // The state dot (scratchpad ia.md): busy green, late a yellow ring, blocked a red ring, done grey.
  // Expired (no word for hours, src/progress.mjs EXPIRE_AFTER) is grey too: nothing to wait on.
  const taskDot = (k, now) => (k.state === 'done' || k.state === 'expired' ? 'done' : k.state === 'blocked' ? 'blocked' : taskLate(k, now) ? 'late' : 'busy');
  function taskWhen(k, now) {
    if (k.state === 'done') return `done at ${clock(k.last)}`;
    if (k.state === 'expired') return `no word since ${clock(k.last)}, so taken for finished`;
    if (k.state === 'blocked') return `blocked since ${clock(k.last)}`;
    if (!k.eta) return null;
    return k.eta >= now ? `done by ${clock(k.eta)}, in ${short(k.eta - now)}` : `was due ${clock(k.eta)}, ${short(now - k.eta)} late`;
  }
  const opened = new Set();
  function progressView() {
    const box = $('v-progress');
    const now = data.now;
    $('summary').textContent = "What agents say they're working on, in their own words.";
    const agents = data.agents.filter(a => a.tasks.length && (!chosen || a.who === chosen));
    const out = [];
    if (!agents.length) out.push(quiet(chosen ? `${chosen} hasn't posted progress in the last day.` : 'No progress posted yet.', 'Agents post here as they work: dibs progress "what just happened" --task name --eta 20m'));
    for (const a of agents) {
      const block = el('section', 'agent-block');
      const head = el('div', 'agent-head');
      const ks = [...a.tasks].sort((x, y) => y.last - x.last);
      const open = ks.filter(k => k.state !== 'done' && k.state !== 'expired').length, late = ks.filter(k => taskLate(k, now)).length;
      const names = el('div');
      names.append(el('h2', null, a.who), el('p', 'agent-sum', [open ? `${open} open` : 'nothing open', late && `${late} late`, a.lastPost && `last posted ${ago(now - a.lastPost.at)}`].filter(Boolean).join(' · ')));
      head.append(tile(a.who), names);
      const card = el('div', 'card rows');
      for (const k of ks) {
        const row = el('div', 'trow');
        const top = el('div', 'trow-top');
        top.append(el('span', `dot ${taskDot(k, now)}`), el('b', 'trow-name', k.task || `Work in ${k.project || 'a folder'}`));
        const place = [k.task && k.project, k.branch].filter(Boolean).join(' · ');
        if (place) top.append(el('span', 'trow-place', place));
        const when = taskWhen(k, now);
        if (when) top.append(el('span', `trow-when${taskLate(k, now) ? ' late' : ''}`, when));
        row.append(top, el('p', `trow-text${k.state === 'done' || k.state === 'expired' ? ' done' : ''}`, k.text));
        const earlier = data.posts.filter(p => p.who === a.who && (p.task || null) === (k.task || null) && (k.task || p.project === k.project)).sort((x, y) => y.at - x.at).slice(1);
        if (earlier.length) {
          const key = `${a.who}\0${k.task || k.project}`;
          const d = el('details', 'earlier');
          d.open = opened.has(key);
          d.addEventListener('toggle', () => { if (d.open) opened.add(key); else opened.delete(key); });
          d.append(el('summary', null, earlier.length === 1 ? '1 earlier post' : `${earlier.length} earlier posts`));
          for (const p of earlier) { const li = el('div', 'earlier-post'); li.append(el('time', null, clock(p.at)), el('span', null, p.text)); d.append(li); }
          row.append(d);
        }
        card.append(row);
      }
      block.append(head, card);
      out.push(block);
    }
    const posts = data.posts.filter(p => !chosen || p.who === chosen).reverse();
    if (posts.length) {
      const feedBox = el('ol', 'feed');
      out.push(section('Latest posts', `${plural(posts.length, 'post')} in the last day`, feedBox));
      box.replaceChildren(...out);
      feed(feedBox, posts, now);
      return;
    }
    box.replaceChildren(...out);
  }
  // An empty screen: what's missing, and how it fills.
  // While a view's data is on its way: a small spinner, shown only once the wait
  // passes 150 ms (app.css), so a quick answer never flashes it.
  function loading(what) {
    const p = el('p', 'loading');
    p.setAttribute('role', 'status');
    p.append(el('span', 'spin'), el('span', null, what));
    return p;
  }

  function quiet(title, detail) {
    const q = el('div', 'quiet');
    q.append(el('p', 'quiet-title', title), el('p', 'empty', detail));
    return q;
  }

  // ---- Queues: a tab per busy resource, each a standings table ------------------

  // The app's resource colors (enum Tint in app/Dibs/Views/Theme.swift).
  const TINT = { sim: '#2F5BFF', 'sim-own': '#8A4DFF', 'xcode-build': '#00C266', playwright: '#FF3EA5', test: '#00B8F5', deploy: '#FF8A00', heavy: '#64748B' };
  const SPARE = ['#00D1B2', '#B44DFF', '#3DDC84', '#4D7CFF', '#E879F9'];
  const tint = r => TINT[r] || (r === 'files' || r.startsWith('files:') ? '#C4F235' : SPARE[djb2(r) % SPARE.length]);
  function resDot(r) { const d = el('span', 'res-dot'); d.style.background = tint(r); return d; }
  let qTab = null;
  const ordinal = n => (n === 1 ? 'Next' : `${n}${[11, 12, 13].includes(n % 100) ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th'}`);
  function queuesView() {
    const box = $('v-queues');
    const now = data.now;
    const qs = queuesOf(data.jobs);
    const waiting = data.jobs.filter(j => j.state === 'waiting').length;
    $('summary').textContent = qs.length ? `${plural(qs.length, 'queue')} in use, ${waiting} waiting. ${press()} a row for its job.` : 'Every queue is free.';
    const out = [];
    if (qs.length) {
      if (!qs.some(q => q.res === qTab)) qTab = qs[0].res;
      const tabs = el('div', 'seg tabs');
      for (const q of qs) {
        const b = button('seg-btn', '', () => { qTab = q.res; renderView(); });
        b.append(resDot(q.res), resName(q.res));
        if (q.waiting.length) b.append(el('span', 'count-pill', String(q.waiting.length)));
        b.setAttribute('aria-pressed', String(q.res === qTab));
        tabs.append(b);
      }
      out.push(tabs);
      const q = qs.find(x => x.res === qTab);
      const clears = q.waiting.length ? null : q.serving.map(j => j.endsAt).filter(Boolean).sort((a, b) => b - a)[0];
      const why = q.waiting.some(j => j.moves?.length);
      const t = el('div', 'tbl-wrap');
      const tb = el('table', 'tbl standings');
      const hr = el('tr');
      for (const [c, cls] of [['Place', ''], ['Agent', ''], ...(why ? [['Why this place', '']] : []), ['Starts', 'num']]) { const th = el('th', cls, c); th.scope = 'col'; hr.append(th); }
      tb.append(el('thead'));
      tb.firstChild.append(hr);
      const body = el('tbody');
      const row = (j, place, starts) => {
        const tr = el('tr', 'pick');
        tr.tabIndex = 0;
        const open = () => jobSheet(j.id);
        tr.addEventListener('click', open);
        tr.addEventListener('keydown', e => { if (e.key === 'Enter') open(); });
        const who = el('td');
        const line = el('div', 'st-who');
        line.append(el('span', `dot ${j.state === 'waiting' ? 'waiting' : j.state === 'paused' ? 'paused' : 'running'}`), el('b', null, j.who));
        who.append(line, el('div', 'st-what', [j.purpose || j.cmd, q.res === 'files' && j.res.filter(r => r.startsWith('files:')).map(fileName).join(', ')].filter(Boolean).join(' · ')));
        const cells = [el('th', 'st-place', place), who];
        if (why) cells.push(el('td', 'st-why', j.moves?.map(m => `${m.dir === 'up' ? 'Up' : 'Down'} ${m.amount}: ${m.reason || m.label}`).join('; ') || ''));
        cells.push(el('td', 'num', starts));
        tr.append(...cells);
        return tr;
      };
      for (const j of q.serving) body.append(row(j, j.state === 'paused' ? 'Paused' : 'Now', j.endsAt ? `ends ~${clock(j.endsAt)}` : `for ${inFor(now - (j.started || now))}`));
      q.waiting.forEach((j, i) => body.append(row(j, ordinal(i + 1), j.startsAt && j.startsAt > now ? `~${clock(j.startsAt)}` : j.startsText && j.startsText !== 'unknown' ? j.startsText : 'not known yet')));
      tb.append(body);
      t.append(tb);
      out.push(section(resName(q.res), q.waiting.length ? `${plural(q.waiting.length, 'agent')} waiting. ${whyRes(q.res)}.` : clears ? `Free around ${clock(clears)}` : 'Nobody waiting', t));
    } else out.push(quiet('Every queue is free.', 'Agents take turns here when two want the same thing: the simulator, a build, a deploy, a file.'));
    const caps = (data.caps || []).filter(c => !chosen || c.who === chosen);
    if (caps.length) {
      const list = el('div', 'list');
      for (const c of caps) {
        const r = el('div', 'lrow still');
        const main = el('span', 'l-main');
        main.append(el('b', null, c.who), ` runs ${c.prio === 'idle' ? 'only when nothing else is waiting' : 'behind others'}${c.by ? `, set by ${c.by}` : ''}.`);
        const key = `cap-${c.who}`;
        const b = button('btn small', 'Let it run normally', () => post('/api/cap', { agent: c.who, prio: 'off' }, key));
        b.disabled = busy.has(key);
        r.append(main, b);
        list.append(r);
      }
      out.push(section('Held back', 'dibs cap', list));
    }
    box.replaceChildren(...out);
  }

  // ---- Schedule: a channel per resource, like a TV guide ------------------------

  // What ran in the last two hours (the Mac app's guide's window) left of the red line at now, what's on through it,
  // what waits after it. One channel per resource; every file lease shares one.
  const GUIDE_BACK = 2 * 36e5;
  function scheduleView() {
    const box = $('v-schedule');
    const now = data.now, lo = now - GUIDE_BACK;
    const chans = new Map();
    const chan = r => { const k = r.startsWith('files:') ? 'files' : r; if (!chans.has(k)) chans.set(k, { res: k, progs: [] }); return chans.get(k); };
    // Past runs: each end event with the start it closes.
    const evs = side.today?.events || [];
    const starts = new Map(evs.filter(e => e.kind === 'start').map(e => [`${e.id}`, e]));
    for (const e of evs) {
      if (e.kind !== 'end' || e.at < lo) continue;
      const from = starts.get(`${e.id}`)?.at ?? e.at - (e.ms || 0);
      for (const r of e.res || []) chan(r).progs.push({ kind: e.code && e.code !== 0 ? 'failed' : 'ran', who: e.who || 'dibs', from: Math.max(lo, from), to: e.at, tip: `${e.who || 'dibs'}: ran ${span(e.at - from)}${e.code != null ? `, exit ${e.code}` : ''}` });
    }
    for (const j of data.jobs) for (const r of j.res) {
      if (j.state === 'waiting') {
        const from = j.startsAt && j.startsAt > now ? j.startsAt : now;
        chan(r).progs.push({ kind: 'wait', who: j.who, from, to: from + (j.est || 10 * 6e4), job: j, tip: `${j.who}: #${j.place} in line` });
      } else chan(r).progs.push({ kind: j.state === 'paused' ? 'paused' : 'run', who: j.who, from: Math.max(lo, j.started || now), to: j.endsAt || now + 5 * 6e4, open: !j.endsAt, job: j, tip: `${j.who}: ${j.purpose || j.cmd || 'on now'}` });
    }
    const list = [...chans.values()].sort((a, b) => resName(a.res).localeCompare(resName(b.res)));
    $('summary').textContent = list.length ? `What ran in the last two hours, what's on now, and what's waiting. ${press()} a job to change it.` : '';
    if (!list.length) return box.replaceChildren(quiet('Nothing ran in the last two hours and nothing is waiting.', 'Runs show up here as agents take their turns.'));
    const hi = Math.max(now + 45 * 6e4, ...list.flatMap(c => c.progs.map(p => p.to)).filter(t => t < now + 6 * 36e5)) + 5 * 6e4;
    // The past gets no more of the width than what's on and coming: a quiet evening
    // shouldn't push now to the right edge.
    const from = Math.max(lo, Math.min(now - 30 * 6e4, ...list.flatMap(c => c.progs.map(p => p.from))), now - (hi - now));
    const at = t => ((Math.min(hi, Math.max(from, t)) - from) / (hi - from)) * 100;
    const step = [15, 30, 60, 120].map(m => m * 6e4).find(st => (hi - from) / st <= 7) || 18e4 * 40;
    const guide = el('div', 'guide card');
    const head = el('div', 'g-row g-head');
    const axis = el('div', 'g-track');
    for (let t = Math.ceil(from / step) * step; t < hi; t += step) if (Math.abs(at(t) - at(now)) > 6) { const k = el('span', 's-tick', clock(t)); k.style.left = `${at(t)}%`; axis.append(k); }
    const tag = el('span', 's-nowtag', 'Now');
    tag.style.left = `${at(now)}%`;
    axis.append(tag);
    head.append(el('span', 'g-name'), axis);
    guide.append(head);
    for (const c of list) {
      const r = el('div', 'g-row');
      const name = el('span', 'g-name');
      name.append(resDot(c.res), resName(c.res));
      const track = el('div', 'g-track');
      for (let t = Math.ceil(from / step) * step; t < hi; t += step) { const g = el('i', 's-grid'); g.style.left = `${at(t)}%`; track.append(g); }
      for (const p of c.progs) {
        if (p.to < from) continue;
        // A name only where it fits; the rest say who on hover.
        const b = el(p.job ? 'button' : 'span', `prog k-${p.kind}${p.open ? ' open' : ''}`, at(p.to) - at(p.from) > 5 ? p.who : '');
        b.style.left = `${at(p.from)}%`;
        b.style.width = `${Math.max(0.6, at(p.to) - at(p.from))}%`;
        b.title = p.tip;
        if (p.job) { b.type = 'button'; b.addEventListener('click', () => jobSheet(p.job.id)); }
        track.append(b);
      }
      const nowLine = el('i', 's-now');
      nowLine.style.left = `${at(now)}%`;
      track.append(nowLine);
      r.append(name, track);
      guide.append(r);
    }
    const legend = el('div', 'legend');
    legend.append(el('i', 'key k-ran'), 'Ran', el('i', 'key k-run'), 'On now', el('i', 'key k-wait'), 'Waiting', el('i', 'key k-failed'), 'Failed');
    box.replaceChildren(section('Channels', legend, guide));
  }

  // ---- A job's sheet: what it is, and boost, pause, resume, stop ----------

  let sheetJob = null, confirming = false;
  function jobSheet(id) {
    sheetJob = id;
    confirming = false;
    drawSheet();
    const d = $('job');
    if (!d.open) d.showModal();
  }
  function drawSheet() {
    const d = $('job');
    const j = data?.jobs.find(x => x.id === sheetJob);
    if (!j) {
      d.replaceChildren(el('h2', 'sheet-title', `#${sheetJob} is gone`), el('p', 'sheet-text', 'It ended or left the line.'), sheetClose());
      return;
    }
    const key = `job-${j.id}`, wait = j.state === 'waiting';
    const title = el('h2', 'sheet-title', j.purpose || j.cmd || j.res.join(', '));
    title.id = 'job-title';
    const facts = el('dl', 'facts');
    const fact = (k, v) => { if (v) facts.append(el('dt', null, k), el('dd', null, v)); };
    fact('Agent', `${j.who}${j.label && j.label !== j.who ? ` (${j.label})` : ''}`);
    fact('Job', `#${j.id}, ${j.state}${j.kind === 'hold' ? ' (a hold)' : ''}`);
    fact('Needs', j.res.map(r => r.replace(/^files:/, 'file ')).join(', '));
    fact('Command', j.cmd);
    fact('Folder', j.project);
    fact(wait ? 'Waiting' : 'Started', wait ? `${j.queued ? `since ${clock(j.queued)}, ` : ''}#${j.place} in line${j.startsAt ? `, starts ~${clock(j.startsAt)}` : ''}` : j.started ? `${clock(j.started)}, ${inFor(data.now - j.started)} ago` : '');
    fact('Ends', !wait && (j.endsAt ? `~${clock(j.endsAt)}` : j.ends));
    fact('Why', j.blocked || j.headline);
    // dibs why and dibs when, for this one job: what it waits for, and how its place was worked out.
    fact('Waiting for', wait && j.waitingFor);
    fact('Priority', j.prio && j.prio !== 'normal' ? j.prio : '');
    fact('Paused', j.paused);
    if (wait && j.moves?.length) {
      const ul = el('ul', 'moves');
      for (const mv of j.moves) ul.append(el('li', mv.dir === 'up' ? 'up' : 'down', `${mv.dir === 'up' ? 'Up' : 'Back'} ${mv.amount || ''}${mv.reason ? `: ${mv.reason}` : mv.label ? `: ${mv.label}` : ''}`.replace(/ +:/, ':')));
      facts.append(el('dt', null, 'Why this place'), el('dd', null));
      facts.lastChild.append(ul);
    }
    const acts = el('div', 'sheet-acts');
    const dis = busy.has(key);
    const boost = (p, label) => { const b = button('btn', label, () => post(`/api/jobs/${j.id}/boost`, { prio: p }, key)); b.disabled = dis; return b; };
    acts.append(boost('urgent', 'Go first'), boost('normal', 'Normal place'), boost('low', 'Let others go first'));
    if (!wait) {
      const paused = j.state === 'paused';
      const b = button('btn', paused ? 'Resume' : 'Pause', async () => {
        const r = await post(`/api/jobs/${j.id}/${paused ? 'resume' : 'pause'}`, {}, key);
        // Refused as risky to freeze (a simulator, a deploy): the same --force the CLI offers.
        if (r?.error && /--force/.test(r.error)) {
          const again = button('btn', 'Pause anyway', () => post(`/api/jobs/${j.id}/pause`, { force: true }, key));
          acts.append(again);
        }
      });
      b.disabled = dis;
      acts.append(b);
    }
    const stop = button(`btn ${confirming ? 'primary' : 'danger'}`, confirming ? (wait ? 'Yes, take it out' : 'Yes, stop it') : (wait ? 'Take out of line' : 'Stop'), async () => {
      if (!confirming) { confirming = true; return drawSheet(); }
      confirming = false;
      const r = await post(`/api/jobs/${j.id}/stop`, { expect: wait ? 'waiting' : 'running' }, key);
      if (r && !r.error) d.close();
    });
    stop.disabled = dis;
    acts.append(stop);
    const note = el('p', 'sheet-note', confirming
      ? (wait ? `${j.who}'s dibs gets told it was taken out, and its command never runs.` : `This ends ${j.who}'s command and everything it started. It can't be undone.`)
      : 'Each runs the same dibs command you would, and the history says you did it.');
    d.replaceChildren(title, facts, acts, note, sheetClose());
  }
  function sheetClose() {
    const b = button('sheet-x', 'Close', () => $('job').close());
    b.setAttribute('aria-label', 'Close');
    return b;
  }
  $('job').addEventListener('close', () => { sheetJob = null; confirming = false; });
  $('job').addEventListener('click', e => { if (e.target === $('job')) $('job').close(); });

  // ---- Questions -----------------------------------------------------------

  function questions() {
    const box = $('v-questions');
    const q = side.questions;
    if (!q) return box.replaceChildren(loading('Loading questions'));
    const open = q.questions.filter(x => x.state === 'open');
    const done = q.questions.filter(x => x.state !== 'open').slice(0, 12);
    $('summary').textContent = open.length
      ? `${plural(open.length, 'question')} waiting. Agents ask these only at one-way doors; the agent that asked gets your answer with its next tool call.`
      : 'Nothing waiting for you. Agents ask here only before something they can\'t undo.';
    if (q.hours) $('summary').append(` Your hours are ${q.hours.start} to ${q.hours.end}; outside them, questions below urgent wait for morning.`);
    const out = [];
    if (open.length) out.push(...open.map(x => { const w = el('div', 'ticket-wrap ask-wrap'); w.append(askCard(x)); return w; }));
    if (done.length) {
      const sec = el('section');
      sec.append(el('div', 'sec-head'));
      sec.firstChild.append(el('h2', null, 'Answered lately'));
      const list = el('div', 'list');
      for (const x of done) {
        const r = el('div', 'lrow still');
        const main = el('span', 'l-main');
        main.append(el('b', null, x.agent || x.who), ` ${x.text}`);
        r.append(main, el('span', 'l-side', x.state === 'answered' ? `${x.answeredBy && x.answeredBy !== 'the person' ? `${x.answeredBy}: ` : ''}${x.answer}` : x.state));
        list.append(r);
      }
      sec.append(list);
      out.push(sec);
    }
    if (!out.length) out.push(quiet('No questions yet.', "When an agent needs a decision only you can make, it asks here."));
    box.replaceChildren(...out);
  }

  function askCard(x) {
    const key = `q-${x.id}`;
    const card = el('article', 'ask ticket');
    const head = el('div', 'ask-head');
    head.append(el('b', null, x.agent || x.who), el('span', 'ask-meta', `asked ${ago(data.now - x.asked)}${x.prio && x.prio !== 'normal' ? `, ${x.prio}` : ''}${x.waiting ? ', waiting on you now' : ''}`));
    if (x.held) head.append(el('span', 'pill done', 'held for your hours'));
    card.append(head, el('p', 'ask-text', x.text));
    if (x.why) card.append(el('p', 'ask-why', x.why));
    if (x.cantUndo) card.append(el('p', 'ask-undo', `Can't be undone: ${x.cantUndo}`));
    const row = el('div', 'ask-opts');
    for (const o of x.options || []) {
      const b = button(`btn${o === x.recommend ? ' primary' : ''}`, o === x.recommend ? `${o} (recommended)` : o, () => post(`/api/questions/${x.id}/answer`, { text: o }, key));
      b.disabled = busy.has(key);
      row.append(b);
    }
    const form = el('form', 'say');
    const input = el('input');
    input.placeholder = x.options?.length ? 'Or answer in your own words' : 'Your answer';
    input.dataset.keep = `ask-${x.id}`;
    input.maxLength = 4000;
    input.setAttribute('aria-label', `Answer ${x.agent || x.who}`);
    const send = el('button', 'btn', 'Send');
    send.type = 'submit';
    form.append(input, send);
    form.addEventListener('submit', e => { e.preventDefault(); if (input.value.trim()) post(`/api/questions/${x.id}/answer`, { text: input.value }, key); });
    const not = button('btn quiet', 'Not now', () => post(`/api/questions/${x.id}/dismiss`, {}, key));
    not.disabled = busy.has(key);
    row.append(not);
    card.append(row, form);
    return card;
  }

  // ---- Messages ------------------------------------------------------------

  function messages() {
    const box = $('v-messages');
    const t = side.threads;
    if (!t) return box.replaceChildren(loading('Loading messages'));
    // dibs's desk first, by the name it goes by in the app.
    const list = [...t.threads].sort((a, b) => (b.to === DESK) - (a.to === DESK));
    const unread = list.reduce((n, x) => n + x.unread, 0);
    $('summary').textContent = list.length
      ? `${plural(list.length, 'thread')}${unread ? `, ${unread} unread` : ''}. A message reaches its agent with its next tool call.`
      : 'Nothing from agents yet. Agents start a thread with dibs say or dibs question.';
    if (chosen && list.some(x => x.to === chosen)) thread = chosen;
    if (!thread || !list.some(x => x.to === thread)) thread = list[0]?.to || null;
    const left = el('div', 'threads');
    for (const x of list) {
      const b = el('button', 'thread');
      b.type = 'button';
      b.setAttribute('aria-current', String(x.to === thread));
      const last = x.messages.filter(m => m.kind !== 'delivered').at(-1);
      const top = el('span', 'thread-top');
      top.append(x.to === DESK ? el('span', 'desk-dot', 'd') : el('span', `dot ${x.alive ? (x.working === 'running' ? 'running' : x.working === 'waiting' ? 'waiting' : 'busy') : 'idle'}`),
        el('b', null, nameOfThread(x.to)), el('span', x.unread ? 'rail-meta count-pill hot' : 'rail-meta', x.unread ? String(x.unread) : ago(data.now - x.last)));
      b.append(top, el('span', 'thread-last', last ? `${last.from === 'person' ? 'You: ' : ''}${last.text}` : ''));
      b.addEventListener('click', () => { thread = x.to; chosen = ''; messages(); markRead(x); });
      left.append(b);
    }
    const th = list.find(x => x.to === thread);
    const right = el('div', 'convo');
    if (th) {
      markRead(th);
      const head = el('div', 'convo-head');
      head.append(el('h2', null, nameOfThread(th.to)), el('span', 'sec-note', th.to === DESK ? 'dibs answers about the machine and the agents' : th.alive ? (th.working || 'running') : 'not running; your messages wait for it'));
      const log = el('ol', 'msgs');
      for (const m of th.messages) log.append(message(m, th));
      const form = el('form', 'say');
      const input = el('textarea');
      input.rows = 2;
      input.maxLength = 4000;
      input.placeholder = th.to === DESK ? 'Ask dibs' : `Message ${th.to}`;
      input.dataset.keep = `tell-${th.to}`;
      input.setAttribute('aria-label', `Message ${th.to}`);
      const send = el('button', 'btn', 'Send');
      send.type = 'submit';
      send.disabled = busy.has(`tell-${th.to}`);
      form.append(input, send);
      const submit = async e => {
        e?.preventDefault();
        if (!input.value.trim()) return;
        const r = await post('/api/tell', { to: th.to, text: input.value }, `tell-${th.to}`);
        if (r && !r.error) input.value = '';
      };
      form.addEventListener('submit', submit);
      input.addEventListener('keydown', e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit(e); });
      right.append(head, log, form);
      requestAnimationFrame(() => { if (!log.dataset.held) log.scrollTop = log.scrollHeight; });
    } else right.append(el('p', 'empty', 'Pick a thread.'));
    box.replaceChildren(el('div', 'talk'));
    box.firstChild.append(left, right);
  }

  // The desk: the agent that answers for dibs (Chat.desk in the app).
  const DESK = 'desk';
  const nameOfThread = to => (to === DESK ? 'dibs' : to);
  const reading = new Set();
  function markRead(th) {
    if (!th.unread || reading.has(th.to)) return;
    reading.add(th.to);
    T.fetchApi('POST', '/api/read', { to: th.to }).catch(() => {})
      .finally(() => { reading.delete(th.to); pull('/api/threads', 0).catch(() => {}); });
  }

  function message(m, th) {
    const mine = m.from === 'person';
    const li = el('li', `msg ${mine ? 'me' : m.from === 'dibs' ? 'sys' : 'them'}${m.kind === 'delivered' ? ' sys' : ''}`);
    const meta = el('span', 'msg-meta', `${mine ? (m.by ? `${m.by} (an agent)` : 'You') : m.from === 'dibs' ? 'dibs' : nameOfThread(th.to)}, ${ago(data.now - m.at)}`);
    let text = m.text;
    if (m.kind === 'question') text = `Asked: ${m.text}`;
    if (m.kind === 'decided') text = `Decided it themselves: ${m.text} -> ${m.answer}`;
    if (m.kind === 'answer') text = `Answered: ${m.text}`;
    const body = el('p', 'msg-text', text);
    li.append(meta, body);
    if (m.kind === 'question' && m.state === 'open' && m.questionId != null) {
      const row = el('div', 'ask-opts');
      for (const o of m.options || []) row.append(button(`btn${o === m.recommend ? ' primary' : ''}`, o === m.recommend ? `${o} (recommended)` : o, () => post(`/api/questions/${m.questionId}/answer`, { text: o }, `q-${m.questionId}`)));
      row.append(button('btn quiet', 'Not now', () => post(`/api/questions/${m.questionId}/dismiss`, {}, `q-${m.questionId}`)));
      li.append(row);
    }
    if (m.state === 'queued') li.append(el('span', 'msg-meta', 'not delivered yet'));
    return li;
  }

  // ---- Scheduled runs (dibs later) -----------------------------------------

  function later() {
    const box = $('v-later');
    const jobs = side.later;
    if (!jobs) return box.replaceChildren(loading('Loading runs for later'));
    const active = jobs.filter(j => ['scheduled', 'waiting', 'running'].includes(j.state));
    const ended = jobs.filter(j => !active.includes(j)).sort((a, b) => (b.ended || 0) - (a.ended || 0)).slice(0, 40);
    $('summary').textContent = active.length
      ? `${plural(active.filter(j => j.state === 'scheduled').length, 'run')} for later, ${active.filter(j => j.state !== 'scheduled').length} started. Agents set these up with dibs later.`
      : 'Nothing for later. Agents set runs up with dibs later <resource> --at 02:00 -- <command>.';
    const rank = { running: 0, waiting: 1, scheduled: 2 };
    active.sort((a, b) => rank[a.state] - rank[b.state] || (a.at ?? Infinity) - (b.at ?? Infinity));
    const row = j => {
      const r = el('div', 'lrow still lat');
      const main = el('span', 'l-main');
      main.append(el('span', `pill ${j.state === 'done' ? (j.code === 0 ? 'doing' : 'blocked') : j.state === 'scheduled' ? 'done' : 'late'}`, j.state === 'done' ? `exit ${j.code}` : j.state), ' ', el('b', null, j.who), ` ${j.purpose || j.cmd}`);
      main.title = `${j.id}: ${j.cmd}`;
      const sideText = el('span', 'l-side', `${j.res.join(', ')}, ${j.state === 'scheduled' ? j.when || (j.after ? 'after another job' : '') : j.ended ? `ended ${ago(data.now - j.ended)}` : j.fired ? `started ${ago(data.now - j.fired)}` : ''}`);
      r.append(main, sideText);
      if (active.includes(j)) {
        const key = `later-${j.id}`;
        const b = button(`btn small ${confirmLater === j.id ? 'primary' : 'danger'}`, confirmLater === j.id ? 'Yes, cancel' : 'Cancel', async () => {
          if (confirmLater !== j.id) { confirmLater = j.id; return later(); }
          confirmLater = null;
          await post(`/api/later/${j.id}/cancel`, {}, key);
        });
        b.disabled = busy.has(key);
        r.append(b);
      }
      return r;
    };
    const out = [];
    const sec = (title, rows, note) => {
      const s = el('section');
      const h = el('div', 'sec-head');
      h.append(el('h2', null, title), el('span', 'sec-note', note || ''));
      const l = el('div', 'list');
      l.append(...rows);
      s.append(h, l);
      return s;
    };
    if (active.length) out.push(sec('Coming up', active.map(row), active.some(j => j.state !== 'scheduled') ? 'A started one is stopped if you cancel it.' : ''));
    if (ended.length) out.push(sec('Ended this week', ended.map(row), `${ended.filter(j => j.code === 0).length} of ${ended.length} exited 0`));
    if (!out.length) out.push(quiet('No runs for later this week.', 'An agent schedules one with dibs later test --at 02:00 -- <command>.'));
    box.replaceChildren(...out);
  }
  let confirmLater = null;

  // ---- Charts: hand-drawn SVG, sized to the box they fill -------------------

  const NS = 'http://www.w3.org/2000/svg';
  function svg(tag, attrs = {}, text) {
    const e = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    if (text != null) e.textContent = text;
    return e;
  }
  const widthOf = box => Math.max(280, Math.floor(box.clientWidth || $('v-' + view).clientWidth || 600));
  // Round numbers for an axis: 1, 2 or 5 times a power of ten.
  function nice(max, n = 4) {
    const raw = max / n, p = 10 ** Math.floor(Math.log10(raw || 1));
    const step = [1, 2, 5, 10].map(m => m * p).find(s => s >= raw) || p * 10;
    return { step, top: Math.max(step, Math.ceil(max / step) * step) };
  }

  // Each day's run and wait hours, stacked, across the full width.
  function dayBars(box, days) {
    const W = widthOf(box), H = 190, L = 36, B = 22, T = 8;
    const max = Math.max(1, ...days.map(d => (d.runMs + d.waitMs) / 36e5));
    const { step, top } = nice(max);
    const s = svg('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}`, class: 'chart', role: 'img', 'aria-label': 'Run and wait hours each day' });
    const y = v => T + (H - T - B) * (1 - v / top);
    for (let v = 0; v <= top; v += step) {
      s.append(svg('line', { x1: L, x2: W, y1: y(v), y2: y(v), class: v ? 'grid' : 'base' }));
      s.append(svg('text', { x: L - 6, y: y(v) + 4, class: 'ax end' }, `${v}h`));
    }
    const slot = (W - L) / days.length, bw = Math.max(3, Math.min(56, slot * 0.72));
    const every = Math.ceil(days.length / Math.floor((W - L) / 46));
    days.forEach((d, i) => {
      const x = L + i * slot + (slot - bw) / 2, run = d.runMs / 36e5, wait = d.waitMs / 36e5;
      const g = svg('g');
      g.append(svg('title', {}, `${new Date(d.day).toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' })}: ${plural(d.jobs, 'job')}, ran ${span(d.runMs)}, waited ${span(d.waitMs)}${d.runs ? `, ${d.failed} of ${d.runs} runs failed` : ''}`));
      g.append(svg('rect', { x, width: bw, y: y(run), height: Math.max(0, y(0) - y(run)), class: 'f-run', rx: 2 }));
      if (wait) g.append(svg('rect', { x, width: bw, y: y(run + wait), height: Math.max(1, y(run) - y(run + wait)), class: 'f-wait', rx: 2 }));
      s.append(g);
      if (i % every === 0) s.append(svg('text', { x: x + bw / 2, y: H - 6, class: 'ax mid' }, days.length > 8 ? String(new Date(d.day).getDate()) : dayName(d.day)));
    });
    box.replaceChildren(s);
  }

  // Days down, hours across: when work ran, or when agents waited.
  function heat(box, grid, kind) {
    const W = widthOf(box), L = 64, T = 18, rows = grid.length, ch = rows > 10 ? 13 : 20, gap = 2;
    const H = T + rows * (ch + gap);
    const cw = (W - L) / 24;
    const max = Math.max(1, ...grid.flatMap(r => r[kind]));
    const s = svg('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}`, class: 'chart', role: 'img', 'aria-label': `${kind === 'run' ? 'Running' : 'Waiting'} time by day and hour` });
    for (let h = 0; h < 24; h += cw < 22 ? 3 : 2) s.append(svg('text', { x: L + h * cw + 1, y: 11, class: 'ax' }, new Date(2000, 0, 1, h).toLocaleTimeString([], { hour: 'numeric' }).replace(/\s/g, '').toLowerCase()));
    grid.forEach((r, i) => {
      const yy = T + i * (ch + gap);
      s.append(svg('text', { x: 0, y: yy + ch - 3, class: 'ax' }, dayName(r.day)));
      r[kind].forEach((v, h) => {
        const c = svg('rect', { x: L + h * cw + 1, y: yy, width: Math.max(1, cw - gap), height: ch, rx: 2, class: v ? `f-${kind}` : 'f-none' });
        if (v) c.setAttribute('fill-opacity', (0.12 + 0.88 * Math.sqrt(v / max)).toFixed(2));
        c.append(svg('title', {}, `${dayName(r.day)} ${h}:00: ${kind === 'run' ? 'ran' : 'waited'} ${span(v)}${r.jobs[h] ? `, ${plural(r.jobs[h], 'job')} started` : ''}`));
        s.append(c);
      });
    });
    box.replaceChildren(s);
  }

  // The machine over the window: load against its cores, free memory, free disk.
  function machineChart(box, series, from, to, cores) {
    const W = widthOf(box), L = 44, strip = 74, gap = 16, B = 20;
    const rows = [
      { key: 'load', label: 'Load', fmt: v => v.toFixed(0), max: Math.max(cores || 1, ...series.map(p => p.load || 0)), line: cores, lineLabel: `${cores} cores` },
      { key: 'memFree', label: 'Memory free', fmt: v => `${Math.round(v)}%`, max: 100, line: 15, lineLabel: 'dibs holds jobs' },
      { key: 'diskFree', label: 'Disk free', fmt: v => gb(v), max: Math.max(...series.map(p => p.diskFree || 0), 1), line: 5 * 1024 ** 3, lineLabel: '5 GB floor' },
    ];
    const H = rows.length * (strip + gap) + B;
    const s = svg('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}`, class: 'chart', role: 'img', 'aria-label': 'Load, memory and disk over time' });
    const x = t => L + (W - L) * ((t - from) / Math.max(1, to - from));
    rows.forEach((r, i) => {
      const top = i * (strip + gap) + 14, y = v => top + strip - 14 - (strip - 14) * Math.min(1, v / r.max);
      s.append(svg('text', { x: L, y: top - 3, class: 'ax lab' }, r.label));
      s.append(svg('line', { x1: L, x2: W, y1: y(0), y2: y(0), class: 'base' }));
      if (r.line != null && r.line < r.max * 1.01) {
        s.append(svg('line', { x1: L, x2: W, y1: y(r.line), y2: y(r.line), class: 'limit' }));
        s.append(svg('text', { x: L + 6, y: y(r.line) - 4, class: 'ax' }, r.lineLabel));
      }
      s.append(svg('text', { x: L - 6, y: y(r.max) + 8, class: 'ax end' }, r.fmt(r.max)));
      let d = '', last = null;
      for (const p of series) {
        if (p[r.key] == null) { last = null; continue; }
        // A gap of more than a few buckets is time nothing was sampled: lift the pen.
        d += `${last == null || p.at - last > (to - from) / 40 ? 'M' : 'L'}${x(p.at).toFixed(1)},${y(p[r.key]).toFixed(1)}`;
        last = p.at;
      }
      s.append(svg('path', { d, class: `ln ln-${r.key}` }));
    });
    // Under two days: clock hours. Longer: local midnights, named by day.
    if (to - from <= 2 * 864e5) {
      const step = [36e5, 2 * 36e5, 3 * 36e5, 6 * 36e5].find(st => (W - L) / ((to - from) / st) > 70) || 6 * 36e5;
      for (let t = Math.ceil(from / step) * step; t < to; t += step) s.append(svg('text', { x: x(t), y: H - 4, class: 'ax mid' }, clock(t)));
    } else {
      const every = Math.ceil(((to - from) / 864e5) / Math.max(1, Math.floor((W - L) / 64)));
      let i = 0;
      for (let d = new Date(from).setHours(24, 0, 0, 0); d < to; d = new Date(d).setDate(new Date(d).getDate() + 1), i++) {
        if (i % every) continue;
        s.append(svg('line', { x1: x(d), x2: x(d), y1: 8, y2: H - B, class: 'grid' }));
        s.append(svg('text', { x: x(d), y: H - 4, class: 'ax mid' }, dayName(d)));
      }
    }
    box.replaceChildren(s);
  }

  // A tiny 24-hour strip: how busy a resource is at each hour of the day.
  function hourStrip(hours) {
    const W = 120, H = 18, bw = W / 24;
    const s = svg('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}`, class: 'strip', role: 'img', 'aria-label': 'In use by hour of day' });
    const max = Math.max(0.05, ...hours);
    hours.forEach((v, h) => {
      const hh = Math.max(1, (H - 2) * (v / max));
      const r = svg('rect', { x: h * bw + 0.5, y: H - hh, width: bw - 1, height: hh, class: v ? 'f-run' : 'f-none' });
      r.append(svg('title', {}, `${h}:00: in use ${pct(v)} of the time`));
      s.append(r);
    });
    return s;
  }
  // Run and wait time side by side, on a shared scale.
  function runWait(run, wait, max) {
    const W = 110, H = 10;
    // Stretched, not scaled, when a phone narrows it (app.css).
    const s = svg('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none', class: 'strip', 'aria-hidden': 'true' });
    const rw = W * run / max, ww = W * wait / max;
    s.append(svg('rect', { x: 0, y: 1, width: Math.max(run ? 1 : 0, rw), height: H - 2, rx: 2, class: 'f-run' }));
    s.append(svg('rect', { x: rw + (wait ? 1 : 0), y: 1, width: Math.max(wait ? 1 : 0, ww), height: H - 2, rx: 2, class: 'f-wait' }));
    return s;
  }
  // Horizontal bars, labelled, for a short ranked list.
  function bars(items, fmt, cls = 'f-run') {
    const box = el('div', 'hbars');
    const max = Math.max(1, ...items.map(x => x.value));
    for (const x of items) {
      const r = el('div', 'hbar');
      const track = el('span', 'hbar-track');
      const fill = el('i', cls);
      fill.style.width = `${Math.max(1, 100 * x.value / max)}%`;
      track.append(fill);
      const name = el('span', 'hbar-name', x.name);
      name.title = x.name;
      r.append(name, track, el('span', 'hbar-val', fmt(x)));
      box.append(r);
    }
    return box;
  }

  function spanPicker(cur, onPick) {
    const seg = el('div', 'seg');
    for (const [v, label] of [['1d', 'Past day'], ['7d', 'Past week'], ['30d', 'Past 30 days']]) {
      const b = button('seg-btn', label, () => onPick(v));
      b.setAttribute('aria-pressed', String(v === cur));
      seg.append(b);
    }
    return seg;
  }
  function section(title, note, ...body) {
    const s = el('section');
    const h = el('div', 'sec-head');
    h.append(el('h2', null, title));
    if (note) h.append(typeof note === 'string' ? el('span', 'sec-note', note) : note);
    s.append(h, ...body);
    return s;
  }
  function table(cols, rows, onRow) {
    const wrap = el('div', 'tbl-wrap');
    const t = el('table', 'tbl');
    const hr = el('tr');
    for (const c of cols) { const th = el('th', c.num ? 'num' : '', c.label); th.scope = 'col'; hr.append(th); }
    t.append(el('thead'));
    t.firstChild.append(hr);
    const tb = el('tbody');
    for (const r of rows) {
      const tr = el('tr', onRow ? 'pick' : '');
      cols.forEach((c, i) => {
        const v = c.get(r);
        const td = el(i ? 'td' : 'th', c.num ? 'num' : '');
        if (!i) td.scope = 'row';
        if (v instanceof Node) td.append(v); else td.textContent = v ?? '-';
        tr.append(td);
      });
      if (onRow) { tr.tabIndex = 0; tr.addEventListener('click', () => onRow(r)); tr.addEventListener('keydown', e => { if (e.key === 'Enter') onRow(r); }); }
      tb.append(tr);
    }
    t.append(tb);
    wrap.append(t);
    return wrap;
  }

  // ---- Stats ---------------------------------------------------------------

  function stats() {
    const box = $('v-stats');
    const s = side.stats;
    const head = el('div', 'view-tools');
    head.append(spanPicker(statsSpan, v => { statsSpan = v; stats(); refresh(); }));
    if (chosen) head.append(button('btn quiet small', 'Everyone', () => go('stats', '')));
    if (!s || s.agent !== (chosen || null)) { box.replaceChildren(head, loading('Counting')); return; }
    const t = s.totals;
    $('summary').replaceChildren(statsLead(s));
    const out = [head];
    if (!t.jobs && !t.posts) { box.replaceChildren(head, el('p', 'empty', `${chosen || 'Nobody'} ran anything through dibs in this period.`)); return; }

    const trend = el('div', 'chart-box');
    const legend = el('span', 'legend');
    legend.append(el('i', 'key f-run'), 'running', el('i', 'key f-wait'), 'waiting');
    out.push(section('Every day', legend, trend));
    const heatBox = el('div', 'chart-box');
    const pick = el('div', 'seg small');
    for (const [k, label] of [['run', 'Running'], ['wait', 'Waiting']]) {
      const b = button('seg-btn', label, () => { heatKind = k; stats(); });
      b.setAttribute('aria-pressed', String(heatKind === k));
      pick.append(b);
    }
    out.push(section('By hour', pick, heatBox));

    if (!chosen && s.agents.length) {
      const max = Math.max(1, ...s.agents.map(a => a.runMs + a.waitMs));
      out.push(section('Agents', `${press()} one for its own numbers`, table([
        { label: 'Agent', get: a => a.who },
        { label: 'Jobs', num: true, get: a => a.jobs.toLocaleString() },
        { label: 'Ran / waited', get: a => { const f = el('span', 'rw'); f.append(runWait(a.runMs, a.waitMs, max), `${span(a.runMs)} / ${span(a.waitMs)}`); return f; } },
        { label: 'Had to wait', num: true, get: a => (a.waited ? `${plural(a.waited, 'time')}, usually ${span(a.feltMedian)}` : 'never') },
        { label: 'Waited longer than ran', num: true, get: a => pct(a.waitedLongerShare) },
        { label: 'Failed', num: true, get: a => (a.runs ? `${pct(a.failRate)} of ${a.runs}` : '-') },
        { label: 'ETAs met', num: true, get: a => (a.eta.finished ? `${a.eta.onTime} of ${a.eta.finished}` : '-') },
        { label: 'Posts', num: true, get: a => a.posts || '-' },
      ], s.agents, a => go('stats', a.who))));
    }
    if (chosen && s.agents[0]) out.push(...agentDetail(s.agents[0]));

    if (s.resources.length) {
      out.push(section('Resources', 'In use: share of the window something held it', table([
        { label: 'Resource', get: r => resName(r.res) },
        { label: 'Jobs', num: true, get: r => r.jobs.toLocaleString() },
        { label: 'In use', num: true, get: r => `${span(r.busyMs)}, ${pct(r.utilization)}` },
        { label: 'By hour of day', get: r => hourStrip(r.hours) },
        { label: 'Had to wait', num: true, get: r => (r.waited ? `${r.waited.toLocaleString()}x, usually ${span(r.feltMedian)}` : 'never') },
        { label: '1 in 10 over', num: true, get: r => span(r.p90Wait) },
        { label: 'Held back by', get: r => (r.heldBy[0] ? `${r.heldBy[0].label} (${span(r.heldBy[0].ms)})` : '-') },
        { label: 'Gave up', num: true, get: r => r.gaveUp || '-' },
      ], s.resources)));
    }
    if (t.heldBy.length) out.push(section('What held jobs back', 'Time jobs waited, by the rule that held them', bars(t.heldBy.slice(0, 8).map(h => ({ name: h.label, value: h.ms, h })), x => `${span(x.value)}, ${plural(x.h.jobs, 'job')}`, 'f-wait')));

    const m = s.machine, mBox = el('div', 'chart-box');
    out.push(section('The machine', machineNote(m), mBox));
    if (m.overrides.length) out.push(section('Overrides and setting changes', `${m.overrides.length} in this window, by whoever made them`, changeList(m.overrides)));
    box.replaceChildren(...out);
    dayBars(trend, s.days);
    heat(heatBox, s.grid, heatKind);
    if (m.series.length) machineChart(mBox, m.series, s.since, s.until, data.machine.cores); else mBox.replaceChildren(el('p', 'empty', 'No machine samples in this window. The throttle watcher takes them (dibs service install throttle).'));
  }

  // The few sentences on top: only what the numbers carry.
  function statsLead(s) {
    const t = s.totals, f = document.createDocumentFragment();
    const who = s.agent || `${plural(t.agents, 'agent')}`;
    f.append(`${who} ran ${plural(t.jobs, 'job')} for ${span(t.runMs)} and waited ${span(t.waitMs)} for turns. `);
    if (t.waitedLongerShare != null) f.append(`${pct(t.waitedLongerShare)} waited longer than they ran. `);
    if (t.runs) f.append(`${pct(t.failRate)} of runs failed${t.stopped ? `, ${t.stopped} were stopped` : ''}. `);
    if (t.gaveUp) f.append(`${plural(t.gaveUp, 'request')} gave up waiting. `);
    if (t.eta.finished) f.append(`${t.eta.onTime} of ${plural(t.eta.finished, 'task')} finished by their ETA${t.eta.medianLate > 0 ? `; the late ones ran ${span(t.eta.medianLate)} over` : ''}.`);
    return f;
  }
  function machineNote(m) {
    const parts = [];
    if (m.loadHigh) parts.push(`load peaked at ${m.loadHigh.load.toFixed(0)} around ${dayName(m.loadHigh.at)} ${clock(m.loadHigh.at)}`);
    if (m.memLow?.memFree != null) parts.push(`memory got down to ${Math.round(m.memLow.memFree)}% free`);
    parts.push(`${plural(m.pauses, 'pause')} (${m.ownerPauses} by hand, ${m.dibsPauses} by dibs for memory or urgent work)`);
    return parts.join('; ');
  }
  function agentDetail(a) {
    const out = [];
    const facts = el('p', 'prose');
    facts.append(a.waited ? `${plural(a.waited, 'job')} of ${a.jobs} had to wait, usually ${span(a.feltMedian)}; 1 in 10 jobs waited over ${span(a.p90Wait)}. ` : 'None of its jobs had to wait. ');
    if (a.peakMem) facts.append(`Its biggest run used ${gb(a.peakMem)} of memory. `);
    if (a.blockedMs) facts.append(`It was blocked for ${span(a.blockedMs)}${a.blockedNow ? ' and still is' : ''}. `);
    if (a.gaveUp) facts.append(`${plural(a.gaveUp, 'request')} gave up waiting. `);
    if (a.posts) facts.append(`${plural(a.posts, 'progress post')}, ${plural(a.tasksDone, 'task')} done.`);
    out.push(facts);
    if (a.resources.length) out.push(section('Where its time went', null, bars(a.resources.map(r => ({ name: r.name, value: r.ms, r })), x => `${span(x.value)}, ${plural(x.r.n, 'job')}`)));
    const codes = Object.entries(a.codes).sort((x, y) => y[1] - x[1]);
    if (codes.length) {
      const total = codes.reduce((n, [, c]) => n + c, 0);
      const bar = el('div', 'codes');
      const keys = el('div', 'codes-keys');
      for (const [code, n] of codes) {
        const kind = code === '0' ? 'ok' : ['130', '137', '143'].includes(code) ? 'stop' : code === 'none' ? 'stop' : 'bad';
        const seg = el('i', `code-${kind}`);
        seg.style.flexGrow = String(n);
        seg.title = `exit ${code}: ${n}`;
        bar.append(seg);
        const k = el('span', 'code-key');
        k.append(el('i', `key code-${kind}`), `${code === 'none' ? 'no code' : `exit ${code}`} ${n} (${Math.round(100 * n / total)}%)`);
        keys.append(k);
      }
      out.push(section('How its runs ended', `${a.failed} failed, ${a.stopped} stopped by a signal`, bar, keys));
    }
    if (a.commands.length) out.push(section('Top commands', 'From the run log, with time spent', bars(a.commands.map(c => ({ name: c.name, value: c.ms, c })), x => `${x.c.n}x, ${span(x.value)}`)));
    if (a.heldBy.length) out.push(section('What held it back', null, bars(a.heldBy.slice(0, 6).map(h => ({ name: h.label, value: h.ms, h })), x => span(x.value), 'f-wait')));
    return out;
  }
  function changeList(list) {
    const box = el('div', 'list');
    for (const e of list) {
      const r = el('div', 'lrow still');
      const main = el('span', 'l-main');
      const what = { boost: `set #${e.id} to ${e.prio}`, pause: `paused #${e.id}`, resume: `resumed #${e.id}`, stop: `stopped #${e.id}`, cap: `capped ${e.who || 'an agent'} at ${e.prio}`, tell: `messaged ${e.to}`, answer: 'answered a question', dismiss: 'dismissed a question' }[e.act] || e.act;
      main.append(el('b', null, e.by || 'the person'), ` ${what}${e.who && e.act !== 'cap' ? ` (${e.who}'s)` : ''}${e.reason ? `: ${e.reason}` : ''}`);
      r.append(main, el('span', 'l-side', ago(data.now - e.at)));
      box.append(r);
    }
    return box;
  }

  // ---- History (dibs history) ------------------------------------------------

  function pastView() {
    const box = $('v-history');
    const h = side.history;
    const head = el('div', 'view-tools');
    head.append(spanPicker(histSpan, v => { histSpan = v; pastView(); refresh(); }));
    if (!h || h.since !== histSpan) { box.replaceChildren(head, loading('Reading the history')); return; }
    $('summary').textContent = h.lines.join(' ');
    const out = [head];
    // One row for every file lease together, as the Mac app's schedule shows them.
    const files = Object.entries(h.resources).filter(([k]) => k.startsWith('files:')).map(([, r]) => r);
    const res = Object.entries(h.resources).filter(([k]) => !k.startsWith('files:'));
    if (files.length) res.push(['file leases', { busyMs: files.reduce((n, r) => n + r.busyMs, 0), waits: files.reduce((n, r) => n + r.waits, 0), waitMs: files.reduce((n, r) => n + r.waitMs, 0),
      p50WaitMs: null, p90WaitMs: null, peakQueue: Math.max(...files.map(r => r.peakQueue)), timeouts: files.reduce((n, r) => n + r.timeouts, 0), mostly: null }]);
    res.sort((a, b) => b[1].waitMs - a[1].waitMs || b[1].busyMs - a[1].busyMs);
    if (res.length) {
      const hour = x => (x ? `${new Date(2000, 0, 1, x[0]).toLocaleTimeString([], { hour: 'numeric' })} to ${new Date(2000, 0, 1, (x[0] + x[1]) % 24).toLocaleTimeString([], { hour: 'numeric' })}` : '-');
      out.push(section('By resource', null, table([
        { label: 'Resource', get: ([k]) => (k === 'file leases' ? 'File locks' : resName(k)) },
        { label: 'In use', num: true, get: ([, r]) => span(r.busyMs) },
        { label: 'Waits', num: true, get: ([, r]) => r.waits },
        { label: 'Waited', num: true, get: ([, r]) => span(r.waitMs) },
        { label: 'Usual / long wait', num: true, get: ([, r]) => (r.waits && r.p50WaitMs != null ? `${span(r.p50WaitMs)} / ${span(r.p90WaitMs)}` : '-') },
        { label: 'Longest queue', num: true, get: ([, r]) => r.peakQueue },
        { label: 'Gave up', num: true, get: ([, r]) => r.timeouts || '-' },
        { label: 'Waits mostly', get: ([, r]) => hour(r.mostly) },
      ], res.slice(0, 30))));
    }
    // When agents waited: the most waiting at once in each hour, days down.
    const days = new Map();
    for (const x of h.hourly) {
      const d = new Date(x.hour); d.setHours(0, 0, 0, 0);
      const row = days.get(+d) || { day: +d, wait: new Array(24).fill(0), run: new Array(24).fill(0), jobs: new Array(24).fill(0) };
      row.wait[new Date(x.hour).getHours()] = x.waiting;
      row.run[new Date(x.hour).getHours()] = x.held;
      days.set(+d, row);
    }
    const heatBox = el('div', 'chart-box');
    out.push(section('When agents waited', 'Darker: more agents waiting at once', heatBox));
    // The app's "Each agent": time spent using something, and time spent waiting for it.
    const ags = Object.entries(h.agents || {}).filter(([, a]) => a.holdMs || a.waitMs).sort((a, b) => b[1].waitMs + b[1].holdMs - a[1].waitMs - a[1].holdMs).slice(0, 20);
    if (ags.length) {
      const max = Math.max(1, ...ags.map(([, a]) => a.holdMs + a.waitMs));
      const list = el('div', 'hbars');
      for (const [who, a] of ags) {
        const r = el('div', 'hbar');
        const name = el('span', 'hbar-name', who);
        name.title = who;
        const track = el('span', 'hbar-track rw-track');
        for (const [ms, cls] of [[a.holdMs, 'f-run'], [a.waitMs, 'f-wait']]) { const i = el('i', cls); i.style.width = `${100 * ms / max}%`; track.append(i); }
        r.append(name, track, el('span', 'hbar-val', `${span(a.holdMs)} / ${span(a.waitMs)}`));
        list.append(r);
      }
      const legend = el('span', 'legend');
      legend.append(el('i', 'key f-run'), 'using', el('i', 'key f-wait'), 'waiting');
      out.push(section('By agent', legend, list));
    }
    if (h.changes.length) out.push(section('What was changed by hand', 'Agents may do anything you can; this names who did what', changeList(h.changes)));
    const log = el('ol', 'log');
    for (const e of h.events.slice(0, 120)) {
      const li = el('li');
      const what = e.kind === 'start' ? `started ${e.res.join(', ')}${e.ms > 1000 ? ` after waiting ${span(e.ms)}` : ''}`
        : e.kind === 'end' ? `finished ${e.res.join(', ')} after ${span(e.ms)}${e.code != null ? `, exit ${e.code}` : ''}`
        : e.kind === 'wait' ? `began waiting for ${e.res.join(', ')}${e.rule ? ` (${e.rule})` : ''}`
        : e.kind === 'timeout' ? `gave up waiting for ${e.res.join(', ')}` : e.kind === 'left' ? `left the line for ${e.res.join(', ')}${e.why ? `: ${e.why}` : ''}`
        : `${e.kind} ${e.res.join(', ')}`;
      li.append(el('time', 'post-time', clock(e.at)), el('span', null, ''));
      li.lastChild.append(el('b', null, e.who || 'dibs'), ` ${what}`);
      log.append(li);
    }
    out.push(section('Latest', `${Math.min(120, h.events.length)} newest events`, log));
    box.replaceChildren(...out);
    heat(heatBox, [...days.values()], 'wait');
  }

  // ---- Machines: this Mac's limits, quotas, simulators and services, and the group --

  function machinesView() {
    const box = $('v-machines');
    const m = side.machines;
    if (!m) return box.replaceChildren(loading('Looking at the machines'));
    const others = (m.group?.machines || []).filter(x => x.name !== m.group.me);
    $('summary').textContent = `${m.name || 'This Mac'} runs at ${NAMES[m.pace || 'off']} speed${m.group ? `, in a group of ${others.length + 1} machines` : ', on its own'}. What dibs checks before it starts a job, and what keeps it going.`;
    const out = [];

    const mine = el('div', 'list');
    const gauge = (label, value, frac, bad, note) => {
      const r = el('div', 'lrow still gauge');
      const track = el('span', 'meter-track wide');
      const fill = el('i', bad ? 'bad' : '');
      fill.style.width = `${Math.max(2, Math.min(100, frac * 100))}%`;
      track.append(fill);
      r.append(el('span', 'g-label', label), track, el('span', `l-side${bad ? ' bad' : ''}`, value));
      if (note) r.title = note;
      return r;
    };
    const mm = m.machine || {};
    if (mm.memFree != null) mine.append(gauge('Memory', `${Math.round(mm.memFree)}% free`, 1 - mm.memFree / 100, mm.memFree < 15, 'Under 15% free, dibs holds new jobs'));
    if (mm.diskFree != null) mine.append(gauge('Disk', `${gb(mm.diskFree)} free`, Math.min(1, 5 * 1024 ** 3 / Math.max(1, mm.diskFree)), mm.diskFree < 5 * 1024 ** 3, 'Under 5 GB free, nothing new starts'));
    if (mm.load != null) mine.append(gauge('Load', `${mm.load.toFixed(1)} on ${mm.cores || m.cores || '?'} cores`, (mm.load) / (m.maxLoad || mm.cores || 1), m.maxLoad != null && mm.load > m.maxLoad, m.maxLoad != null ? `Past ${m.maxLoad}, normal and lower work waits` : ''));
    const facts = el('p', 'prose', `Before starting a job, dibs checks: ${m.limits || 'nothing yet'}.`);
    out.push(section('This Mac', `${NAMES[m.pace || 'off']} speed: ${m.cores} cores and ${m.budget} for jobs`, mine, facts));
    if (m.hold) out.push(el('p', 'hold', `Nothing new starts right now: ${m.hold}`));

    out.push(...pairMachines(m));

    if (m.group) {
      if (m.group.error) out.push(section('Other machines', m.group.coordinator, quiet("Can't reach the coordinator.", `${m.group.error}. This Mac keeps its own queue meanwhile.`)));
      else if (!others.length) out.push(section('Other machines', m.group.coordinator, quiet('No other machine has joined yet.', 'Pair one: on the coordinator, Pair a machine (or dibs pair --machine), then dibs join <code> on that machine.')));
      else {
        out.push(section('Other machines', `Coordinator ${m.group.coordinator}`, table([
          { label: 'Machine', get: x => { const f = el('span', 'who-cell'); f.append(el('span', `dot ${machineState(x).dot}`), x.name); return f; } },
          { label: 'State', get: x => machineState(x).text },
          { label: 'Load', num: true, get: x => (x.load != null ? x.load.toFixed(1) : '-') },
          { label: 'Memory free', num: true, get: x => (x.memFree != null ? `${Math.round(x.memFree)}%` : '-') },
          { label: 'Disk free', num: true, get: x => (x.diskFree != null ? gb(x.diskFree) : '-') },
          { label: 'Jobs', num: true, get: x => (x.board ? String((x.board.held || []).length + (x.board.waiting || []).length) : '-') },
        ], others.sort((a, b) => a.name.localeCompare(b.name)))));
      }
    } else {
      out.push(section('Other machines', null, quiet('This Mac works alone.', 'To share work with another machine: dibs service install serve here, then Pair a machine above.')));
    }

    if (m.quotas?.length) {
      out.push(section('Quotas', 'Rate limits shared by every script here', table([
        { label: 'Quota', get: x => x.name },
        { label: 'Left', num: true, get: x => (x.error ? '-' : `${Math.floor(x.left ?? 0)} of ${x.limit ?? '?'}`) },
        { label: 'Per', get: x => x.error || x.per || '-' },
      ], m.quotas)));
    }

    const pools = Object.entries(m.pool?.room || {});
    if (pools.length) {
      const list = el('div', 'list');
      for (const [res, r] of pools) {
        const row = el('div', 'lrow still');
        const main = el('span', 'l-main');
        main.append(el('b', null, res), ` ${r.inUse} in use, at most ${r.max} at once; memory fits ${r.fits} more now`);
        row.append(main, el('span', 'l-side', `${gb(r.per)} each`));
        list.append(row);
      }
      for (const d of m.pool.devices || []) {
        const row = el('div', 'lrow still');
        const main = el('span', 'l-main');
        main.append(el('span', 'mono', d.name), ` ${d.creating ? 'being made' : d.inUse ? `in use by ${d.who}` : d.lastUsed ? `idle, last used by ${d.lastWho}` : 'never used'}`);
        row.append(main, el('span', 'l-side', d.inUse && d.since ? `for ${inFor(data.now - d.since)}` : d.lastUsed ? ago(data.now - d.lastUsed) : ''));
        list.append(row);
      }
      out.push(section('Private simulators', 'sim-own: one each, booted for the job and shut down after', list));
    }

    const svc = el('div', 'list');
    for (const x of m.services || []) {
      const on = /^running/.test(x.state), off = /^not installed/.test(x.state);
      const row = el('div', 'lrow still');
      const main = el('span', 'l-main');
      main.append(el('span', `dot ${on ? 'busy' : off ? 'idle' : 'waiting'}`), ' ', el('b', null, x.name), ` ${x.what}`);
      row.append(main, el('span', 'l-side', x.state));
      svc.append(row);
    }
    out.push(section('Services', 'dibs service install <name> keeps one running', svc));
    box.replaceChildren(...out);
  }

  // Pair a machine: on the coordinator, a one-time code the new machine joins with in
  // one step (dibs pair --machine, then dibs join <code> there). Never through the relay.
  let machineCode = null, kickArmed = null;
  function pairMachines(m) {
    if (T.remote) return [];
    const p = side.pairs;
    if (!p) return [];
    if (p.none) {
      const where = m.group && !/^http:\/\/(127\.0\.0\.1|localhost)(:|$)/.test(m.group.coordinator) ? `the coordinator, ${m.group.coordinator}` : null;
      return [section('Pair a machine', null, quiet(where ? `Machines join on ${where}.` : 'This Mac runs no coordinator.',
        where ? 'Open its dibs page, or run dibs pair --machine there.' : 'To share work with other machines, start one here: dibs service install serve. Then pair each machine from this page.'))];
    }
    if (p.error) return [section('Pair a machine', null, quiet("Can't reach this Mac's coordinator.", `${p.error}. dibs service status serve says whether it's running.`))];
    const out = [];
    const form = el('form', 'hours');
    const name = el('input');
    name.placeholder = 'Its name (optional)';
    name.maxLength = 63;
    name.dataset.keep = 'machine-name';
    const l = el('label', null, 'Name');
    l.append(name);
    const go = el('button', 'btn primary', machineCode ? 'New code' : 'Pair a machine');
    go.type = 'submit';
    go.disabled = busy.has('pair-machine');
    form.append(l, go);
    form.addEventListener('submit', async e => {
      e.preventDefault();
      const r = await post('/api/machines/pair', { name: name.value.trim() || null }, 'pair-machine');
      if (r?.code) { machineCode = { ...r, at: Date.now() }; drawn = null; renderView(); }
    });
    const lead = el('p', 'prose', 'A one-time code. On the new machine, dibs join <code> finds this coordinator on the same network or through Tailscale and joins. Whoever joins can run commands on every machine in the group.');
    out.push(lead, form);
    if (machineCode && machineCode.exp > Date.now()) {
      const wrap = el('div', 'ticket-wrap code-wrap');
      const t = el('div', 'ticket code-ticket');
      const how = el('span', 'code-note');
      how.append(`On ${machineCode.name || 'the new machine'}: `, el('code', null, `dibs join ${machineCode.code}`), `, then `, el('code', null, 'dibs service install worker'),
        `. Good until ${clock(machineCode.exp)}.${machineCode.urls?.length ? '' : " This coordinator listens only on this Mac for now: bring Tailscale up here, or add --at <this Mac's address>."}`);
      t.append(el('span', 'code-big', machineCode.code), el('i', 'perf'), how);
      wrap.append(t);
      out.push(wrap);
    }
    const list = el('div', 'list');
    for (const c of p.codes) {
      const r = el('div', 'lrow still');
      const main = el('span', 'l-main');
      main.append(el('b', null, `Code ${c.id}`), el('span', 'l-sub', ` ${c.name ? `for ${c.name}, ` : ''}open until ${clock(c.exp)}`));
      const key = `void-${c.id}`;
      const x = button('btn small', 'Void', () => post('/api/machines/revoke', { code: c.id }, key));
      x.disabled = busy.has(key);
      r.append(main, x);
      list.append(r);
    }
    for (const x of p.machines) {
      const r = el('div', 'lrow still');
      const main = el('span', 'l-main');
      main.append(el('span', `dot ${x.online ? 'busy' : 'idle'}`), ' ', el('b', null, x.name),
        el('span', 'l-sub', ` ${x.paired ? `joined with a code ${ago(data.now - x.paired)}` : x.joined ? `joined ${ago(data.now - x.joined)}` : `invited ${ago(data.now - x.invited)}, hasn't joined`}${x.online ? ', taking jobs' : ''}`));
      const key = `kick-${x.name}`, armed = kickArmed === x.name;
      const k = button(`btn small ${armed ? 'primary' : 'danger'}`, armed ? 'Yes, remove it' : 'Remove', async () => {
        if (!armed) { kickArmed = x.name; return renderView(); }
        kickArmed = null;
        await post('/api/machines/revoke', { name: x.name }, key);
      });
      k.disabled = busy.has(key);
      r.append(main, k);
      list.append(r);
    }
    if (p.codes.length || p.machines.length) out.push(list);
    if (kickArmed) out.push(el('p', 'sheet-note', `Removing ${kickArmed} stops its token at once. Its running jobs end for their senders, and jobs it sent are stopped.`));
    return [section('Pair a machine', 'dibs pair --machine', ...out)];
  }

  // Another machine as a person would say it, with the dot it gets.
  function machineState(x) {
    const od = x.ondemand;
    if (od?.problem) return { dot: 'blocked', text: `On-demand VM dibs can't use: ${od.problem}` };
    if (od?.cantWake && od.state === 'asleep') return { dot: 'blocked', text: `Can't wake: ${od.cantWake.why}` };
    if (od && od.state !== 'running') return { dot: 'idle', text: `On-demand VM, ${od.state}${od.state === 'asleep' ? ': a job sent there wakes it' : ''}` };
    if (x.lost) return { dot: 'blocked', text: `Not reporting for ${inFor(x.age || 0)}` };
    if (!x.board) return { dot: 'idle', text: `Runs dibs ${x.version || 'of an older version'}, which doesn't share its queues` };
    const busy = (x.board.held || []).length;
    return { dot: busy ? 'running' : 'busy', text: busy ? `${busy} running` : 'Nothing running' };
  }

  // ---- Settings --------------------------------------------------------------

  function settings() {
    const box = $('v-settings');
    const s = side.settings;
    $('summary').textContent = 'The same settings the Mac app and the CLI change. Each change is logged as yours.';
    $('title').textContent = 'Settings';
    if (!s) { box.replaceChildren(loading('Loading settings')); return; }
    const out = [];
    const seg = el('div', 'paces');
    // The Mac app's names and words for each pace (Speed in app/Dibs/Models/Settings.swift).
    const KNOWN = { quiet: 'Keeps the fan quiet. Fewer jobs run at once, so lines move slower.', normal: 'A few jobs at once, and more when this Mac is sitting idle.', max: "Uses the whole Mac. Lines move fastest, and you'll hear the fan." };
    for (const p of ['quiet', 'normal', 'max', 'off']) {
      const k = s.pace.paces?.[p];
      const b = button('pace', '', () => post('/api/pace', { pace: p }, 'pace'));
      b.setAttribute('aria-pressed', String((s.pace.pace || 'off') === p));
      b.disabled = busy.has('pace');
      b.append(el('b', null, NAMES[p]), el('span', null, p === 'off' ? 'config.json decides, with no limit on load.' : KNOWN[p]));
      if (k) b.append(el('span', 'pace-k', `${k.cores} cores, ${k.budget} for jobs, new work waits past load ${k.maxLoad}`));
      seg.append(b);
    }
    out.push(section('Speed', s.pace.pinned?.length ? `config.json sets ${s.pace.pinned.join(' and ')}, which win over the speed` : 'How hard agents can work this Mac', seg));

    const hours = el('form', 'hours');
    const from = el('input'), to = el('input');
    for (const [i, v, label] of [[from, s.hours?.start, 'From'], [to, s.hours?.end, 'To']]) {
      i.type = 'time'; i.value = v || ''; i.required = true; i.dataset.keep = `hours-${label}`;
      const l = el('label', null, label);
      l.append(i);
      hours.append(l);
    }
    const set = el('button', 'btn primary', 'Set hours');
    set.type = 'submit';
    hours.append(set);
    if (s.hours) hours.append(button('btn', 'Clear', () => post('/api/hours', { hours: 'off' }, 'hours')));
    hours.addEventListener('submit', e => { e.preventDefault(); post('/api/hours', { hours: `${from.value}-${to.value}` }, 'hours'); });
    out.push(section('Working hours', s.hours ? `Now ${s.hours.start} to ${s.hours.end}` : "None set: agents' questions reach you at any hour", el('p', 'prose', 'Outside these hours, questions below urgent wait for the morning.'), hours));

    const hook = el('div', 'hookrow');
    hook.append(el('p', 'prose', s.hook.installed ? (s.hook.complete ? 'The Claude Code hook is set up: agents get your messages with their next tool call, and file leases are enforced.' : 'The hook is set up but missing some events. Update it to get all of them.') : 'The Claude Code hook isn\'t set up, so agents only see your messages when they run dibs say.'));
    const hb = button('btn', s.hook.installed ? 'Update hook' : 'Set up hook', () => post('/api/hook', {}, 'hook'));
    hb.disabled = busy.has('hook');
    hook.append(hb);
    // dibs guard status, the rest of it: how heavy commands are handled, the subagent cap, which events it hears.
    const g = s.hook, details = [];
    if (g.installed) {
      details.push(`Heavy commands an agent runs outside dibs: ${g.rewrite === 'bypass' ? 'run through dibs in bypassPermissions sessions, turned away in others' : `run through dibs in "${g.rewrite}" sessions, turned away in others`}.`);
      details.push(`Subagents: ${g.subagents ? `at most ${g.subagents.slots} at once across every session` : 'no limit (agents.slots in config.json sets one)'}.`);
      if (g.matchers?.length) details.push(`It hears ${[...new Set(g.matchers.map(m => m.event))].join(', ')}.`);
    }
    out.push(section('Claude Code hook', 'dibs guard install', hook, ...details.map(t => el('p', 'prose sub', t))));

    out.push(section('The dibs page', T.remote ? null : 'dibs pair', ...pairing()));
    out.push(section('Your dibs account', 'Sign in at app.dibs.cc/account and every browser you use opens this Mac, end to end encrypted. A new browser gets the account\'s key from here once you type the code it shows.', ...accounts()));
    box.replaceChildren(...out);
  }

  // dibs accounts, as the Mac app's Settings has them (app/Dibs/Views/AccountsCard.swift), same
  // words: browsers waiting for this Mac's account key, approved only by typing the code each
  // shows, never with one click. Only on the Mac's own page: the server refuses all of it
  // through the relay.
  let approving = null, approved = null, joinLink = null;
  const waitLeft = t => {
    const s = Math.round((t - Date.now()) / 1000);
    return s > 0 ? `Waiting ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')} more. If you didn't ask from it, refuse it.` : 'Ran out. That browser can ask again.';
  };
  setInterval(() => { for (const e of document.querySelectorAll('[data-deadline]')) e.textContent = waitLeft(Number(e.dataset.deadline)); }, 1000);
  const spaced = c => c.replace(/^(\d{3})(\d{3})$/, '$1 $2');
  function accounts() {
    if (T.remote) return [el('p', 'prose', 'Approving browsers for your dibs account only works on the Mac itself (the dibs app, or dibs web at http://127.0.0.1:7421), never from a paired browser.')];
    const a = side.accounts;
    if (!a) return [loading('Loading accounts')];
    const out = [];
    if (approved) {
      const done = el('div', 'hookrow');
      done.append(el('p', 'prose', `Now type this into ${approved.label}. The browser opens your account's key only with this code, so a key that didn't come from this Mac is never used.`));
      done.append(button('btn', 'Done', () => { approved = null; drawn = null; renderView(); }));
      const wrap = el('div', 'ticket-wrap code-wrap');
      const t = el('div', 'ticket code-ticket');
      t.append(el('span', 'code-big', spaced(approved.confirm)), el('i', 'perf'), el('span', 'code-note', `For ${approved.label}.`));
      wrap.append(t);
      out.push(done, wrap);
    }
    if (a.waiting.length) {
      const box = el('div', 'list wants');
      for (const w of a.waiting) {
        const r = el('div', 'lrow still');
        const main = el('span', 'l-main');
        const left = el('span', 'l-sub', waitLeft(w.expires));
        left.dataset.deadline = w.expires;
        main.append(el('b', null, `${w.label} wants your account's key`), el('br'), left);
        const key = `refuse-${w.id}`;
        const no = button('btn small', 'Refuse', () => post('/api/accounts/refuse', { id: w.id }, key));
        no.disabled = busy.has(key);
        const yes = button('btn small primary', 'Approve\u2026', () => { approving = w.id; drawn = null; renderView(); });
        r.append(main, no, yes);
        box.append(r);
        if (approving === w.id) box.append(approveForm(w));
      }
      out.push(box);
    }
    const list = el('div', 'list');
    for (const x of a.accounts) {
      const r = el('div', 'lrow still');
      const main = el('span', 'l-main');
      const at = new Date(x.joined);
      main.append(el('b', null, `dibs account ${x.id}`), el('span', 'l-sub', ` Joined ${clock(x.joined)}, ${at.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })}. Every browser signed in to it opens this Mac.`));
      const key = `leave-${x.id}`;
      const b = button('btn small', 'Remove this Mac', () => {
        if (confirm(`Take this Mac off dibs account ${x.id}? Its browsers no longer reach it, and it can't approve new ones.`)) post('/api/accounts/remove', { id: x.id }, key);
      });
      b.disabled = busy.has(key);
      r.append(main, b);
      list.append(r);
    }
    const join = el('div', 'lrow still');
    join.append(el('span', 'l-main', a.accounts.length ? 'Add this Mac to another dibs account.' : 'Add this Mac to your dibs account, so any browser you sign in with opens it.'));
    const jb = button(`btn small${a.accounts.length ? '' : ' primary'}`, 'Add this Mac', async () => {
      const r = await post('/api/accounts/join', {}, 'join-account');
      if (r?.link) { joinLink = { ...r, at: Date.now() }; window.open(r.link, '_blank', 'noreferrer'); toast('Opened dibs connect in your browser.'); drawn = null; renderView(); }
    });
    jb.disabled = busy.has('join-account');
    join.append(jb);
    list.append(join);
    out.push(list);
    if (joinLink && Date.now() - joinLink.at < 10 * 6e4) {
      const wrap = el('div', 'ticket-wrap code-wrap');
      const t = el('div', 'ticket code-ticket qr-ticket');
      const words = el('div', 'qr-text');
      words.append(el('span', 'code-note', 'Opened in your browser. Sign in to your dibs account there if it asks, and this Mac joins it.'),
        el('span', 'code-note', `Or scan it with a phone that's signed in. Good once, until ${clock(joinLink.at + 10 * 6e4)}.`));
      t.append(qrSvg(joinLink.qr), el('i', 'perf'), words);
      wrap.append(t);
      out.push(wrap);
    }
    return out;
  }
  function approveForm(w) {
    const f = el('form', 'hours approve');
    f.append(el('p', 'prose', 'Type the 6-digit code that browser shows. Only a browser showing this exact code gets your account\'s key.'));
    const code = el('input');
    code.inputMode = 'numeric';
    code.autocomplete = 'off';
    code.placeholder = '123 456';
    code.setAttribute('aria-label', 'The code the browser shows');
    code.dataset.keep = `approve-${w.id}`;
    const go = el('button', 'btn primary', 'Approve');
    go.type = 'submit';
    go.disabled = busy.has('approve');
    f.append(code, button('btn', 'Cancel', () => { approving = null; drawn = null; renderView(); }), go,
      el('p', 'prose sub', 'If you can\'t see that browser, or its code isn\'t there, don\'t approve: something between it and this Mac may be pretending.'));
    f.addEventListener('submit', async e => {
      e.preventDefault();
      if (code.value.replace(/\D/g, '').length !== 6) return toast('The code is the 6 digits the browser shows.', true);
      const r = await post('/api/accounts/approve', { code: code.value }, 'approve');
      if (r?.confirm) { approved = r; approving = null; drawn = null; renderView(); }
    });
    return f;
  }

  // Pairing, as the Mac app's pair sheet: a one-time code on a ticket, who's signed in,
  // and this browser itself. A paired browser can't pair others or see the list.
  let pairCode = null, remotePair = null;
  // A QR code from the server's grid, drawn as one path of dark squares.
  function qrSvg(grid) {
    const n = grid.length, q = 4, size = n + q * 2;
    let d = '';
    grid.forEach((row, y) => row.forEach((on, x) => { if (on) d += `M${x + q} ${y + q}h1v1h-1z`; }));
    const s = svg('svg', { viewBox: `0 0 ${size} ${size}`, class: 'qr', role: 'img', 'aria-label': 'QR code for the pairing link', 'shape-rendering': 'crispEdges' });
    s.append(svg('rect', { width: size, height: size, fill: '#fff' }), svg('path', { d, fill: '#111113' }));
    return s;
  }
  function pairing() {
    const out = [];
    if (!T.remote) {
      const row = el('div', 'hookrow');
      row.append(el('p', 'prose', 'A one-time code signs in a browser or Claude. It works once, for ten minutes.'));
      const b = button('btn primary', pairCode ? 'New code' : 'Pair a browser or Claude', async () => {
        const r = await post('/api/pair', {}, 'pair');
        if (r?.code) { pairCode = { code: r.code, at: Date.now() }; drawn = null; renderView(); }
      });
      b.disabled = busy.has('pair');
      row.append(b);
      out.push(row);
      // A phone, or a browser anywhere: dibs pair --remote's link, and its QR code to scan.
      const far = el('div', 'hookrow');
      far.append(el('p', 'prose', 'A phone or a browser away from this Mac pairs through the encrypted relay at app.dibs.cc. Scan the code or open the link there; it works once, for ten minutes. It can only look unless you let it act.'));
      const acts = el('div', 'btn-row');
      for (const [act, label] of [[false, 'Pair a phone to look'], [true, 'Pair a phone that can act']]) {
        const b2 = button(`btn${act ? '' : ' primary'}`, label, async () => {
          const r = await post('/api/pair/remote', { act }, 'pair-remote');
          if (r?.link) { remotePair = { ...r, at: Date.now() }; drawn = null; renderView(); }
        });
        b2.disabled = busy.has('pair-remote');
        acts.append(b2);
      }
      far.append(acts);
      out.push(far);
      if (remotePair && Date.now() - remotePair.at < 10 * 6e4) {
        const wrap = el('div', 'ticket-wrap code-wrap');
        const t = el('div', 'ticket code-ticket qr-ticket');
        const link = el('a', 'code-link', remotePair.link);
        link.href = remotePair.link;
        link.target = '_blank';
        link.rel = 'noreferrer';
        const words = el('div', 'qr-text');
        words.append(el('span', 'code-note', `${remotePair.act ? 'It can act: boost, pause, resume and stop jobs, cap agents, set the speed, cancel runs for later.' : 'It can only look.'} Good until ${clock(remotePair.at + 10 * 6e4)}.`), link);
        t.append(qrSvg(remotePair.qr), el('i', 'perf'), words);
        wrap.append(t);
        out.push(wrap);
      }
      if (pairCode && Date.now() - pairCode.at < 10 * 6e4) {
        const wrap = el('div', 'ticket-wrap code-wrap');
        const t = el('div', 'ticket code-ticket');
        t.append(el('span', 'code-big', pairCode.code), el('i', 'perf'), el('span', 'code-note', `Good until ${clock(pairCode.at + 10 * 6e4)}. Type it on the dibs page, or where Claude asks for it.`));
        wrap.append(t);
        out.push(wrap);
      }
      const list = side.paired || [];
      const box = el('div', 'list');
      for (const c of list) {
        const r = el('div', 'lrow still');
        const main = el('span', 'l-main');
        main.append(el('b', null, c.what), el('span', 'l-sub', ` ${c.when}`));
        const key = `revoke-${c.id}`;
        const x = button('btn small', 'Sign out', () => post('/api/pair/revoke', { id: c.id }, key));
        x.disabled = busy.has(key);
        r.append(main, x);
        box.append(r);
      }
      if (list.length) {
        const all = button('btn small quiet', 'Sign out all', () => post('/api/pair/revoke', { id: 'all' }, 'revoke-all').then(() => { token.set(null); signin(true); }));
        const h = el('div', 'sec-head sub');
        h.append(el('h3', null, 'Signed in'), all);
        out.push(h, box);
      }
    }
    const me = el('div', 'hookrow');
    me.append(el('p', 'prose', T.remote ? 'This browser is paired with your Mac through the relay. Forgetting it here deletes its key; pair again with dibs pair --remote.'
      : 'This page stays signed in for 30 days in this browser. dibs pair --list shows everything signed in; dibs pair --revoke all signs them all out.'));
    me.append(button('btn', T.remote ? 'Forget this browser' : 'Sign out here', async () => {
      if (T.remote) await T.forget();
      else {
        await T.fetchApi('POST', '/api/logout').catch(() => {});
        token.set(null);
      }
      signin(true);
    }));
    out.push(me);
    return out;
  }

  // ---- Keys and the command palette -----------------------------------------
  // 1 to 9 and 0 open the views in the rail's order, comma opens Settings, / or
  // Cmd-K (Ctrl-K) opens the palette: every view, agent, job and question, and
  // the speed, found by typing a few letters of it.
  const KEYS = Object.fromEntries([...VIEWS.slice(0, 10).map((v, i) => [String((i + 1) % 10), v]), [',', 'settings']]);
  const keyOf = v => Object.keys(KEYS).find(k => KEYS[k] === v);
  for (const b of document.querySelectorAll('.view')) { const k = keyOf(b.dataset.view); if (k) b.title = `${TITLES[b.dataset.view]} (${k})`; }

  function commands() {
    const out = VIEWS.map(v => ({ group: 'Go to', label: TITLES[v], hint: keyOf(v) || '', run: () => go(v) }));
    if (!data) return out;
    out.push({ group: 'Agent', label: 'Everyone', run: () => go(['now', 'stats', 'progress'].includes(view) ? view : 'now', '') });
    for (const a of data.agents) out.push({ group: 'Agent', label: a.who, hint: a.jobs.length ? `${a.jobs.length} job${a.jobs.length > 1 ? 's' : ''}` : '', run: () => go(['now', 'stats', 'progress'].includes(view) ? view : 'now', a.who) });
    for (const j of data.jobs) out.push({ group: 'Job', label: `#${j.id} ${j.who}: ${j.purpose || j.cmd || ''}`, hint: `${j.state} · ${j.res.map(resName).join(' + ')}`, words: j.res.join(' '), run: () => jobSheet(j.id) });
    for (const q of (side.questions?.questions || []).filter(x => x.state === 'open')) out.push({ group: 'Answer', label: `${q.agent || q.who}: ${q.text}`, run: () => go('questions') });
    for (const t of side.threads?.threads || data.agents.map(a => ({ to: a.who }))) out.push({ group: 'Message', label: t.to === side.threads?.desk ? 'dibs' : t.to, run: () => { thread = t.to; go('messages', ''); } });
    if (!T.remote) for (const p of ['quiet', 'normal', 'max', 'off']) out.push({ group: 'Speed', label: NAMES[p], hint: data.machine?.pace === p ? 'now' : '', run: () => post('/api/pace', { pace: p }, 'pace') });
    if (!T.remote) out.push({ group: 'Pair', label: 'Pair a browser or Claude', run: () => go('settings') }, { group: 'Pair', label: 'Pair a phone', run: () => go('settings') });
    return out;
  }

  let palItems = [], palAt = 0;
  function palette() {
    let d = $('palette');
    if (!d) {
      d = el('dialog', 'palette');
      d.id = 'palette';
      d.setAttribute('aria-label', 'Go to or do');
      const input = el('input', 'pal-input');
      input.placeholder = 'Go to a view, an agent, a job, a question';
      input.setAttribute('aria-label', 'Search');
      input.setAttribute('role', 'combobox');
      input.setAttribute('aria-controls', 'pal-list');
      const list = el('ul', 'pal-list');
      list.id = 'pal-list';
      list.setAttribute('role', 'listbox');
      d.append(input, list);
      input.addEventListener('input', () => { palAt = 0; drawPalette(); });
      input.addEventListener('keydown', e => {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); palAt = (palAt + (e.key === 'ArrowDown' ? 1 : -1) + palItems.length) % Math.max(1, palItems.length); drawPalette(); }
        if (e.key === 'Enter' && palItems[palAt]) { e.preventDefault(); const c = palItems[palAt]; d.close(); c.run(); }
      });
      d.addEventListener('click', e => { if (e.target === d) d.close(); });
      document.body.append(d);
    }
    d.querySelector('input').value = '';
    palAt = 0;
    drawPalette();
    d.showModal();
    d.querySelector('input').focus();
  }
  // Matches every word typed, anywhere in the group or the label; earlier matches first.
  function drawPalette() {
    const d = $('palette');
    const words = d.querySelector('input').value.toLowerCase().split(/\s+/).filter(Boolean);
    palItems = commands().map(c => ({ c, text: `${c.group} ${c.label} ${c.hint || ''} ${c.words || ''}`.toLowerCase() }))
      .filter(x => words.every(w => x.text.includes(w)))
      .sort((a, b) => (words.length ? a.text.indexOf(words[0]) - b.text.indexOf(words[0]) : 0))
      .slice(0, 40).map(x => x.c);
    const list = d.querySelector('ul');
    list.replaceChildren(...palItems.map((c, i) => {
      const li = el('li', `pal-item${i === palAt ? ' on' : ''}`);
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', String(i === palAt));
      li.append(el('span', 'pal-group', c.group), el('span', 'pal-label', c.label), el('span', 'pal-hint', c.hint || ''));
      li.addEventListener('click', () => { d.close(); c.run(); });
      li.addEventListener('pointermove', () => { if (palAt !== i) { palAt = i; drawPalette(); } });
      return li;
    }));
    if (!palItems.length) list.append(el('li', 'pal-none', 'Nothing matches.'));
    list.querySelector('.on')?.scrollIntoView({ block: 'nearest' });
  }

  document.addEventListener('keydown', e => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); return palette(); }
    const typing = e.target.closest?.('input, textarea, select, [contenteditable]');
    if (typing || e.metaKey || e.ctrlKey || e.altKey || $('signin').hidden === false || document.querySelector('dialog[open]')) return;
    if (e.key === '/') { e.preventDefault(); return palette(); }
    if (KEYS[e.key]) { e.preventDefault(); go(KEYS[e.key]); }
  });

  // ---- Wiring ----------------------------------------------------------------

  document.querySelector('.rail').addEventListener('click', e => {
    const v = e.target.closest('.view');
    if (v) return go(v.dataset.view);
    const row = e.target.closest('.rail-row');
    if (!row) return;
    const who = row.dataset.agent;
    if (view === 'messages') { thread = who || null; chosen = who; return go('messages', who); }
    go(['now', 'stats', 'progress'].includes(view) ? view : 'now', who);
  });

  $('signin-form').addEventListener('submit', async e => {
    e.preventDefault();
    const btn = e.target.querySelector('button');
    $('signin-error').textContent = '';
    btn.disabled = true;
    btn.textContent = 'Checking';
    try {
      const r = await T.fetchApi('POST', '/api/login', { code: $('code').value });
      if (r.status !== 200) throw new Error(r.json?.error || 'That did not work.');
      token.set(r.json.token);
      $('code').value = '';
      await load();
    } catch (x) {
      $('signin-error').textContent = x.message;
      $('code').select();
    }
    btn.disabled = false;
    btn.textContent = 'Sign in';
  });

  let resized = 0, lastW = innerWidth;
  addEventListener('resize', () => {
    if (innerWidth === lastW) return;
    lastW = innerWidth;
    cancelAnimationFrame(resized);
    resized = requestAnimationFrame(() => data && render());
  });
  addEventListener('hashchange', () => { const [v, who] = parseHash(); if (v !== view || who !== chosen) go(v, who); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) load(); });
  // A view's data comes in while the pointer is still on its way to the click.
  for (const ev of ['pointerenter', 'focusin']) document.querySelector('.views').addEventListener(ev, e => prefetch(e.target.closest?.('.view')?.dataset.view), true);
  load();
})();
