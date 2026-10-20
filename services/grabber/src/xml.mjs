// Minimal, dependency-free XML parser (enough for DASH MPD manifests).
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
export const decodeEntities = s => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => e[0] === '#' ? String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : (ENT[e] ?? m));

export function parseXml(text) {
  const root = { name: '#root', attrs: {}, children: [], text: '' };
  const stack = [root]; let i = 0; const n = text.length;
  while (i < n) {
    const lt = text.indexOf('<', i);
    if (lt < 0) { stack.at(-1).text += decodeEntities(text.slice(i)); break; }
    if (lt > i) stack.at(-1).text += decodeEntities(text.slice(i, lt));
    if (text.startsWith('<!--', lt)) { const e = text.indexOf('-->', lt); i = e < 0 ? n : e + 3; continue; }
    if (text.startsWith('<![CDATA[', lt)) { const e = text.indexOf(']]>', lt); stack.at(-1).text += text.slice(lt + 9, e < 0 ? n : e); i = e < 0 ? n : e + 3; continue; }
    if (text[lt + 1] === '?' || text[lt + 1] === '!') { const e = text.indexOf('>', lt); i = e < 0 ? n : e + 1; continue; }
    if (text[lt + 1] === '/') { const e = text.indexOf('>', lt); const name = text.slice(lt + 2, e).trim(); while (stack.length > 1) { const top = stack.pop(); if (top.name === name) break; } i = e + 1; continue; }
    // start tag: scan respecting quotes
    let j = lt + 1, q = null;
    while (j < n) { const c = text[j]; if (q) { if (c === q) q = null; } else if (c === '"' || c === "'") q = c; else if (c === '>') break; j++; }
    let body = text.slice(lt + 1, j); const selfClose = body.endsWith('/'); if (selfClose) body = body.slice(0, -1);
    const m = /^([^\s/>]+)/.exec(body); const name = m ? m[1] : '';
    const attrs = {}; const re = /([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/g; let a;
    const rest = body.slice(name.length);
    while ((a = re.exec(rest))) attrs[a[1]] = decodeEntities(a[3] ?? a[4] ?? '');
    const el = { name: name.replace(/^[^:]+:/, ''), attrs, children: [], text: '' };
    stack.at(-1).children.push(el);
    if (!selfClose) stack.push(el);
    i = j + 1;
  }
  return root.children.find(c => c.name) || root;
}

export const kids = (el, name) => (el?.children || []).filter(c => c.name === name);
export const kid = (el, name) => (el?.children || []).find(c => c.name === name);
