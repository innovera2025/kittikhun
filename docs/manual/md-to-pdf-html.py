#!/usr/bin/env python3
"""แปลง Markdown ของแผนงานเป็น HTML สำหรับพิมพ์เป็น PDF ด้วย Chrome headless

รองรับเฉพาะโครงสร้างที่แผนใช้จริง: heading, ตาราง, code fence, list, bold,
inline code, เส้นคั่น — ไม่ใช่ตัวแปลง Markdown ทั่วไป
"""
import html
import re
import sys

CSS = """
@page { size: A4; margin: 16mm 14mm; }
:root {
  --ink:#171717; --ink-2:#4D4D4D; --ink-3:#666666; --ink-4:#A8A8A8;
  --line:#EBEBEB; --canvas:#FAFAFA; --warn-bg:#FFF8E6; --warn-br:#E8C35A;
}
* { box-sizing:border-box; }
body {
  margin:0; background:#fff; color:var(--ink);
  font-family:"IBM Plex Sans Thai","Noto Sans Thai","Sukhumvit Set","Helvetica Neue",Arial,sans-serif;
  font-size:10pt; line-height:1.6; -webkit-font-smoothing:antialiased;
}
h1 { font-size:24pt; font-weight:600; letter-spacing:-0.03em; line-height:1.2;
     margin:0 0 18px; padding-bottom:14px; border-bottom:2px solid var(--ink); }
h2 { font-size:15pt; font-weight:600; letter-spacing:-0.02em; margin:26px 0 8px;
     page-break-after:avoid; }
h3 { font-size:11.5pt; font-weight:600; margin:18px 0 6px; page-break-after:avoid; }
p  { margin:0 0 9px; }
hr { border:none; border-top:1px solid var(--line); margin:22px 0; }
strong { font-weight:600; }
ul, ol { margin:0 0 10px; padding-left:20px; }
li { margin-bottom:4px; }
code {
  font-family:"SF Mono",Menlo,Consolas,monospace; font-size:0.9em;
  background:var(--canvas); border:1px solid var(--line); border-radius:4px; padding:1px 5px;
}
pre {
  background:var(--canvas); border:1px solid var(--line); border-radius:6px;
  padding:11px 13px; overflow-x:auto; margin:10px 0; page-break-inside:avoid;
}
pre code { background:none; border:none; padding:0; font-size:8.6pt; line-height:1.5; }
table { width:100%; border-collapse:collapse; margin:10px 0; font-size:9pt; }
th, td { text-align:left; padding:6px 8px; border-bottom:1px solid var(--line); vertical-align:top; }
th { font-weight:600; color:var(--ink-3); border-bottom:1.5px solid var(--ink-4); }
tr { page-break-inside:avoid; }
td code, th code { font-size:0.86em; padding:0 3px; }
"""

INLINE_CODE = re.compile(r'`([^`]+)`')
BOLD = re.compile(r'\*\*([^*]+)\*\*')


def inline(text: str) -> str:
    """escape ก่อนเสมอ แล้วค่อยใส่แท็ก — กัน HTML จากเนื้อหาหลุดเข้าเอกสาร"""
    out = html.escape(text)
    out = INLINE_CODE.sub(lambda m: f'<code>{m.group(1)}</code>', out)
    out = BOLD.sub(lambda m: f'<strong>{m.group(1)}</strong>', out)
    return out


def split_row(line: str) -> list[str]:
    return [c.strip() for c in line.strip().strip('|').split('|')]


def convert(md: str) -> str:
    lines = md.split('\n')
    out: list[str] = []
    i = 0
    n = len(lines)

    while i < n:
        line = lines[i]

        # code fence
        if line.startswith('```'):
            i += 1
            buf = []
            while i < n and not lines[i].startswith('```'):
                buf.append(html.escape(lines[i]))
                i += 1
            i += 1
            out.append('<pre><code>' + '\n'.join(buf) + '</code></pre>')
            continue

        # ตาราง: ต้องมีบรรทัดคั่น --- ตามหลังหัวตาราง
        if line.startswith('|') and i + 1 < n and re.match(r'^\|[\s:|-]+\|$', lines[i + 1]):
            head = split_row(line)
            i += 2
            body = []
            while i < n and lines[i].startswith('|'):
                body.append(split_row(lines[i]))
                i += 1
            cells = ''.join(f'<th>{inline(c)}</th>' for c in head)
            rows = ''.join(
                '<tr>' + ''.join(f'<td>{inline(c)}</td>' for c in r) + '</tr>' for r in body
            )
            out.append(f'<table><thead><tr>{cells}</tr></thead><tbody>{rows}</tbody></table>')
            continue

        # heading
        m = re.match(r'^(#{1,4})\s+(.*)$', line)
        if m:
            level = len(m.group(1))
            out.append(f'<h{level}>{inline(m.group(2))}</h{level}>')
            i += 1
            continue

        # เส้นคั่น
        if re.match(r'^-{3,}$', line.strip()):
            out.append('<hr>')
            i += 1
            continue

        # list (เก็บทั้งบล็อกติดกัน)
        if re.match(r'^\s*[-*]\s+', line) or re.match(r'^\s*\d+\.\s+', line):
            ordered = bool(re.match(r'^\s*\d+\.\s+', line))
            items = []
            while i < n and (
                re.match(r'^\s*[-*]\s+', lines[i]) or re.match(r'^\s*\d+\.\s+', lines[i])
            ):
                items.append(re.sub(r'^\s*(?:[-*]|\d+\.)\s+', '', lines[i]))
                i += 1
            tag = 'ol' if ordered else 'ul'
            out.append(f'<{tag}>' + ''.join(f'<li>{inline(x)}</li>' for x in items) + f'</{tag}>')
            continue

        if line.strip() == '':
            i += 1
            continue

        out.append(f'<p>{inline(line)}</p>')
        i += 1

    return '\n'.join(out)


def main() -> None:
    src, dst, title = sys.argv[1], sys.argv[2], sys.argv[3]
    md = open(src, encoding='utf-8').read()
    page = (
        '<!doctype html><html lang="th"><head><meta charset="utf-8">'
        f'<title>{html.escape(title)}</title><style>{CSS}</style></head><body>'
        + convert(md)
        + '</body></html>'
    )
    open(dst, 'w', encoding='utf-8').write(page)
    print(f'เขียน {dst} ({len(page)} ตัวอักษร)')


if __name__ == '__main__':
    main()
