"""產生 js/stories.js（內建題庫）與 js/zhuyin-dict.js（自訂文章用的常用字注音字典）。

用法：pip install pypinyin && python3 tools/build_data.py [--review]
--review 會把每篇逐字注音印出來方便校對。
"""
import json
import os
import sys

from pypinyin import Style, pinyin

sys.path.insert(0, os.path.dirname(__file__))
from stories_src import STORIES  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def is_han(ch):
    return "一" <= ch <= "鿿" or "㐀" <= ch <= "䶿"


def norm(zy):
    # pypinyin 的輕聲寫成「ㄗ˙」，台灣課本寫法是點在前面「˙ㄗ」
    if zy.endswith("˙"):
        return "˙" + zy[:-1]
    return zy


# 依教育部國語辭典 / 國小課本慣例校正（「一」「不」標本調）
CHAR_FIX = {"一": "ㄧ", "誰": "ㄕㄟˊ", "期": "ㄑㄧˊ", "著": "˙ㄓㄜ", "呱": "ㄍㄨㄚ"}
WORD_FIX = {
    "滴答": ["ㄉㄧ", "ㄉㄚ"],
    "嘩啦啦": ["ㄏㄨㄚ", "ㄌㄚ", "ㄌㄚ"],
    "乾淨": ["ㄍㄢ", "ㄐㄧㄥˋ"],
    "背著": ["ㄅㄟ", "˙ㄓㄜ"],
    "喝得": ["ㄏㄜ", "˙ㄉㄜ"],
    "變得": ["ㄅㄧㄢˋ", "˙ㄉㄜ"],
    "睡覺": ["ㄕㄨㄟˋ", "ㄐㄧㄠˋ"],
    "午覺": ["ㄨˇ", "ㄐㄧㄠˋ"],
    "起得": ["ㄑㄧˇ", "˙ㄉㄜ"],
    "洗得": ["ㄒㄧˇ", "˙ㄉㄜ"],
    "噴得": ["ㄆㄣ", "˙ㄉㄜ"],
    "爸爸": ["ㄅㄚˋ", "˙ㄅㄚ"],
    "媽媽": ["ㄇㄚ", "˙ㄇㄚ"],
    "公公": ["ㄍㄨㄥ", "˙ㄍㄨㄥ"],
    "西瓜": ["ㄒㄧ", "˙ㄍㄨㄚ"],
    "蘿蔔": ["ㄌㄨㄛˊ", "˙ㄅㄛ"],
    "休息": ["ㄒㄧㄡ", "˙ㄒㄧ"],
    "東西": ["ㄉㄨㄥ", "˙ㄒㄧ"],
    "眼睛": ["ㄧㄢˇ", "˙ㄐㄧㄥ"],
    "嘴巴": ["ㄗㄨㄟˇ", "˙ㄅㄚ"],
    "耳朵": ["ㄦˇ", "˙ㄉㄨㄛ"],
    "清楚": ["ㄑㄧㄥ", "˙ㄔㄨ"],
    "熱鬧": ["ㄖㄜˋ", "˙ㄋㄠ"],
    "朋友": ["ㄆㄥˊ", "˙ㄧㄡ"],
}


def line_zhuyin(line):
    out = []
    for ch, reading in zip(line, pinyin(line, style=Style.BOPOMOFO, errors=lambda s: [[c] for c in s])):
        out.append(CHAR_FIX.get(ch, norm(reading[0])) if is_han(ch) else "")
    for word, zys in WORD_FIX.items():
        start = line.find(word)
        while start != -1:
            out[start:start + len(word)] = zys
            start = line.find(word, start + len(word))
    return out


def build_stories():
    result = []
    for i, s in enumerate(STORIES):
        fix = s.get("fix", {})
        lines = []
        for text in s["lines"]:
            zys = line_zhuyin(text)
            for k, ch in enumerate(text):
                if ch in fix:
                    zys[k] = fix[ch]
            lines.append({"t": text, "z": zys})
        options = []
        for opt in s["quiz"]["options"]:
            emoji, text = opt.split(" ", 1)
            options.append({"e": emoji, "t": text, "z": line_zhuyin(text)})
        q = s["quiz"]["q"]
        result.append({
            "id": "s%03d" % (i + 1),
            "title": {"t": s["title"], "z": line_zhuyin(s["title"])},
            "lines": lines,
            "quiz": {"q": {"t": q, "z": line_zhuyin(q)}, "options": options, "answer": 0},
        })
    return result


def build_dict(extra_chars):
    chars = set(extra_chars)
    # Big5 常用字（第一級，0xA440–0xC67E）
    for hi in range(0xA4, 0xC7):
        for lo in list(range(0x40, 0x7F)) + list(range(0xA1, 0xFF)):
            try:
                ch = bytes([hi, lo]).decode("big5")
            except UnicodeDecodeError:
                continue
            if is_han(ch):
                chars.add(ch)
    entries = []
    for ch in sorted(chars):
        readings = [norm(r) for r in pinyin(ch, style=Style.BOPOMOFO, heteronym=True)[0]]
        if ch in CHAR_FIX:
            readings.insert(0, CHAR_FIX[ch])
        readings = [r for r in dict.fromkeys(readings) if r and r != ch]
        if readings:
            entries.append(ch + "|".join(readings))
    return ",".join(entries)


def main():
    stories = build_stories()
    with open(os.path.join(ROOT, "js", "stories.js"), "w", encoding="utf-8") as f:
        f.write("// 由 tools/build_data.py 產生，請改 tools/stories_src.py 後重新產生\n")
        f.write("window.BUILTIN_STORIES = ")
        json.dump(stories, f, ensure_ascii=False, separators=(",", ":"))
        f.write(";\n")
    used = {ch for s in STORIES for line in s["lines"] for ch in line if is_han(ch)}
    with open(os.path.join(ROOT, "js", "zhuyin-dict.js"), "w", encoding="utf-8") as f:
        f.write("// 由 tools/build_data.py 產生：常用字 → 注音（第一個為預設讀音，| 分隔破音）\n")
        f.write("window.ZHUYIN_DICT_RAW = ")
        json.dump(build_dict(used), f, ensure_ascii=False)
        f.write(";\n")
    if "--review" in sys.argv:
        for s in stories:
            print("\n#", s["id"], s["title"])
            for line in s["lines"]:
                print("  " + " ".join(f"{c}{z}" for c, z in zip(line["t"], line["z"]) if z))
    print("ok:", len(stories), "stories")


if __name__ == "__main__":
    main()
