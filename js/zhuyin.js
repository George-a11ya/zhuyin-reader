// 注音排版：每個國字右邊一欄直排注音，聲調標在最後一個符號右上，輕聲點在最上面。
window.Zhuyin = (function () {
  let dict = null;

  function getDict() {
    if (!dict) {
      dict = {};
      for (const entry of window.ZHUYIN_DICT_RAW.split(',')) {
        dict[entry[0]] = entry.slice(1).split('|');
      }
    }
    return dict;
  }

  const isHan = (ch) => /[㐀-䶿一-鿿]/.test(ch);

  // 自訂文章用：每個字取字典第一個讀音，家長可再手動修正
  function auto(text) {
    return [...text].map((ch) => (isHan(ch) ? (getDict()[ch] || [''])[0] : ''));
  }

  function readings(ch) {
    return getDict()[ch] || [];
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function parse(zy) {
    let s = zy;
    let light = false;
    let tone = '';
    if (s[0] === '˙') { light = true; s = s.slice(1); }
    const last = s[s.length - 1];
    if ('ˊˇˋ'.includes(last)) { tone = last; s = s.slice(0, -1); }
    return { light, tone, syms: [...s] };
  }

  function zyHTML(zy) {
    const { light, tone, syms } = parse(zy);
    const body = syms.map((c, k) =>
      `<span class="s">${c}${k === syms.length - 1 && tone ? `<span class="t">${tone}</span>` : ''}</span>`
    ).join('');
    return `<span class="z">${light ? '<span class="lt">˙</span>' : ''}${body}</span>`;
  }

  function charHTML(ch, zy, idx) {
    const i = idx == null ? '' : ` data-i="${idx}"`;
    if (!zy) return `<span class="c p"${i}><span class="h">${esc(ch)}</span></span>`;
    return `<span class="c"${i}><span class="h">${esc(ch)}</span>${zyHTML(zy)}</span>`;
  }

  // seg = { t: "文字", z: ["注音", ...] }
  function segHTML(seg, offset) {
    const z = seg.z || auto(seg.t);
    return [...seg.t].map((ch, k) => charHTML(ch, z[k], offset == null ? null : offset + k)).join('');
  }

  return { auto, readings, isHan, esc, zyHTML, charHTML, segHTML };
})();
