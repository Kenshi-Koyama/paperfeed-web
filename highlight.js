// 英語の本文に引く線（蛍光ペン）の、位置の数え方と塗り方。
// 位置は「段落の英語の文字の、何文字目から何文字目の手前まで」で持つ。リンクや上付き文字の印は数えず、文字だけを数える。

function textNodes(root) {
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const out = [];
  while (w.nextNode()) out.push(w.currentNode);
  return out;
}

// root の頭から (node, off) までの文字数
export function offsetIn(root, node, off) {
  const r = document.createRange();
  r.selectNodeContents(root);
  r.setEnd(node, off);
  return r.toString().length;
}

// 選んだ範囲を、段落ごとの { el, start, end, quote } に分ける。
// containers は線を引ける要素（段落の英語）。見えていないもの（日本語だけの表示のときなど）は除く。前後の空白は含めない。
export function rangeParts(range, containers) {
  const out = [];
  for (const c of containers) {
    if (!range.intersectsNode(c) || !c.getClientRects().length) continue;
    const text = c.textContent;
    let s = c.contains(range.startContainer) ? offsetIn(c, range.startContainer, range.startOffset) : 0;
    let e = c.contains(range.endContainer) ? offsetIn(c, range.endContainer, range.endOffset) : text.length;
    while (s < e && /\s/.test(text[s])) s++;
    while (e > s && /\s/.test(text[e - 1])) e--;
    if (e > s) out.push({ el: c, start: s, end: e, quote: text.slice(s, e) });
  }
  return out;
}

// 線の位置を、いまの本文の中で決める。文字が合わなければ、同じ文字列を探し直す。見つからなければ null
export function locate(text, h) {
  if (text.slice(h.start_pos, h.end_pos) === h.quote) return [h.start_pos, h.end_pos];
  const i = h.quote ? text.indexOf(h.quote) : -1;
  return i >= 0 ? [i, i + h.quote.length] : null;
}

// root の中の [start, end) を <mark class="hl" data-hl="id"> で包む。リンクなどをまたぐときは分けて包む。最初の mark を返す
export function paint(root, start, end, id) {
  let pos = 0, first = null;
  for (const t of textNodes(root)) {
    const len = t.data.length, a = Math.max(start - pos, 0), b = Math.min(end - pos, len);
    pos += len;
    if (a >= b) continue;
    let node = t;
    if (a > 0) node = node.splitText(a);
    if (b - a < node.data.length) node.splitText(b - a);
    const m = document.createElement("mark");
    m.className = "hl";
    m.dataset.hl = id;
    node.parentNode.insertBefore(m, node);
    m.append(node);
    if (!first) first = m;
  }
  return first;
}
