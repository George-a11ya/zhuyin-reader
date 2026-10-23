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

  let actx = null;
  function beep(notes) {
    try {
      actx = actx || new (window.AudioContext || window.webkitAudioContext)();
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

  // 今天的任務：先排新文章（家長自訂的優先），保留一篇讀過最少次的當複習
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
      if (wantReview) { const r = read.shift(); picks.push(r); d.review.push(r.id); }
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
        <div class="top-right">${st ? `<span class="streak">🔥 連續 ${st} 天</span>` : ''}<button class="icon" data-go="parent" aria-label="爸媽專區">⚙️</button></div>
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
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
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
      if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
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
    const rec = { state: 'idle', blob: null, sec: 0, timer: null, url: null, noMic: false };
    let player = null;

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
      if (!rec.blob) return;
      if (player) player.pause();
      if (rec.url) URL.revokeObjectURL(rec.url);
      rec.url = URL.createObjectURL(rec.blob);
      player = new Audio(rec.url);
      player.play();
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
          await Store.audio.put(recId, { blob: rec.blob, storyId: id, date: Store.today(), sec: rec.sec });
        } catch (e) { recId = null; }
      }
      S.readCount[id] = readCount(id) + 1;
      let complete = false;
      let n = 0;
      if (isTask) {
        const d = ensurePlan();
        if (d.plan.includes(id) && !d.done[id]) d.done[id] = { at: Date.now(), recId, sec: Math.round(rec.sec) };
        n = doneCount(d);
        complete = n >= d.goal && !d.spun;
      }
      save();
      sfx.win();
      confetti();
      openModal(`
        <div class="celebrate">
          <div class="big-emoji">${complete ? '🏆' : '🎉'}</div>
          <h2>${complete ? '今天的任務全部完成！' : '太棒了！讀完一篇！'}</h2>
          ${isTask ? `<p>今天已經讀了 ${n} 篇</p>` : '<p>多讀一篇，越來越厲害！</p>'}
          <div class="row">
            ${complete ? '<button class="btn big go" data-close-go="wheel">🎡 去轉輪盤</button>' : '<button class="btn big" data-close-go="home">回首頁</button>'}
          </div>
        </div>`, { closable: false });
      $('#modal-root').onclick = (e) => {
        const b = e.target.closest('[data-close-go]');
        if (b) { closeModal(); go(b.dataset.closeGo); }
      };
    }

    cleanup = () => {
      clearInterval(rec.timer);
      Recorder.release();
      if (player) player.pause();
      if (rec.url) URL.revokeObjectURL(rec.url);
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

  const TABS = [['settings', '設定'], ['prizes', '獎項'], ['records', '朗讀紀錄'], ['stories', '題庫'], ['data', '資料']];

  function viewParent(tab) {
    app.innerHTML = `${topbar('⚙️ 爸媽專區')}
      <nav class="tabs">${TABS.map(([k, label]) => `<button data-go="parent/${k}" class="${k === tab ? 'on' : ''}">${label}</button>`).join('')}</nav>
      <section class="panel" id="panel"></section>`;
    const panel = $('#panel');
    ({ settings: parentSettings, prizes: parentPrizes, records: parentRecords, stories: parentStories, data: parentData }[tab] || parentSettings)(panel);
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
      <label class="field"><span>錄音保留天數</span><select data-set="keepDays">
        ${[7, 14, 30, 60].map((v) => opt(v, st.keepDays, `${v} 天`)).join('')}</select></label>
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
  const DEFAULT_TYPES = { mode: '', vertical: true, requireRecording: true, minSecPerChar: 0, pity: 0, keepDays: 0, speechRate: 0 };

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

  function parentRecords(panel) {
    const keys = Object.keys(S.days).sort().reverse().slice(0, 14);
    const today = Store.today();
    const html = keys.map((key) => {
      const d = S.days[key];
      const spin = d.spun && S.spins.find((s) => s.id === d.spun);
      const items = d.plan.filter((id) => d.done[id]).map((id) => {
        const s = storyById(id);
        const r = d.done[id];
        const t = new Date(r.at);
        return `<div class="rec-row">
          <span class="rec-title">${esc(s ? s.title.t : '（已刪除的文章）')}</span>
          <span class="rec-meta">${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')} · 念了 ${r.sec} 秒</span>
          ${r.recId ? `<button class="btn small" data-play="${r.recId}">▶ 播放</button>` : '<span class="rec-meta">（沒有錄音）</span>'}
          ${key === today && !d.spun ? `<button class="btn small ghost" data-reject="${id}">退回重讀</button>` : ''}
        </div>`;
      }).join('');
      return `<div class="rec-day"><h4>${fmtDay(key)}　完成 ${doneCount(d)}/${d.goal}${spin ? `　抽到 ${spin.emoji} ${esc(spin.name)}` : ''}</h4>${items || '<p class="hint">這天還沒有讀完的文章</p>'}</div>`;
    }).join('');
    panel.innerHTML = `<p class="hint">可以聽孩子的朗讀錄音。今天還沒轉輪盤前，可以把念得不好的文章「退回重讀」。錄音保留 ${S.settings.keepDays} 天。</p>${html || '<p class="empty">還沒有紀錄</p>'}`;
    let player = null;
    panel.onclick = async (e) => {
      const p = e.target.closest('[data-play]');
      if (p) {
        const rec = await Store.audio.get(p.dataset.play).catch(() => null);
        if (!rec) return toast('找不到這段錄音（可能已超過保留天數）');
        if (player) player.pause();
        player = new Audio(URL.createObjectURL(rec.blob));
        player.play();
        return;
      }
      const r = e.target.closest('[data-reject]');
      if (r && confirm('確定要退回這篇，請孩子重讀嗎？')) {
        const d = ensurePlan();
        const done = d.done[r.dataset.reject];
        if (done && done.recId) Store.audio.del(done.recId).catch(() => {});
        delete d.done[r.dataset.reject];
        S.readCount[r.dataset.reject] = Math.max(0, readCount(r.dataset.reject) - 1);
        save();
        parentRecords(panel);
      }
    };
    cleanup = () => { if (player) player.pause(); };
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
  Store.audio.prune(S.settings.keepDays).catch(() => {});
  route();
})();
