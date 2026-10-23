// 資料儲存：設定、進度、獎項、紀錄放 localStorage；朗讀錄音放 IndexedDB。
window.Store = (function () {
  const KEY = 'zhuyin-reader.v1';

  const DEFAULT_PRIZES = [
    { id: 'p1', emoji: '🍬', name: '小點心一份', weight: 30, big: false },
    { id: 'p2', emoji: '📖', name: '睡前多講一個故事', weight: 25, big: false },
    { id: 'p3', emoji: '⭐', name: '貼紙一張', weight: 20, big: false },
    { id: 'p4', emoji: '🎮', name: '平板 +10 分鐘', weight: 12, big: false },
    { id: 'p5', emoji: '🍽️', name: '週末選晚餐', weight: 8, big: false },
    { id: 'p6', emoji: '🎁', name: '大獎：小玩具', weight: 5, big: true },
  ];

  const DEFAULTS = {
    settings: {
      dailyGoal: 5,
      mode: 'both', // zhuyin | both | hanzi
      vertical: false,
      fontSize: 48,
      minSecPerChar: 0.35, // 每個字至少要念多久（秒），防止亂按
      requireRecording: true,
      pity: 7, // 連續幾次沒中大獎就保底（0 = 不保底）
      keepDays: 0, // 錄音保留天數（0 = 永久保留）
      compareDays: 60, // 多久以前讀過的文章會排進「成長對照」（0 = 關閉）
      speechRate: 0.8,
    },
    prizes: DEFAULT_PRIZES,
    days: {}, // 'YYYY-MM-DD': { goal, plan: [id], done: { id: { at, recId, sec } }, spun: spinId|null }
    readCount: {},
    spins: [], // { id, date, at, prizeId, emoji, name, big, redeemed, redeemedAt }
    sinceBig: 0,
    words: [], // { ch, zy }
    custom: [], // 家長自訂文章
    favs: {}, // 收藏的錄音 { recId: true }
    exported: {}, // 已匯出紀念冊的月份 { 'YYYY-MM': 時間 }
    schema: 2,
  };

  function today(d = new Date()) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  function load() {
    let data = {};
    try { data = JSON.parse(localStorage.getItem(KEY)) || {}; } catch (e) { data = {}; }
    const merged = Object.assign(JSON.parse(JSON.stringify(DEFAULTS)), data);
    merged.settings = Object.assign({}, DEFAULTS.settings, data.settings || {});
    if ((data.schema || 1) < 2) {
      // v2 起錄音預設永久保留
      merged.settings.keepDays = 0;
      merged.schema = 2;
    }
    return merged;
  }

  function save(state) {
    localStorage.setItem(KEY, JSON.stringify(state));
  }

  // ---- 錄音（IndexedDB） ----
  let dbp = null;
  function db() {
    if (!dbp) {
      dbp = new Promise((resolve, reject) => {
        const req = indexedDB.open('zhuyin-reader-audio', 1);
        req.onupgradeneeded = () => req.result.createObjectStore('recs');
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }
    return dbp;
  }

  function tx(mode, fn) {
    return db().then((d) => new Promise((resolve, reject) => {
      const t = d.transaction('recs', mode);
      const result = fn(t.objectStore('recs'));
      t.oncomplete = () => resolve(result && result.result);
      t.onerror = () => reject(t.error);
    }));
  }

  const audio = {
    put: (id, rec) => tx('readwrite', (s) => s.put(rec, id)),
    get: (id) => tx('readonly', (s) => s.get(id)),
    del: (id) => tx('readwrite', (s) => s.delete(id)),
    // 刪除超過保留天數的錄音，收藏的不刪
    prune(keepDays, keepIds) {
      if (!keepDays) return Promise.resolve();
      const cutoff = today(new Date(Date.now() - keepDays * 86400000));
      return tx('readwrite', (s) => {
        s.openCursor().onsuccess = (e) => {
          const cur = e.target.result;
          if (!cur) return;
          if (cur.value.date < cutoff && !keepIds[cur.key]) cur.delete();
          cur.continue();
        };
      });
    },
  };

  // 向瀏覽器申請持久儲存，降低錄音被系統清掉的機會
  async function persist() {
    if (!navigator.storage || !navigator.storage.persist) return false;
    if (await navigator.storage.persisted()) return true;
    return navigator.storage.persist();
  }

  async function usage() {
    const persisted = navigator.storage && navigator.storage.persisted ? await navigator.storage.persisted() : false;
    const est = navigator.storage && navigator.storage.estimate ? await navigator.storage.estimate() : {};
    return { persisted, used: est.usage || 0 };
  }

  return { load, save, today, audio, persist, usage, DEFAULT_PRIZES };
})();
