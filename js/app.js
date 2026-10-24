(function () {
  'use strict';

  const $ = (sel, el = document) => el.querySelector(sel);
  const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
  const esc = Zhuyin.esc;
  const app = $('#app');

  let S = Store.load();
  let cleanup = null; // 離開畫面時要停止的東西（錄音、播放）
  let parentUntil = 0; // 家長驗證後 10 分鐘內免再驗證

  const save = () => Store.save(S);
  const rand = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
  const shuffle = (arr) => { const a = [...arr]; for (let i = a.length - 1; i > 0; i--) { const j = rand(0, i); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  const WEEK = '日一二三四五六';
  const fmtDay = (key) => { const [y, m, d] = key.split('-').map(Number); return `${m}/${d}（${WEEK[new Date(y, m - 1, d).getDay()]}）`; };

  // ---------------- 小工具：提示、彈窗、音效、語音 ----------------

  let toastTimer = null;
  function toast(msg) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
  }

  function openModal(html, opts = {}) {
    closeModal();
    const root = $('#modal-root');
    root.innerHTML = `<div class="backdrop"><div class="modal ${opts.cls || ''}">${opts.closable === false ? '' : '<button class="modal-x" data-close aria-label="關閉">✕</button>'}${html}</div></div>`;
    const m = $('.modal', root);
    root.onclick = (e) => {
      if (e.target.closest('[data-close]') || (opts.closable !== false && e.target.classList.contains('backdrop'))) {
        closeModal();
        if (opts.onClose) opts.onClose();
      }
    };
    return m;
  }

  function closeModal() {
    const root = $('#modal-root');
    root.innerHTML = '';
    root.onclick = null;
  }

  // iPad Safari：用過麥克風後，音訊會卡在「錄音模式」導致整台沒聲音。
  // 錄音前切到 play-and-record、結束後切回 playback，並關掉音效用的 AudioContext 再重建。
  const audioSession = (type) => {
    try { if (navigator.audioSession) navigator.audioSession.type = type; } catch (e) { /* 舊版 Safari 沒有這個 API */ }
  };

  let actx = null;
  function closeSfx() {
    if (actx) { actx.close().catch(() => {}); actx = null; }
  }
  function beep(notes) {
    if (Recorder.stream) return; // 錄音中不出音效
    try {
      audioSession('playback');
      actx = actx || new (window.AudioContext || window.webkitAudioContext)();
      if (actx.state === 'suspended') actx.resume();
      let t = actx.currentTime;
      for (const [freq, dur] of notes) {
        const o = actx.createOscillator();
        const g = actx.createGain();
        o.type = 'triangle';
        o.frequency.value = freq;
        g.gain.setValueAtTime(0.18, t);
        g.gain.exponentialRampToValueAtTime(0.001, t + dur);
        o.connect(g).connect(actx.destination);
        o.start(t);
        o.stop(t + dur);
        t += dur * 0.8;
      }
    } catch (e) { /* 沒有音效也沒關係 */ }
  }
  const sfx = {
    good: () => beep([[660, 0.12], [880, 0.12], [1320, 0.25]]),
    bad: () => beep([[300, 0.18], [220, 0.25]]),
    win: () => beep([[523, 0.12], [659, 0.12], [784, 0.12], [1047, 0.4]]),
    tick: () => beep([[1200, 0.03]]),
  };

  function speak(text) {
    if (!('speechSynthesis' in window)) return toast('這台裝置不支援語音');
    audioSession('playback');
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'zh-TW';
    const voices = speechSynthesis.getVoices();
    const v = voices.find((x) => x.lang === 'zh-TW') || voices.find((x) => /zh[-_]TW/i.test(x.lang)) || voices.find((x) => /^zh/i.test(x.lang));
    if (v) u.voice = v;
    u.rate = S.settings.speechRate;
    speechSynthesis.speak(u);
  }
  if ('speechSynthesis' in window) speechSynthesis.getVoices();

  function confetti() {
    const box = document.createElement('div');
    box.className = 'confetti';
    const icons = ['🎉', '⭐', '🌟', '🎈', '✨', '💖'];
    for (let i = 0; i < 36; i++) {
      const s = document.createElement('span');
      s.textContent = icons[i % icons.length];
      s.style.left = rand(0, 100) + 'vw';
      s.style.animationDelay = (Math.random() * 0.6) + 's';
      s.style.fontSize = rand(24, 48) + 'px';
      box.appendChild(s);
    }
    document.body.appendChild(box);
    setTimeout(() => box.remove(), 3500);
  }

  // ---------------- 題庫與每日任務 ----------------

  const allStories = () => [...window.BUILTIN_STORIES, ...S.custom];
  const storyById = (id) => allStories().find((s) => s.id === id);
  const readCount = (id) => S.readCount[id] || 0;
  const hanCount = (story) => story.lines.reduce((n, l) => n + [...l.t].filter(Zhuyin.isHan).length, 0);

  // ---------------- 錄音清單與播放 ----------------

  // 所有有錄音的朗讀紀錄（由舊到新）：{ date, storyId, recId, sec, at }
  function allRecs() {
    const out = [];
    for (const date of Object.keys(S.days).sort()) {
      const d = S.days[date];
      for (const [storyId, r] of Object.entries(d.done)) {
        if (r.recId) out.push({ date, storyId, recId: r.recId, sec: r.sec, at: r.at });
      }
    }
    return out.sort((a, b) => a.at - b.at);
  }

  const daysAgo = (date) => Math.round((new Date(Store.today()) - new Date(date)) / 86400000);

  // 成長對照：最近一次錄音已經超過 compareDays 天的文章，回傳「第一次」的錄音
  function oldRecFor(storyId, recs) {
    const days = S.settings.compareDays;
    const list = recs.filter((r) => r.storyId === storyId);
    if (!days || !list.length || daysAgo(list[list.length - 1].date) < days) return null;
    return list[0];
  }

  const Player = {
    audio: null,
    url: null,
    play(blob) {
      this.stop();
      audioSession('playback');
      this.url = URL.createObjectURL(blob);
      this.audio = new Audio(this.url);
      this.audio.play().catch(() => toast('這段錄音無法播放'));
    },
    async playRec(recId) {
      const rec = await Store.audio.get(recId).catch(() => null);
      if (!rec) return toast('找不到這段錄音（可能已被刪除）');
      this.play(rec.blob);
    },
    stop() {
      if (this.audio) this.audio.pause();
      if (this.url) URL.revokeObjectURL(this.url);
      this.audio = null;
      this.url = null;
    },
  };

  const ym = (date) => date.slice(0, 7);
  // 上個月以前、有錄音但還沒匯出紀念冊的月份
  const unexportedMonths = () =>
    [...new Set(allRecs().map((r) => ym(r.date)))].filter((m) => m < ym(Store.today()) && !S.exported[m]);

  // 今天的任務：先排新文章（家長自訂的優先），保留一篇讀過最少次的當複習（優先挑可以做成長對照的）
  function ensurePlan() {
    const key = Store.today();
    const goal = S.settings.dailyGoal;
    let d = S.days[key];
    if (!d) d = S.days[key] = { goal, plan: [], review: [], done: {}, spun: null };
    const exists = new Set(allStories().map((s) => s.id));
    d.plan = d.plan.filter((id) => exists.has(id) || d.done[id]);
    if (!d.spun && d.goal !== goal) {
      d.goal = goal;
      while (d.plan.length > goal) {
        const idx = d.plan.map((id) => !d.done[id]).lastIndexOf(true);
        if (idx < 0) break;
        d.plan.splice(idx, 1);
      }
    }
    if (d.plan.length < d.goal) {
      const inPlan = new Set(d.plan);
      const pool = allStories().filter((s) => !inPlan.has(s.id));
      const unread = [...pool.filter((s) => s.custom && !readCount(s.id)), ...pool.filter((s) => !s.custom && !readCount(s.id))];
      const read = shuffle(pool.filter((s) => readCount(s.id))).sort((a, b) => readCount(a.id) - readCount(b.id));
      const picks = [];
      const wantReview = read.length && !d.review.length ? 1 : 0;
      while (picks.length < d.goal - d.plan.length - wantReview && unread.length) picks.push(unread.shift());
      if (wantReview) {
        const recs = allRecs();
        const old = read.map((s) => ({ s, rec: oldRecFor(s.id, recs) })).find((x) => x.rec);
        const r = old ? old.s : read[0];
        read.splice(read.indexOf(r), 1);
        picks.push(r);
        d.review.push(r.id);
        if (old) d.compare = Object.assign(d.compare || {}, { [r.id]: old.rec });
      }
      while (picks.length < d.goal - d.plan.length && (unread.length || read.length)) picks.push(unread.shift() || read.shift());
      d.plan.push(...picks.map((s) => s.id));
    }
    save();
    return d;
  }

  const doneCount = (d) => d.plan.filter((id) => d.done[id]).length;
  const dayComplete = (d) => d && d.plan.length > 0 && doneCount(d) >= d.goal;

  function streak() {
    let n = 0;
    const cur = new Date();
    if (!dayComplete(S.days[Store.today(cur)])) cur.setDate(cur.getDate() - 1);
    while (dayComplete(S.days[Store.today(cur)])) { n++; cur.setDate(cur.getDate() - 1); }
    return n;
  }

  // ---------------- 路由 ----------------

  function go(path) { location.hash = '#/' + path; }

  function route() {
    if (cleanup) { cleanup(); cleanup = null; }
    Player.stop();
    closeModal();
    window.scrollTo(0, 0);
    const [name, ...args] = location.hash.replace(/^#\/?/, '').split('/');
    switch (name) {
      case 'read': return viewRead(args[0], args[1] === 'task');
      case 'library': return viewLibrary();
      case 'words': return viewWords();
      case 'backpack': return viewBackpack();
      case 'calendar': return viewCalendar(args[0]);
      case 'wheel': return viewWheel();
      case 'parent': return requireParent(() => viewParent(args[0] || 'settings'), () => go('home'));
      default: return viewHome();
    }
  }

  // 共用點擊：data-go="路徑" 直接換頁
  document.addEventListener('click', (e) => {
    const t = e.target.closest('[data-go]');
    if (t && !t.disabled) go(t.dataset.go);
  });

  const topbar = (title, right = '') =>
    `<header class="top"><button class="icon" data-go="home" aria-label="回首頁">🏠</button><h2>${title}</h2><div class="top-right">${right}</div></header>`;

  // ---------------- 首頁 ----------------

  function viewHome() {
    const d = ensurePlan();
    const n = doneCount(d);
    const complete = n >= d.goal;
    const spin = d.spun && S.spins.find((s) => s.id === d.spun);
    let wheelBtn;
    if (spin) wheelBtn = `<button class="btn wheel-btn done" data-go="wheel">今天抽到 ${spin.emoji} ${esc(spin.name)}</button>`;
    else if (complete) wheelBtn = `<button class="btn wheel-btn ready" data-go="wheel">🎡 可以轉輪盤了！</button>`;
    else wheelBtn = `<button class="btn wheel-btn locked" data-go="wheel">🔒 再讀 ${d.goal - n} 篇就能轉輪盤</button>`;

    const stars = Array.from({ length: d.goal }, (_, i) => `<span class="star ${i < n ? 'on' : ''}">${i < n ? '⭐' : '☆'}</span>`).join('');
    const tasks = d.plan.map((id, i) => {
      const s = storyById(id);
      if (!s) return '';
      const done = d.done[id];
      const tag = d.review.includes(id) ? '<span class="tag review">複習</span>' : s.custom ? '<span class="tag custom">安親班</span>' : '';
      return `<button class="task ${done ? 'done' : ''}" data-go="read/${id}/task">
        <span class="num">${done ? '✅' : i + 1}</span>
        <span class="task-title mode-both">${Zhuyin.segHTML(s.title)}</span>${tag}
        <span class="go">${done ? '讀完了' : '開始讀 ▶'}</span>
      </button>`;
    }).join('');
    const st = streak();

    app.innerHTML = `
      <header class="top home-top">
        <h1>📖 注音小書蟲</h1>
        <div class="top-right">${st ? `<span class="streak">🔥 連續 ${st} 天</span>` : ''}<button class="icon badge-wrap" data-go="parent" aria-label="爸媽專區">⚙️${unexportedMonths().length ? '<span class="badge"></span>' : ''}</button></div>
      </header>
      <section class="card hero">
        <div class="hero-row"><div class="hero-title">今天的任務</div><div class="count">${n} / ${d.goal}</div></div>
        <div class="progress"><div class="bar" style="width:${Math.min(100, (n / d.goal) * 100)}%"></div></div>
        <div class="stars">${stars}</div>
        ${wheelBtn}
      </section>
      <section class="tasks">${tasks}</section>
      <nav class="dock">
        <button data-go="library">📚<span>書櫃</span></button>
        <button data-go="words">📒<span>生字本</span></button>
        <button data-go="backpack">🎒<span>我的獎品</span></button>
        <button data-go="calendar">📅<span>月曆</span></button>
      </nav>`;
  }

  // ---------------- 閱讀 ----------------

  const Recorder = {
    mr: null, stream: null, chunks: [], started: 0,
    supported: () => !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder),
    async begin() {
      closeSfx();
      if ('speechSynthesis' in window) speechSynthesis.cancel();
      Player.stop();
      audioSession('play-and-record');
      try {
        this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch (e) {
        audioSession('playback');
        throw e;
      }
      const type = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm'].find((t) => MediaRecorder.isTypeSupported(t));
      this.mr = new MediaRecorder(this.stream, type ? { mimeType: type } : undefined);
      this.chunks = [];
      this.mr.ondataavailable = (e) => { if (e.data.size) this.chunks.push(e.data); };
      this.mr.start();
      this.started = Date.now();
    },
    end() {
      return new Promise((resolve) => {
        if (!this.mr || this.mr.state === 'inactive') return resolve(null);
        this.mr.onstop = () => {
          const blob = new Blob(this.chunks, { type: this.mr.mimeType || 'audio/mp4' });
          this.release();
          resolve(blob);
        };
        this.mr.stop();
      });
    },
    release() {
      if (this.mr && this.mr.state !== 'inactive') {
        this.mr.onstop = null;
        this.mr.stop();
      }
      if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
      audioSession('playback');
    },
  };

  function storyTextHTML(story, mode) {
    let offset = 0;
    const lines = story.lines.map((l) => {
      const h = `<div class="line">${Zhuyin.segHTML(l, offset)}</div>`;
      offset += [...l.t].length;
      return h;
    }).join('');
    return `<div class="text mode-${mode} ${S.settings.vertical ? 'vertical' : ''}" style="font-size:${S.settings.fontSize}px">${lines}</div>`;
  }

  function viewRead(id, isTask) {
    const story = storyById(id);
    if (!story) return go('home');
    const flat = story.lines.flatMap((l) => { const z = l.z || Zhuyin.auto(l.t); return [...l.t].map((ch, k) => ({ ch, zy: z[k] })); });
    const minSec = Math.max(3, Math.round(hanCount(story) * S.settings.minSecPerChar));
    const already = isTask && ensurePlan().done[id];
    const rec = { state: 'idle', blob: null, sec: 0, timer: null, noMic: false };

    const modes = [['zhuyin', 'ㄅㄆㄇ'], ['both', '字+ㄅㄆㄇ'], ['hanzi', '國字']];
    function renderPage() {
      const mode = S.settings.mode;
      app.innerHTML = `
        ${topbar(`<span class="mode-both">${Zhuyin.segHTML(story.title)}</span>`, `
          <div class="seg">${modes.map(([m, label]) => `<button data-mode="${m}" class="${mode === m ? 'on' : ''}">${label}</button>`).join('')}</div>
          <button class="icon small" data-act="vert" aria-label="直書橫書">${S.settings.vertical ? '橫' : '直'}</button>
          <button class="icon small" data-act="smaller" aria-label="字變小">A−</button>
          <button class="icon small" data-act="bigger" aria-label="字變大">A+</button>`)}
        <main class="paper">${storyTextHTML(story, mode)}</main>
        ${mode === 'hanzi' ? '<p class="hint">不會念的字，點一下就會出現注音</p>' : ''}
        <footer class="recbar" id="recbar"></footer>`;
      renderBar();
    }

    function renderBar() {
      const bar = $('#recbar');
      if (!bar) return;
      if (already) {
        bar.innerHTML = `<div class="rec-msg">✅ 這篇今天已經讀完囉！</div><button class="btn" data-go="home">回首頁</button>`;
        return;
      }
      const useMic = S.settings.requireRecording && !rec.noMic;
      if (rec.state === 'idle') {
        bar.innerHTML = `<button class="btn big rec" data-act="start">${useMic ? '🎤 開始朗讀' : '▶ 開始朗讀'}</button>
          <div class="rec-msg">${useMic ? '按下按鈕，大聲把整篇念出來！' : '念完再按「念完了」'}</div>`;
      } else if (rec.state === 'recording') {
        const s = Math.floor((Date.now() - rec.started) / 1000);
        bar.innerHTML = `<span class="rec-dot ${useMic ? '' : 'timer'}"></span><span class="rec-time">${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}</span>
          <button class="btn big stop" data-act="stop">✋ 念完了</button>`;
      } else if (rec.state === 'recorded') {
        bar.innerHTML = `${rec.blob ? '<button class="btn" data-act="play">▶ 聽聽看</button>' : ''}
          <button class="btn ghost" data-act="redo">🔁 重念</button>
          <button class="btn big go" data-act="next">✅ 下一步：回答問題</button>`;
      }
    }

    async function start() {
      rec.blob = null;
      if (S.settings.requireRecording && !rec.noMic) {
        try {
          if (!Recorder.supported()) throw new Error('unsupported');
          await Recorder.begin();
        } catch (e) {
          rec.noMic = true;
          toast('沒有麥克風權限，這次改用計時');
        }
      }
      rec.started = Date.now();
      rec.state = 'recording';
      rec.timer = setInterval(renderBar, 500);
      renderBar();
    }

    async function stop() {
      clearInterval(rec.timer);
      rec.sec = (Date.now() - rec.started) / 1000;
      const blob = rec.noMic || !S.settings.requireRecording ? null : await Recorder.end();
      if (rec.sec < minSec) {
        rec.state = 'idle';
        sfx.bad();
        toast(`好像念太快了，慢慢念、每個字都念清楚喔！（至少 ${minSec} 秒）`);
      } else {
        rec.blob = blob;
        rec.state = 'recorded';
      }
      renderBar();
    }

    function play() {
      if (rec.blob) Player.play(rec.blob);
    }

    app.onclick = (e) => {
      const m = e.target.closest('[data-mode]');
      if (m) { S.settings.mode = m.dataset.mode; save(); return renderPage(); }
      const c = e.target.closest('.text .c:not(.p)');
      if (c) return charPopup(flat[+c.dataset.i], c);
      const a = e.target.closest('[data-act]');
      if (!a) return;
      const act = a.dataset.act;
      if (act === 'vert') { S.settings.vertical = !S.settings.vertical; save(); renderPage(); }
      if (act === 'smaller' || act === 'bigger') {
        S.settings.fontSize = Math.max(28, Math.min(80, S.settings.fontSize + (act === 'bigger' ? 6 : -6)));
        save();
        $('.text').style.fontSize = S.settings.fontSize + 'px';
      }
      if (act === 'start') start();
      if (act === 'stop') stop();
      if (act === 'play') play();
      if (act === 'redo') { rec.state = 'idle'; rec.blob = null; renderBar(); }
      if (act === 'next') openQuiz(story, () => finish());
    };

    async function finish() {
      let recId = null;
      if (isTask && rec.blob) {
        recId = 'r' + Date.now();
        try {
          // 連同文章內容一起存，之後匯出紀念冊時就算文章被刪了也看得到
          await Store.audio.put(recId, {
            blob: rec.blob, storyId: id, date: Store.today(), sec: rec.sec,
            title: story.title.t, lines: story.lines.map((l) => ({ t: l.t, z: l.z || Zhuyin.auto(l.t) })),
          });
          Store.persist().catch(() => {});
        } catch (e) { recId = null; }
      }
      S.readCount[id] = readCount(id) + 1;
      let complete = false;
      let n = 0;
      let old = null;
      if (isTask) {
        const d = ensurePlan();
        if (d.plan.includes(id) && !d.done[id]) d.done[id] = { at: Date.now(), recId, sec: Math.round(rec.sec) };
        n = doneCount(d);
        complete = n >= d.goal && !d.spun;
        old = d.compare && d.compare[id];
        if (old && !(await Store.audio.get(old.recId).catch(() => null))) old = null;
      }
      save();
      sfx.win();
      confetti();
      const [, om, od] = old ? old.date.split('-').map(Number) : [];
      openModal(`
        <div class="celebrate">
          <div class="big-emoji">${complete ? '🏆' : '🎉'}</div>
          <h2>${complete ? '今天的任務全部完成！' : '太棒了！讀完一篇！'}</h2>
          ${isTask ? `<p>今天已經讀了 ${n} 篇</p>` : '<p>多讀一篇，越來越厲害！</p>'}
          ${old && rec.blob ? `<div class="compare">
            <h3>🕰️ 成長對照</h3>
            <p>你在 ${om} 月 ${od} 日也念過這篇！聽聽看有什麼不一樣？</p>
            <div class="row"><button class="btn" data-play-old>▶ ${om}/${od} 的你</button><button class="btn" data-play-new>▶ 今天的你</button></div>
          </div>` : ''}
          <div class="row">
            ${complete ? '<button class="btn big go" data-close-go="wheel">🎡 去轉輪盤</button>' : '<button class="btn big" data-close-go="home">回首頁</button>'}
          </div>
        </div>`, { closable: false });
      $('#modal-root').onclick = (e) => {
        if (e.target.closest('[data-play-old]')) return Player.playRec(old.recId);
        if (e.target.closest('[data-play-new]')) return Player.play(rec.blob);
        const b = e.target.closest('[data-close-go]');
        if (b) { closeModal(); go(b.dataset.closeGo); }
      };
    }

    cleanup = () => {
      clearInterval(rec.timer);
      Recorder.release();
      app.onclick = null;
      if ('speechSynthesis' in window) speechSynthesis.cancel();
    };
    renderPage();
  }

  function charPopup(item, el) {
    if (S.settings.mode === 'hanzi') el.classList.add('reveal');
    speak(item.ch);
    const inBook = S.words.some((w) => w.ch === item.ch && w.zy === item.zy);
    const m = openModal(`
      <div class="char-pop">
        <div class="char-big mode-both">${Zhuyin.charHTML(item.ch, item.zy)}</div>
        <div class="row">
          <button class="btn" data-act="say">🔊 再聽一次</button>
          <button class="btn ${inBook ? 'ghost' : 'go'}" data-act="add" ${inBook ? 'disabled' : ''}>${inBook ? '已在生字本' : '⭐ 加入生字本'}</button>
        </div>
      </div>`, { cls: 'small' });
    m.addEventListener('click', (e) => {
      const a = e.target.closest('[data-act]');
      if (!a) return;
      if (a.dataset.act === 'say') speak(item.ch);
      if (a.dataset.act === 'add') {
        S.words.push({ ch: item.ch, zy: item.zy, at: Date.now() });
        save();
        sfx.good();
        toast('已加入生字本 ⭐');
        closeModal();
      }
    });
  }

  function openQuiz(story, onPass) {
    const q = story.quiz;
    if (!q || !q.options || !q.options.length) return onPass();
    const order = shuffle(q.options.map((_, i) => i));
    const m = openModal(`
      <div class="quiz">
        <div class="quiz-q"><span class="mode-both">${Zhuyin.segHTML(q.q)}</span><button class="icon" data-act="say" aria-label="念題目">🔊</button></div>
        <div class="opts">${order.map((i) => {
          const o = q.options[i];
          return `<button class="opt" data-i="${i}"><span class="emo">${esc(o.e || '')}</span><span class="mode-both">${Zhuyin.segHTML(o)}</span></button>`;
        }).join('')}</div>
      </div>`);
    speak(q.q.t);
    m.addEventListener('click', (e) => {
      if (e.target.closest('[data-act="say"]')) return speak(q.q.t);
      const b = e.target.closest('.opt');
      if (!b || b.disabled) return;
      if (+b.dataset.i === (q.answer || 0)) {
        b.classList.add('right');
        sfx.good();
        $$('.opt', m).forEach((x) => { x.disabled = true; });
        setTimeout(() => { closeModal(); onPass(); }, 700);
      } else {
        b.classList.add('wrong');
        b.disabled = true;
        sfx.bad();
        toast('再想想看～也可以回去再讀一次喔');
      }
    });
  }

  // ---------------- 書櫃、生字本、獎品、月曆 ----------------

  function viewLibrary() {
    const cards = allStories().map((s) => `
      <button class="book" data-go="read/${s.id}">
        <span class="book-title mode-both">${Zhuyin.segHTML(s.title)}</span>
        <span class="book-meta">${s.custom ? '<span class="tag custom">安親班</span>' : ''}${readCount(s.id) ? `讀過 ${readCount(s.id)} 次` : '還沒讀過'}</span>
      </button>`).join('');
    app.innerHTML = `${topbar('📚 書櫃')}<p class="hint">書櫃裡的文章可以自由讀，不會算進今天的任務喔。</p><section class="books">${cards}</section>`;
  }

  function viewWords() {
    const list = S.words.map((w, i) => `
      <div class="word"><button class="word-char mode-both" data-say="${i}">${Zhuyin.charHTML(w.ch, w.zy)}</button><button class="word-x" data-del="${i}" aria-label="移除">✕</button></div>`).join('');
    app.innerHTML = `${topbar('📒 生字本')}
      ${S.words.length ? '<p class="hint">點一下聽聽看，學會了就按 ✕ 拿掉。</p>' : '<p class="empty">還沒有生字。讀文章時點一下不會的字，就可以加進來喔！</p>'}
      <section class="words">${list}</section>`;
    app.onclick = (e) => {
      const s = e.target.closest('[data-say]');
      if (s) return speak(S.words[+s.dataset.say].ch);
      const d = e.target.closest('[data-del]');
      if (d) { S.words.splice(+d.dataset.del, 1); save(); viewWords(); }
    };
    cleanup = () => { app.onclick = null; };
  }

  function viewBackpack() {
    const list = [...S.spins].reverse().map((s) => `
      <div class="coupon ${s.redeemed ? 'used' : ''} ${s.big ? 'big' : ''}">
        <div class="coupon-emo">${s.emoji}</div>
        <div class="coupon-body"><div class="coupon-name">${esc(s.name)}</div><div class="coupon-date">${fmtDay(s.date)} 抽到</div></div>
        ${s.redeemed ? '<div class="stamp">已兌換</div>' : `<button class="btn" data-redeem="${s.id}">請爸媽兌換</button>`}
      </div>`).join('');
    app.innerHTML = `${topbar('🎒 我的獎品')}${S.spins.length ? '' : '<p class="empty">還沒有獎品，讀完今天的任務就可以轉輪盤！</p>'}<section class="coupons">${list}</section>`;
    app.onclick = (e) => {
      const b = e.target.closest('[data-redeem]');
      if (!b) return;
      requireParent(() => {
        const s = S.spins.find((x) => x.id === b.dataset.redeem);
        s.redeemed = true;
        s.redeemedAt = Date.now();
        save();
        sfx.good();
        viewBackpack();
      });
    };
    cleanup = () => { app.onclick = null; };
  }

  function viewCalendar(ym) {
    const now = new Date();
    const [y, m] = ym ? ym.split('-').map(Number) : [now.getFullYear(), now.getMonth() + 1];
    const first = new Date(y, m - 1, 1);
    const days = new Date(y, m, 0).getDate();
    const prev = new Date(y, m - 2, 1);
    const next = new Date(y, m, 1);
    const ymKey = (d) => `${d.getFullYear()}-${d.getMonth() + 1}`;
    let cells = '<div class="dow">日</div><div class="dow">一</div><div class="dow">二</div><div class="dow">三</div><div class="dow">四</div><div class="dow">五</div><div class="dow">六</div>';
    cells += '<div></div>'.repeat(first.getDay());
    let total = 0;
    for (let day = 1; day <= days; day++) {
      const key = Store.today(new Date(y, m - 1, day));
      const d = S.days[key];
      const spin = d && d.spun && S.spins.find((s) => s.id === d.spun);
      const full = dayComplete(d);
      if (full) total++;
      const n = d ? doneCount(d) : 0;
      cells += `<div class="day ${full ? 'full' : ''} ${key === Store.today() ? 'today' : ''}">
        <span class="dnum">${day}</span>${full ? '<span class="stamp-star">⭐</span>' : n ? `<span class="part">${n}篇</span>` : ''}${spin ? `<span class="dprize">${spin.emoji}</span>` : ''}</div>`;
    }
    app.innerHTML = `${topbar('📅 月曆')}
      <div class="cal-head"><button class="icon" data-go="calendar/${ymKey(prev)}">◀</button><h3>${y} 年 ${m} 月</h3><button class="icon" data-go="calendar/${ymKey(next)}">▶</button></div>
      <p class="hint">這個月完成了 ${total} 天 ⭐${streak() ? `　🔥 已經連續 ${streak()} 天` : ''}</p>
      <section class="cal">${cells}</section>`;
  }

  // ---------------- 輪盤 ----------------

  const COLORS = ['#ffb4a2', '#ffd6a5', '#fdffb6', '#caffbf', '#9bf6ff', '#a0c4ff', '#bdb2ff', '#ffc6ff'];

  function wheelSVG(prizes) {
    const n = prizes.length;
    const seg = 360 / n;
    const r = 100;
    const pt = (deg) => { const a = (deg - 90) * Math.PI / 180; return [r * Math.cos(a), r * Math.sin(a)]; };
    const slices = prizes.map((p, i) => {
      const [x0, y0] = pt(i * seg);
      const [x1, y1] = pt((i + 1) * seg);
      const color = p.big ? '#ffd700' : COLORS[i % COLORS.length];
      const path = n === 1 ? `<circle r="${r}" fill="${color}"/>` : `<path d="M0 0 L${x0.toFixed(2)} ${y0.toFixed(2)} A${r} ${r} 0 ${seg > 180 ? 1 : 0} 1 ${x1.toFixed(2)} ${y1.toFixed(2)} Z" fill="${color}" stroke="#fff" stroke-width="1.5"/>`;
      const name = [...p.name].slice(0, 10).join('');
      const labelSize = Math.min(n > 8 ? 6 : 7.5, 52 / Math.max(1, [...name].length));
      return `${path}<g transform="rotate(${i * seg + seg / 2})">
        <text y="-72" text-anchor="middle" dominant-baseline="middle" font-size="${n > 8 ? 14 : 18}">${esc(p.emoji)}</text>
        <text y="-50" text-anchor="middle" dominant-baseline="middle" font-size="${labelSize.toFixed(1)}" class="wheel-label">${esc(name)}</text></g>`;
    }).join('');
    return `<svg viewBox="-108 -108 216 216" class="wheel" id="wheel"><circle r="106" fill="#fff" stroke="#f4a261" stroke-width="4"/>${slices}<circle r="16" fill="#fff" stroke="#f4a261" stroke-width="3"/></svg>`;
  }

  function pickPrize(prizes) {
    const bigs = prizes.filter((p) => p.big);
    const pity = S.settings.pity > 0 && bigs.length && S.sinceBig >= S.settings.pity - 1;
    const pool = pity ? bigs : prizes;
    let x = Math.random() * pool.reduce((a, p) => a + Number(p.weight), 0);
    for (const p of pool) { x -= Number(p.weight); if (x < 0) return p; }
    return pool[pool.length - 1];
  }

  function viewWheel() {
    const d = ensurePlan();
    const complete = doneCount(d) >= d.goal;
    const prizes = S.prizes.filter((p) => Number(p.weight) > 0);
    const spin = d.spun && S.spins.find((s) => s.id === d.spun);
    const seg = 360 / Math.max(1, prizes.length);
    let msg;
    let canSpin = false;
    if (!prizes.length) msg = '爸媽還沒有設定獎品喔！';
    else if (spin) msg = `今天抽到 ${spin.emoji} ${esc(spin.name)}，明天再來轉！`;
    else if (!complete) msg = `再讀 ${d.goal - doneCount(d)} 篇就可以轉輪盤喔！`;
    else { msg = '按下中間的按鈕轉轉看！'; canSpin = true; }

    app.innerHTML = `${topbar('🎡 幸運輪盤')}
      <section class="wheel-area">
        <div class="wheel-box ${canSpin ? '' : 'locked'}">
          <div class="pointer"></div>
          ${prizes.length ? wheelSVG(prizes) : ''}
          <button class="spin-btn" id="spin" ${canSpin ? '' : 'disabled'}>${spin ? '✓' : canSpin ? '轉！' : '🔒'}</button>
        </div>
        <p class="wheel-msg">${msg}</p>
      </section>`;

    const wheel = $('#wheel');
    if (spin && wheel) {
      const i = prizes.findIndex((p) => p.id === spin.prizeId);
      if (i >= 0) wheel.style.transform = `rotate(${-(i * seg + seg / 2)}deg)`;
    }
    if (!canSpin) return;

    $('#spin').onclick = () => {
      if (ensurePlan().spun) return;
      const prize = pickPrize(prizes);
      const i = prizes.indexOf(prize);
      const result = {
        id: 'w' + Date.now(), date: Store.today(), at: Date.now(), prizeId: prize.id,
        emoji: prize.emoji, name: prize.name, big: !!prize.big, redeemed: false,
      };
      // 先存結果再播動畫，轉到一半重新整理也不能再轉
      S.spins.push(result);
      d.spun = result.id;
      S.sinceBig = prize.big ? 0 : S.sinceBig + 1;
      save();
      $('#spin').disabled = true;
      const jitter = (Math.random() - 0.5) * seg * 0.7;
      const target = 360 * 6 - (i * seg + seg / 2) + jitter;
      wheel.style.transition = 'transform 5s cubic-bezier(.17,.67,.12,.99)';
      wheel.style.transform = `rotate(${target}deg)`;
      let ticks = 0;
      const tick = setInterval(() => { sfx.tick(); if (++ticks > 30) clearInterval(tick); }, 120);
      cleanup = () => clearInterval(tick);
      setTimeout(() => {
        clearInterval(tick);
        sfx.win();
        confetti();
        openModal(`<div class="celebrate"><div class="big-emoji">${prize.emoji}</div><h2>恭喜抽到</h2><p class="prize-name">${esc(prize.name)}</p>
          <p class="hint">獎品放進「🎒 我的獎品」了，記得請爸媽兌換！</p><button class="btn big go" data-close>好耶！</button></div>`,
        { onClose: () => go('home') });
        $('.wheel-msg').innerHTML = `今天抽到 ${prize.emoji} ${esc(prize.name)}，明天再來轉！`;
        $('#spin').textContent = '✓';
      }, 5200);
    };
  }

  // ---------------- 家長專區 ----------------

  function requireParent(onOk, onCancel) {
    if (Date.now() < parentUntil) return onOk();
    let a = rand(3, 9);
    let b = rand(3, 9);
    const m = openModal(`
      <div class="gate">
        <h2>👨‍👩‍👦 爸媽專區</h2>
        <p>請回答：<b id="gate-q">${a} × ${b}</b> = ?</p>
        <input id="gate-in" type="number" inputmode="numeric" autocomplete="off">
        <button class="btn big go" id="gate-ok">確認</button>
      </div>`, { cls: 'small', onClose: onCancel });
    const input = $('#gate-in', m);
    input.focus();
    const check = () => {
      if (Number(input.value) === a * b) {
        parentUntil = Date.now() + 10 * 60 * 1000;
        closeModal();
        onOk();
      } else {
        sfx.bad();
        a = rand(3, 9); b = rand(3, 9);
        $('#gate-q', m).textContent = `${a} × ${b}`;
        input.value = '';
        m.classList.remove('shake'); void m.offsetWidth; m.classList.add('shake');
      }
    };
    $('#gate-ok', m).onclick = check;
    input.onkeydown = (e) => { if (e.key === 'Enter') check(); };
  }

  const TABS = [['settings', '設定'], ['prizes', '獎項'], ['records', '朗讀紀錄'], ['keepsake', '紀念冊'], ['stories', '題庫'], ['data', '資料']];

  function viewParent(tab) {
    app.innerHTML = `${topbar('⚙️ 爸媽專區')}
      <nav class="tabs">${TABS.map(([k, label]) => `<button data-go="parent/${k}" class="badge-wrap ${k === tab ? 'on' : ''}">${label}${k === 'keepsake' && unexportedMonths().length ? '<span class="badge"></span>' : ''}</button>`).join('')}</nav>
      <section class="panel" id="panel"></section>`;
    const panel = $('#panel');
    ({ settings: parentSettings, prizes: parentPrizes, records: parentRecords, keepsake: parentKeepsake, stories: parentStories, data: parentData }[tab] || parentSettings)(panel);
  }

  function parentSettings(panel) {
    const st = S.settings;
    const opt = (v, cur, label) => `<option value="${v}" ${String(v) === String(cur) ? 'selected' : ''}>${label}</option>`;
    panel.innerHTML = `
      <div class="field"><span>每天要讀幾篇</span>
        <div class="stepper"><button data-step="-1">−</button><b>${st.dailyGoal}</b><button data-step="1">+</button></div></div>
      <label class="field"><span>預設顯示方式</span><select data-set="mode">
        ${opt('zhuyin', st.mode, '只有注音（跟安親班一樣）')}${opt('both', st.mode, '國字＋注音')}${opt('hanzi', st.mode, '只有國字（點字才出現注音）')}</select></label>
      <label class="field"><span>直書排版</span><input type="checkbox" data-set="vertical" ${st.vertical ? 'checked' : ''}></label>
      <label class="field"><span>一定要錄音才算讀完</span><input type="checkbox" data-set="requireRecording" ${st.requireRecording ? 'checked' : ''}></label>
      <label class="field"><span>最短朗讀時間（每個字）</span><select data-set="minSecPerChar">
        ${opt(0.2, st.minSecPerChar, '0.2 秒（寬鬆）')}${opt(0.35, st.minSecPerChar, '0.35 秒（建議）')}${opt(0.5, st.minSecPerChar, '0.5 秒（嚴格）')}</select></label>
      <label class="field"><span>大獎保底（連續幾次沒中就必中）</span><select data-set="pity">
        ${[0, 5, 7, 10, 14].map((v) => opt(v, st.pity, v ? `${v} 次` : '不保底')).join('')}</select></label>
      <label class="field"><span>錄音保留（收藏的永遠不刪）</span><select data-set="keepDays">
        ${[0, 30, 60, 90].map((v) => opt(v, st.keepDays, v ? `${v} 天後自動刪除` : '永久保留（建議）')).join('')}</select></label>
      <label class="field"><span>成長對照：多久沒讀的文章再排進來</span><select data-set="compareDays">
        ${[0, 30, 60, 90].map((v) => opt(v, st.compareDays, v ? `${v} 天` : '關閉')).join('')}</select></label>
      <label class="field"><span>點字發音速度</span><select data-set="speechRate">
        ${opt(0.6, st.speechRate, '慢')}${opt(0.8, st.speechRate, '中')}${opt(1, st.speechRate, '正常')}</select></label>
      <p class="hint">改每日篇數會在今天還沒轉輪盤時立即生效。</p>`;
    panel.onchange = (e) => {
      const k = e.target.dataset.set;
      if (!k) return;
      const v = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
      st[k] = typeof DEFAULT_TYPES[k] === 'number' ? Number(v) : v;
      save();
      toast('已儲存');
    };
    panel.onclick = (e) => {
      const b = e.target.closest('[data-step]');
      if (!b) return;
      st.dailyGoal = Math.max(1, Math.min(10, st.dailyGoal + Number(b.dataset.step)));
      save();
      parentSettings(panel);
    };
  }
  const DEFAULT_TYPES = { mode: '', vertical: true, requireRecording: true, minSecPerChar: 0, pity: 0, keepDays: 0, compareDays: 0, speechRate: 0 };

  function parentPrizes(panel) {
    const total = S.prizes.reduce((a, p) => a + Math.max(0, Number(p.weight) || 0), 0);
    const pct = (p) => (total ? ((Math.max(0, Number(p.weight) || 0) / total) * 100).toFixed(1) : '0') + '%';
    panel.innerHTML = `
      <p class="hint">權重越大越容易抽到，右邊會自動算出機率。勾選「大獎」的獎項會套用保底規則${S.settings.pity ? `（目前已連續 ${S.sinceBig} 次沒抽到大獎，保底：${S.settings.pity} 次）` : ''}。</p>
      <div class="prize-table">
        <div class="prize-row head"><span>圖示</span><span>獎品</span><span>權重</span><span>大獎</span><span>機率</span><span></span></div>
        ${S.prizes.map((p, i) => `
          <div class="prize-row" data-i="${i}">
            <input class="emoji-in" data-f="emoji" value="${esc(p.emoji)}" maxlength="4">
            <input data-f="name" value="${esc(p.name)}" maxlength="20">
            <input data-f="weight" type="number" min="0" inputmode="numeric" value="${Number(p.weight) || 0}">
            <input data-f="big" type="checkbox" ${p.big ? 'checked' : ''}>
            <span class="pct">${pct(p)}</span>
            <button class="icon small" data-del="${i}" aria-label="刪除">🗑️</button>
          </div>`).join('')}
      </div>
      <div class="row"><button class="btn" data-act="add">＋ 新增獎項</button><button class="btn ghost" data-act="reset">恢復預設</button></div>`;
    panel.onchange = (e) => {
      const row = e.target.closest('.prize-row');
      if (!row || !e.target.dataset.f) return;
      const p = S.prizes[+row.dataset.i];
      const f = e.target.dataset.f;
      p[f] = f === 'big' ? e.target.checked : f === 'weight' ? Math.max(0, Number(e.target.value) || 0) : e.target.value;
      save();
      parentPrizes(panel);
    };
    panel.onclick = (e) => {
      const del = e.target.closest('[data-del]');
      if (del) { S.prizes.splice(+del.dataset.del, 1); save(); return parentPrizes(panel); }
      const a = e.target.closest('[data-act]');
      if (!a) return;
      if (a.dataset.act === 'add') S.prizes.push({ id: 'p' + Date.now(), emoji: '🎈', name: '新獎品', weight: 10, big: false });
      if (a.dataset.act === 'reset' && confirm('確定要恢復預設獎項嗎？')) S.prizes = JSON.parse(JSON.stringify(Store.DEFAULT_PRIZES));
      save();
      parentPrizes(panel);
    };
  }

  const fmtMonth = (m) => { const [y, n] = m.split('-').map(Number); return `${y} 年 ${n} 月`; };
  const shiftMonth = (m, delta) => { const [y, n] = m.split('-').map(Number); return Store.today(new Date(y, n - 1 + delta, 1)).slice(0, 7); };
  const hhmm = (at) => { const t = new Date(at); return `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`; };
  const md = (date) => { const [, m, d] = date.split('-').map(Number); return `${m}/${d}`; };

  function parentRecords(panel, month = ym(Store.today()), favOnly = false) {
    const recs = allRecs();
    const today = Store.today();
    const keys = Object.keys(S.days).filter((k) => ym(k) === month).sort().reverse();
    const html = keys.map((key) => {
      const d = S.days[key];
      const spin = d.spun && S.spins.find((s) => s.id === d.spun);
      const items = d.plan.filter((id) => d.done[id] && (!favOnly || S.favs[d.done[id].recId])).map((id) => {
        const s = storyById(id);
        const r = d.done[id];
        const first = r.recId && recs.find((x) => x.storyId === id && x.date < key);
        return `<div class="rec-row">
          <span class="rec-title">${esc(s ? s.title.t : '（已刪除的文章）')}</span>
          <span class="rec-meta">${hhmm(r.at)} · 念了 ${r.sec} 秒</span>
          ${r.recId ? `<button class="btn small" data-play="${r.recId}">▶ 播放</button>
            <button class="fav-btn" data-fav="${r.recId}" aria-label="收藏">${S.favs[r.recId] ? '❤️' : '🤍'}</button>` : '<span class="rec-meta">（沒有錄音）</span>'}
          ${first ? `<button class="btn small ghost" data-play="${first.recId}">🕰️ 聽 ${md(first.date)} 第一次念</button>` : ''}
          ${key === today && !d.spun ? `<button class="btn small ghost" data-reject="${id}">退回重讀</button>` : ''}
        </div>`;
      }).join('');
      if (favOnly && !items) return '';
      return `<div class="rec-day"><h4>${fmtDay(key)}　完成 ${doneCount(d)}/${d.goal}${spin ? `　抽到 ${spin.emoji} ${esc(spin.name)}` : ''}</h4>${items || '<p class="hint">這天還沒有讀完的文章</p>'}</div>`;
    }).join('');
    panel.innerHTML = `
      <div class="cal-head"><button class="icon" data-month="${shiftMonth(month, -1)}">◀</button><h3>${fmtMonth(month)}</h3><button class="icon" data-month="${shiftMonth(month, 1)}">▶</button></div>
      <label class="field"><span>只看 ❤️ 收藏</span><input type="checkbox" data-favonly ${favOnly ? 'checked' : ''}></label>
      <p class="hint">按 🤍 收藏念得特別好的錄音。今天還沒轉輪盤前，可以把念得不好的文章「退回重讀」。</p>
      ${html || '<p class="empty">這個月沒有紀錄</p>'}`;
    panel.onchange = (e) => { if (e.target.matches('[data-favonly]')) parentRecords(panel, month, e.target.checked); };
    panel.onclick = (e) => {
      const mo = e.target.closest('[data-month]');
      if (mo) return parentRecords(panel, mo.dataset.month, favOnly);
      const p = e.target.closest('[data-play]');
      if (p) return Player.playRec(p.dataset.play);
      const f = e.target.closest('[data-fav]');
      if (f) {
        if (S.favs[f.dataset.fav]) delete S.favs[f.dataset.fav];
        else { S.favs[f.dataset.fav] = true; sfx.good(); }
        save();
        return parentRecords(panel, month, favOnly);
      }
      const r = e.target.closest('[data-reject]');
      if (r && confirm('確定要退回這篇，請孩子重讀嗎？')) {
        const d = ensurePlan();
        const done = d.done[r.dataset.reject];
        if (done && done.recId) {
          Store.audio.del(done.recId).catch(() => {});
          delete S.favs[done.recId];
        }
        delete d.done[r.dataset.reject];
        S.readCount[r.dataset.reject] = Math.max(0, readCount(r.dataset.reject) - 1);
        save();
        parentRecords(panel, month, favOnly);
      }
    };
  }

  // ---------------- 紀念冊 ----------------

  async function shareFile(file) {
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file] });
        return true;
      } catch (e) {
        if (e.name === 'AbortError') return false;
      }
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(file);
    a.download = file.name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
    return true;
  }

  function keepsakeHTML(label, entries) {
    const minutes = Math.round(entries.reduce((n, e) => n + (e.sec || 0), 0) / 60);
    const cards = entries.map((e) => `
      <article class="card">
        <header><span class="date">${fmtDay(e.date)} ${hhmm(e.at)}</span>${e.fav ? '<span class="fav">❤️ 收藏</span>' : ''}</header>
        <h2>${Zhuyin.segHTML({ t: e.title, z: Zhuyin.auto(e.title) })}</h2>
        <div class="text">${e.lines.map((l) => `<div>${Zhuyin.segHTML(l)}</div>`).join('')}</div>
        <audio controls preload="none" src="${encodeURI(e.name)}"></audio>
      </article>`).join('');
    return `<!doctype html><html lang="zh-Hant-TW"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>注音小書蟲 朗讀紀念冊 ${esc(label)}</title>
<style>
body{margin:0;background:#fff8ec;color:#3d3027;font-family:-apple-system,"PingFang TC","Microsoft JhengHei",sans-serif;padding:24px 16px}
main{max-width:760px;margin:0 auto}h1{font-family:"Kaiti TC","BiauKai","DFKai-SB",serif;font-size:34px;margin:0}
.sum{color:#8a7b6e;margin:8px 0 24px}.card{background:#fffdf8;border:2px solid #eadfce;border-radius:18px;padding:16px 20px;margin-bottom:16px}
.card header{display:flex;justify-content:space-between;color:#8a7b6e}.fav{color:#e76f51;font-weight:700}
.card h2{font-family:"Kaiti TC","BiauKai","DFKai-SB",serif;font-size:30px;margin:6px 0}.text{font-family:"Kaiti TC","BiauKai","DFKai-SB",serif;font-size:32px;margin-bottom:10px}
audio{width:100%}.c{display:inline-flex;align-items:center;vertical-align:middle;margin:0 .04em}.c .h{line-height:1.25}
.c .z{display:inline-flex;flex-direction:column;justify-content:center;align-items:center;font-size:.34em;line-height:1.02;width:1.25em;margin-left:.06em;color:#2f5fa8}
.c .s{display:block;position:relative}.c .t{position:absolute;left:92%;top:-.42em}.c .lt{display:block;line-height:.5;height:.55em}
</style></head><body><main>
<h1>📖 朗讀紀念冊・${esc(label)}</h1>
<p class="sum">一共念了 ${entries.length} 篇，大約 ${minutes} 分鐘。錄音檔都在「錄音」資料夾裡。</p>
${cards}
</main></body></html>`;
  }

  async function buildKeepsake(list, label) {
    const files = [];
    const entries = [];
    const used = new Set();
    for (const r of list) {
      const rec = await Store.audio.get(r.recId).catch(() => null);
      if (!rec) continue;
      const story = storyById(r.storyId);
      const title = rec.title || (story ? story.title.t : '朗讀');
      const ext = /webm/.test(rec.blob.type) ? 'webm' : 'm4a';
      const base = `${r.date}_${title}`.replace(/[\\/:*?"<>|]/g, '');
      let name = `錄音/${base}.${ext}`;
      for (let k = 2; used.has(name); k++) name = `錄音/${base}-${k}.${ext}`;
      used.add(name);
      files.push({ name, data: rec.blob, date: new Date(r.at) });
      entries.push(Object.assign({}, r, { title, name, lines: rec.lines || (story ? story.lines : []), fav: !!S.favs[r.recId] }));
    }
    files.unshift({ name: '紀念冊.html', data: keepsakeHTML(label, entries) });
    const blob = await Zip.build(files);
    return { file: new File([blob], `注音小書蟲_${label}.zip`, { type: 'application/zip' }), count: entries.length };
  }

  function parentKeepsake(panel) {
    const recs = allRecs();
    const thisMonth = ym(Store.today());
    const months = [...new Set(recs.map((r) => ym(r.date)))].sort().reverse();
    const favs = recs.filter((r) => S.favs[r.recId]);
    const pending = unexportedMonths();
    const built = {};
    const row = (key, name, meta, state) => `
      <div class="ks-row" data-key="${key}">
        <span class="ks-name">${name}</span><span class="rec-meta">${meta}</span><span class="ks-state">${state}</span>
        <span class="ks-act"><button class="btn" data-build="${key}">準備紀念冊</button></span>
      </div>`;
    panel.innerHTML = `
      ${pending.length ? `<div class="notice">📌 ${pending.map(fmtMonth).join('、')}的錄音還沒存到 iCloud 雲碟，記得備份喔！</div>` : ''}
      <h3>儲存狀態</h3>
      <p class="hint" id="ks-usage">計算中…</p>
      <h3>每月朗讀紀念冊</h3>
      <ol class="hint steps">
        <li>按「準備紀念冊」，把這個月的錄音打包成一個壓縮檔。</li>
        <li>按「📤 存到 iCloud 雲碟」，在分享選單選「儲存到檔案」→「iCloud 雲碟」。建議建一個「注音小書蟲」資料夾。</li>
        <li>在「檔案」App 點一下壓縮檔就會解開。「錄音」資料夾裡的檔案可以直接播放；用電腦打開「紀念冊.html」，可以邊看文章邊聽錄音。</li>
      </ol>
      ${months.map((m) => {
        const n = recs.filter((r) => ym(r.date) === m).length;
        const f = recs.filter((r) => ym(r.date) === m && S.favs[r.recId]).length;
        const state = S.exported[m] ? `✅ 已存（${new Date(S.exported[m]).toLocaleDateString('zh-TW')}）`
          : m === thisMonth ? '本月還在進行中' : '⚠️ 尚未備份';
        return row(m, fmtMonth(m), `${n} 段 · ❤️ ${f}`, state);
      }).join('') || '<p class="empty">還沒有錄音</p>'}
      <h3>❤️ 收藏精選</h3>
      ${favs.length ? row('fav', '全部收藏', `${favs.length} 段`, '') : '<p class="hint">在「朗讀紀錄」按 🤍 收藏念得特別好的錄音，就可以在這裡匯出精選集。</p>'}`;

    Store.usage().then((u) => {
      const el = $('#ks-usage', panel);
      if (!el) return;
      el.innerHTML = `錄音 ${recs.length} 段，約使用 ${(u.used / 1048576).toFixed(1)} MB。<br>
        ${u.persisted ? '✅ 已啟用持久儲存' : '⚠️ 尚未啟用持久儲存 <button class="btn small" data-persist>啟用</button>'}
        ${S.settings.keepDays ? `⚠️ 錄音會在 ${S.settings.keepDays} 天後自動刪除（收藏的除外）` : '✅ 錄音永久保留'}<br>
        提醒：從主畫面刪除 App 或清除 Safari 資料，錄音就會消失，所以每個月記得存一份到 iCloud 雲碟。`;
    }).catch(() => {});

    panel.onclick = async (e) => {
      if (e.target.closest('[data-persist]')) {
        const ok = await Store.persist().catch(() => false);
        toast(ok ? '已啟用持久儲存' : 'Safari 沒有同意，請先把 App 加到主畫面再試');
        return parentKeepsake(panel);
      }
      const b = e.target.closest('[data-build]');
      if (b) {
        const key = b.dataset.build;
        b.disabled = true;
        b.textContent = '打包中…';
        const list = key === 'fav' ? favs : recs.filter((r) => ym(r.date) === key);
        const result = await buildKeepsake(list, key === 'fav' ? '收藏精選' : fmtMonth(key).replace(/ /g, ''));
        if (!result.count) {
          b.textContent = '找不到錄音檔';
          return;
        }
        built[key] = result.file;
        b.parentElement.innerHTML = `<button class="btn go" data-share="${key}">📤 存到 iCloud 雲碟</button>`;
        return;
      }
      const s = e.target.closest('[data-share]');
      if (s) {
        const key = s.dataset.share;
        const ok = await shareFile(built[key]);
        if (ok && key !== 'fav' && key !== thisMonth) {
          S.exported[key] = Date.now();
          save();
          toast('已記錄這個月的紀念冊備份 ✅');
          viewParent('keepsake');
        }
      }
    };
  }

  function parentStories(panel) {
    const draft = { title: '', lines: [], quiz: null };
    function renderList() {
      return S.custom.map((s, i) => `<div class="rec-row"><span class="rec-title">${esc(s.title.t)}</span><span class="rec-meta">${s.lines.length} 行 · 讀過 ${readCount(s.id)} 次</span>
        <button class="btn small ghost" data-del="${i}">刪除</button></div>`).join('') || '<p class="hint">還沒有自訂文章</p>';
    }
    panel.innerHTML = `
      <h3>新增文章（例如安親班白板上的內容）</h3>
      <label class="field col"><span>標題</span><input id="cs-title" maxlength="20" placeholder="例如：糖果"></label>
      <label class="field col"><span>內文（一行一句）</span><textarea id="cs-text" rows="6" placeholder="糖果一顆顆，&#10;紅黃綠白真好看，"></textarea></label>
      <button class="btn" data-act="preview">產生注音預覽</button>
      <div id="cs-preview"></div>
      <h3>讀後小問題（可不填）</h3>
      <label class="field col"><span>問題</span><input id="cs-q" maxlength="30" placeholder="例如：糖果有幾種顏色？"></label>
      <div class="quiz-edit">
        <input id="cs-e0" class="emoji-in" placeholder="✅" maxlength="4"><input id="cs-o0" placeholder="正確答案">
        <input id="cs-e1" class="emoji-in" placeholder="❌" maxlength="4"><input id="cs-o1" placeholder="錯誤答案 1">
        <input id="cs-e2" class="emoji-in" placeholder="❌" maxlength="4"><input id="cs-o2" placeholder="錯誤答案 2">
      </div>
      <button class="btn big go" data-act="save">儲存文章</button>
      <h3>我加的文章</h3><div id="cs-list">${renderList()}</div>`;

    const readDraft = () => {
      const title = $('#cs-title').value.trim();
      const lines = $('#cs-text').value.split('\n').map((x) => x.trim()).filter(Boolean);
      // 保留已經手動修正過的注音
      draft.lines = lines.map((t) => {
        const old = draft.lines.find((l) => l.t === t);
        return old || { t, z: Zhuyin.auto(t) };
      });
      draft.title = title;
    };
    const renderPreview = () => {
      $('#cs-preview').innerHTML = draft.lines.length ? `
        <p class="hint">注音是自動產生的，破音字可能會錯。點一下字可以改讀音。</p>
        <div class="text mode-both preview">${draft.lines.map((l, li) =>
          `<div class="line" data-l="${li}">${[...l.t].map((ch, k) => Zhuyin.charHTML(ch, l.z[k], k)).join('')}</div>`).join('')}</div>` : '';
    };

    panel.onclick = (e) => {
      const a = e.target.closest('[data-act]');
      const c = e.target.closest('#cs-preview .c:not(.p)');
      const del = e.target.closest('[data-del]');
      if (c) {
        const li = +c.closest('.line').dataset.l;
        const k = +c.dataset.i;
        const line = draft.lines[li];
        const ch = [...line.t][k];
        const opts = [...new Set([line.z[k], ...Zhuyin.readings(ch)])].filter(Boolean);
        const m = openModal(`<div class="reading-pick"><h3>「${esc(ch)}」要念哪個音？</h3>
          <div class="row">${opts.map((z) => `<button class="btn mode-both ${z === line.z[k] ? 'go' : ''}" data-z="${esc(z)}">${Zhuyin.charHTML(ch, z)}</button>`).join('')}</div>
          <label class="field col"><span>或自己輸入注音</span><input id="z-custom" placeholder="例如 ˙ㄉㄜ"></label>
          <button class="btn" data-z-custom>使用自己輸入的</button></div>`, { cls: 'small' });
        m.onclick = (ev) => {
          const zb = ev.target.closest('[data-z]');
          let z = zb ? zb.dataset.z : null;
          if (ev.target.closest('[data-z-custom]')) z = $('#z-custom', m).value.trim();
          if (z == null) return;
          line.z[k] = z;
          closeModal();
          renderPreview();
        };
        return;
      }
      if (del) {
        if (!confirm('確定要刪除這篇文章嗎？')) return;
        S.custom.splice(+del.dataset.del, 1);
        save();
        $('#cs-list').innerHTML = renderList();
        return;
      }
      if (!a) return;
      if (a.dataset.act === 'preview') { readDraft(); renderPreview(); }
      if (a.dataset.act === 'save') {
        readDraft();
        if (!draft.title || !draft.lines.length) return toast('請填標題和內文');
        const q = $('#cs-q').value.trim();
        const options = [0, 1, 2].map((i) => ({ e: $(`#cs-e${i}`).value.trim(), t: $(`#cs-o${i}`).value.trim() })).filter((o) => o.t);
        S.custom.push({
          id: 'c' + Date.now(),
          custom: true,
          title: { t: draft.title, z: Zhuyin.auto(draft.title) },
          lines: draft.lines,
          quiz: q && options.length >= 2 && $('#cs-o0').value.trim() ? { q: { t: q }, options, answer: 0 } : null,
        });
        save();
        toast('已儲存！新文章會優先排進每日任務');
        parentStories(panel);
      }
    };
  }

  function parentData(panel) {
    panel.innerHTML = `
      <p class="hint">所有資料都存在這台 iPad 上。換裝置或清除 Safari 資料前，請先匯出備份（錄音不包含在備份裡）。</p>
      <div class="row"><button class="btn" data-act="export">⬇️ 匯出備份</button>
      <label class="btn">⬆️ 匯入備份<input type="file" accept="application/json,.json" id="import" hidden></label></div>
      <h3>重設</h3>
      <div class="row"><button class="btn ghost" data-act="reset-today">重設今天的任務</button>
      <button class="btn ghost danger" data-act="reset-all">清除全部資料</button></div>`;
    panel.onclick = (e) => {
      const a = e.target.closest('[data-act]');
      if (!a) return;
      if (a.dataset.act === 'export') {
        const blob = new Blob([JSON.stringify(S, null, 1)], { type: 'application/json' });
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = `注音小書蟲備份-${Store.today()}.json`;
        link.click();
      }
      if (a.dataset.act === 'reset-today' && confirm('今天的進度（包含輪盤）會清除，確定嗎？')) {
        const d = S.days[Store.today()];
        if (d && d.spun) {
          const spin = S.spins.find((s) => s.id === d.spun);
          S.spins = S.spins.filter((s) => s.id !== d.spun);
          if (spin && !spin.big) S.sinceBig = Math.max(0, S.sinceBig - 1);
        }
        delete S.days[Store.today()];
        save();
        toast('已重設今天的任務');
      }
      if (a.dataset.act === 'reset-all' && confirm('所有進度、獎品紀錄、自訂文章都會刪除，確定嗎？') && confirm('真的要全部清除嗎？')) {
        localStorage.clear();
        S = Store.load();
        go('home');
      }
    };
    $('#import', panel).onchange = async (e) => {
      const f = e.target.files[0];
      if (!f) return;
      try {
        const data = JSON.parse(await f.text());
        if (!data.settings || !data.days) throw new Error('bad');
        localStorage.setItem('zhuyin-reader.v1', JSON.stringify(data));
        S = Store.load();
        toast('匯入完成！');
      } catch (err) {
        toast('這不是注音小書蟲的備份檔');
      }
    };
  }

  // ---------------- 啟動 ----------------

  window.addEventListener('hashchange', route);
  // 跨過午夜回到 App 時重新整理今天的任務
  document.addEventListener('visibilitychange', () => { if (!document.hidden && !location.hash.startsWith('#/read')) route(); });
  Store.audio.prune(S.settings.keepDays, S.favs).catch(() => {});
  route();
})();
