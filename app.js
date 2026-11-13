// PaperFeed の画面。ログイン → 論文のリスト → 精読。
// 本文・画像・PDF は Supabase の非公開の置き場から、ログイン後に取得する。
import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm";
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from "./config.js";
import { createSync } from "./sync.js";

const sb = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
const sync = createSync(sb);
const SYNC_LABEL = { ok: "保存済み", saving: "保存中…", pending: "未送信（通信が戻ると保存します）" };
sync.onStatus((st) => { const e = $("#sync"); if (e) { e.textContent = SYNC_LABEL[st]; e.dataset.s = st; } });
const BUCKET = "papers";
const SIGN_SECONDS = 6 * 3600;

function $(s, r = document) { return r.querySelector(s); }
const el = (tag, cls, html) => { const n = document.createElement(tag); if (cls) n.className = cls; if (html != null) n.innerHTML = html; return n; };
const app = $("#app");

// 文字列を安全にする（<sub> と <sup> だけ残す）
const safe = (s) => (s || "").replace(/&(?!(?:lt|gt|amp|quot|#\d+);)/g, "&amp;").replace(/<(?!\/?(?:sub|sup)>)/g, "&lt;");
const attr = (s) => String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;");

// 設定の保存（この端末だけ。段4-3で Supabase に移す）
const pref = {
  get(k, d) { try { const v = localStorage.getItem("pf:" + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem("pf:" + k, JSON.stringify(v)); } catch (e) {} },
};

let view = null; // 今の画面の後始末用
function newView() {
  if (view) view.abort();
  view = new AbortController();
  document.body.classList.remove("toc-open");
  const d = $("#dlg"); if (d.open) d.close();
  return view.signal;
}

// ---------------- 経路
async function route() {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) return showLogin();
  sync.setUser(session.user.id);
  const m = location.hash.match(/^#\/p\/([A-Za-z0-9]+)(?:\/([\w-]+))?/);
  if (m) return showPaper(session.user.id, m[1], m[2]);
  return showList();
}
addEventListener("hashchange", route);
sb.auth.onAuthStateChange((ev) => { if (ev === "SIGNED_OUT") route(); });

// ---------------- ログイン
function showLogin() {
  newView();
  document.title = "PaperFeed";
  app.innerHTML = `<form class="center" id="loginForm">
    <h1>PaperFeed</h1>
    <label for="em">メールアドレス</label><input id="em" type="email" autocomplete="username" required>
    <label for="pw">パスワード</label><input id="pw" type="password" autocomplete="current-password" required>
    <button class="btn" type="submit">ログイン</button>
    <div class="err" id="err" role="alert"></div></form>`;
  $("#loginForm").onsubmit = async (ev) => {
    ev.preventDefault();
    const btn = $(".btn"); btn.disabled = true; $("#err").textContent = "";
    const { error } = await sb.auth.signInWithPassword({ email: $("#em").value.trim(), password: $("#pw").value });
    btn.disabled = false;
    if (error) { $("#err").textContent = "ログインできませんでした。メールアドレスとパスワードを確かめてください。"; return; }
    route();
  };
}

// ---------------- 論文のリスト
async function showList() {
  newView();
  document.title = "PaperFeed";
  app.innerHTML = `<div class="list"><div class="top"><h1>精読する論文</h1><button class="icon" id="out">ログアウト</button></div><div id="items" class="msg">読み込み中…</div></div>`;
  $("#out").onclick = () => sb.auth.signOut();
  const [{ data, error }, state] = await Promise.all([
    sb.from("papers").select("zotero_key,title,authors,journal,year,tags,has_fulltext").order("updated_at", { ascending: false }),
    sync.loadState(),
  ]);
  const box = $("#items");
  if (error) { box.textContent = "論文の一覧を取得できませんでした。"; return; }
  const rows = data.filter((p) => p.has_fulltext && (p.tags || []).includes("PaperFeed_CloseReading"));
  if (!rows.length) { box.textContent = "精読できる論文がまだありません。"; return; }
  box.className = ""; box.innerHTML = "";
  const last = state && rows.find((p) => p.zotero_key === state.zotero_key);
  if (last) {
    const c = el("div", "resume");
    c.innerHTML = `<div class="lab">続きから読む</div><a class="t" href="#/p/${last.zotero_key}">${safe(last.title)}</a>
      <div class="m">${safe(last.authors)} · ${safe(last.journal)} (${last.year || ""})</div>
      <div class="acts"><a class="btn go" href="#/p/${last.zotero_key}">続きを読む</a><a class="icon" href="#/p/${last.zotero_key}/top">最初から読む</a></div>`;
    box.append(c);
    box.append(el("div", "sub", "ほかの論文"));
  }
  for (const p of rows) {
    if (p === last) continue;
    const a = el("a", "item");
    a.href = "#/p/" + p.zotero_key;
    a.innerHTML = `<div class="t">${safe(p.title)}</div><div class="m">${safe(p.authors)} · ${safe(p.journal)} (${p.year || ""})</div>`;
    box.append(a);
  }
}

// ---------------- 精読
async function showPaper(uid, key, jumpTo) {
  const signal = newView();
  app.innerHTML = `<div class="msg">読み込み中…</div>`;
  const base = `${uid}/${key}`;
  const dl = await sb.storage.from(BUCKET).download(`${base}/paper.json`);
  if (signal.aborted) return;
  if (dl.error) { app.innerHTML = `<div class="msg">この論文を開けませんでした。<br><a href="#/">一覧へ戻る</a></div>`; return; }
  const P = JSON.parse(await dl.data.text());
  const saved = await sync.loadPaper(key);
  const state = await sync.loadState();
  if (signal.aborted) return;
  const notes = saved.notes; // { 段落の番号: { body, ts } }

  // 画像と PDF は、期限付きの URL で取得する
  const imgPaths = [...P.floats.map((f) => f.image), ...P.elements.filter((e) => e.type === "equation").map((e) => e.image)].filter(Boolean);
  const imgUrl = {};
  if (imgPaths.length) {
    const r = await sb.storage.from(BUCKET).createSignedUrls(imgPaths.map((p) => `${base}/${p}`), SIGN_SECONDS);
    (r.data || []).forEach((x, i) => { if (x.signedUrl) imgUrl[imgPaths[i]] = x.signedUrl; });
  }
  const pdf = await sb.storage.from(BUCKET).createSignedUrl(`${base}/original.pdf`, SIGN_SECONDS);
  const pdfUrl = pdf.data ? pdf.data.signedUrl : null;
  if (signal.aborted) return;
  const pdfLink = (page, text) => pdfUrl ? `<a href="${attr(pdfUrl)}#page=${page}" target="_blank" rel="noopener">${text}</a>` : "";

  const floatById = Object.fromEntries(P.floats.map((f) => [f.id, f]));
  const linkify = (html) => html.replace(/(Table|Fig\.|Figure)\s+(A?\d+)/g, (m, k, n) => {
    const id = (/^Fig/.test(k) ? "fig" : "table") + n;
    return floatById[id] ? `<a class="fref" data-float="${id}" href="#/p/${key}/${id}">${m}</a>` : m;
  });
  const rich = (s) => linkify(safe(s));

  app.innerHTML = `<div class="bar">
      <a class="icon" href="#/" style="text-decoration:none;color:inherit">一覧</a>
      <button class="icon" id="tocBtn" aria-label="目次を開く">目次</button>
      <div class="ttl" id="barTitle"></div>
      <div class="seg" role="group" aria-label="表示する言語">
        <button data-mode="en">English</button><button data-mode="ja">日本語</button><button data-mode="both">両方</button>
      </div><div class="sync" id="sync" role="status"></div><div class="prog" id="prog"></div></div>
    <nav class="toc" id="toc" aria-label="目次"></nav><div class="shade" id="shade"></div><main id="main"></main>`;
  const main = $("#main"), toc = $("#toc");
  const m = P.meta;
  $("#sync").textContent = SYNC_LABEL[sync.status()]; $("#sync").dataset.s = sync.status();
  $("#barTitle").textContent = m.title;
  document.title = m.title + " — PaperFeed";

  // 表紙・要約カード・要旨
  const head = el("header", "paper");
  head.innerHTML = `<h1>${safe(m.title)}</h1><p class="tja">${safe(m.title_ja)}</p>
    <p class="by">${safe((m.authors || []).join(", "))} · ${safe(m.journal)} ${m.volume || ""} (${m.year}) ${m.pages || ""} ${pdfUrl ? "· " + pdfLink(1, "元の PDF を開く") : ""}</p>`;
  main.append(head);
  const whole = el("details", "card"); whole.id = "paperMemo";
  whole.innerHTML = `<summary>この論文のメモ</summary><div class="memo" style="margin-top:.6rem"></div>`;
  main.append(whole);
  if (P.summary) {
    const card = el("details", "card"); card.open = true;
    const labelsJa = { rq: "何を明らかにするか", motivation: "なぜ必要か", method: "方法", results: "結果", point: "要点" };
    card.innerHTML = "<summary>要約カード</summary><dl>" + P.summary.items.map((it) =>
      `<dt>${it.label}（${labelsJa[it.key] || ""}）</dt><dd><div>${rich(it.ja)}</div><div class="en">${rich(it.en)}</div>
       <div class="where">該当箇所：${it.refs.map((r) => `<a href="#/p/${key}/${r}" data-jump="${r}">${r}</a>`).join("")}</div></dd>`).join("") + "</dl>";
    main.append(card);
  }
  if (P.abstract) {
    const ab = el("details", "card"); ab.open = true;
    ab.innerHTML = `<summary>Abstract ／ 要旨</summary><div class="unit" id="abstract" style="margin-top:.8rem"><span class="num"></span>
      <div class="en" lang="en">${rich(P.abstract)}</div><div class="ja">${rich(P.abstract_ja)}</div></div>`;
    main.append(ab);
  }

  // 図表
  const floatNode = (f) => {
    const fig = el("figure", "float"); fig.id = f.id;
    fig.innerHTML = `<div class="cap sw"><span class="lab">${safe(f.label)}</span><span class="en" lang="en">${safe(f.title)}</span>
      <span class="ja"> ${safe(f.title_ja)}</span></div>
      <div class="scroll"><img src="${attr(imgUrl[f.image] || "")}" alt="${attr(f.label)}" loading="lazy"></div>
      ${f.note ? `<div class="note sw"><div class="en" lang="en">${safe(f.note)}</div><div class="ja">${safe(f.note_ja)}</div></div>` : ""}
      ${pdfUrl ? `<div class="src">${pdfLink(f.page, "PDF の " + f.page + " ページで見る")}</div>` : ""}`;
    return fig;
  };
  const appendixHead = P.elements.find((e) => e.type === "heading" && /^Appendix/.test(e.text));
  const inAppendix = (f) => appendixHead && f.page >= appendixHead.page;
  const placed = new Set();
  const mentions = (e, f) => {
    const text = e.text || (e.items || []).join(" ");
    return new RegExp(f.label.replace(".", "\\.").replace(/\s+/, "\\s+") + "(?!\\d)").test(text);
  };

  // 本文
  let lastPage = null;
  const tocItems = [];
  for (const e of P.elements) {
    if (lastPage !== null && e.page !== lastPage && pdfUrl) main.append(el("div", "pg", pdfLink(e.page, "PDF p." + e.page)));
    lastPage = e.page;
    if (e.type === "heading") {
      const h = el(e.level === 1 ? "h2" : "h3", "h sw"); h.id = e.id;
      h.innerHTML = `<span class="en" lang="en">${safe(e.text)}</span><span class="ja">${safe(e.text_ja)}</span>`;
      main.append(h); tocItems.push(e);
      if (e === appendixHead) for (const f of P.floats) if (inAppendix(f)) { main.append(floatNode(f)); placed.add(f.id); }
      continue;
    }
    if (e.type === "equation") {
      const fig = el("figure", "eq"); fig.id = e.id;
      fig.innerHTML = `<div class="scroll"><img src="${attr(imgUrl[e.image] || "")}" alt="数式"></div>`;
      main.append(fig); continue;
    }
    const u = el("div", "unit"); u.id = e.id;
    const en = e.type === "list" ? "<ul>" + e.items.map((x) => `<li>${rich(x)}</li>`).join("") + "</ul>" : rich(e.text);
    const ja = e.type === "list" ? "<ul>" + (e.items_ja || []).map((x) => `<li>${rich(x)}</li>`).join("") + "</ul>" : rich(e.text_ja);
    u.innerHTML = `<button class="num" title="メモを書く" aria-label="段落 ${e.n || ""} にメモを書く">${e.n || "·"}</button><div class="en" lang="en">${en}</div><div class="ja">${ja}</div>`;
    main.append(u); renderMemo(u);
    for (const f of P.floats) if (!placed.has(f.id) && !inAppendix(f) && mentions(e, f)) { main.append(floatNode(f)); placed.add(f.id); }
  }
  for (const f of P.floats) if (!placed.has(f.id)) main.append(floatNode(f));
  if (P.references && P.references.length) {
    const r = el("details", "refs"); r.id = "references";
    r.innerHTML = `<summary>References（${P.references.length}）</summary><ol>${P.references.map((x) => `<li>${safe(x)}</li>`).join("")}</ol>`;
    main.append(r);
  }

  // 目次
  const jl = (id, cls, text) => `<a class="${cls}" href="#/p/${key}/${id}" data-jump="${id}">${text}</a>`;
  toc.innerHTML = "<h3>節</h3>" + tocItems.map((e) => jl(e.id, "lv" + e.level, safe(e.text))).join("") +
    "<h3>図表</h3>" + P.floats.map((f) => jl(f.id, "", `${safe(f.label)}　${safe(f.title_ja || f.title)}`)).join("") +
    `<h3>そのほか</h3>${jl("references", "", "References")}${pdfUrl ? `<a href="${attr(pdfUrl)}" target="_blank" rel="noopener">元の PDF</a>` : ""}`;
  const closeToc = () => document.body.classList.remove("toc-open");
  $("#tocBtn").onclick = () => document.body.classList.toggle("toc-open");
  $("#shade").onclick = closeToc;
  toc.addEventListener("click", (ev) => { if (ev.target.closest("a")) closeToc(); });

  // 表示の切り替え
  const units = [...document.querySelectorAll("main .unit[id^='e']")];
  const currentUnit = () => units.find((u) => u.getBoundingClientRect().bottom > 80) || null;
  const setMode = (mode, save = true) => {
    const anchor = currentUnit();
    document.body.dataset.mode = mode;
    document.querySelectorAll(".seg button").forEach((b) => b.setAttribute("aria-pressed", b.dataset.mode === mode));
    document.querySelectorAll(".unit.flip").forEach((u) => u.classList.remove("flip"));
    pref.set("mode", mode);
    if (anchor) anchor.scrollIntoView({ block: "start" });
    if (save) sync.saveAppState(key, "CloseReading", mode);
  };
  document.querySelectorAll(".seg button").forEach((b) => (b.onclick = () => setMode(b.dataset.mode)));

  // 図表の窓・飛ぶ・段落ごとの言語の切り替え
  const dlg = $("#dlg");
  let dlgTarget = null;
  const jump = (id, smooth = true) => {
    const t = document.getElementById(id); if (!t) return;
    const d = t.closest("details"); if (d) d.open = true;
    t.scrollIntoView({ block: "start", behavior: smooth ? "smooth" : "auto" });
    t.classList.add("flash"); setTimeout(() => t.classList.remove("flash"), 1600);
  };
  const openFloat = (id) => {
    const src = document.getElementById(id); if (!src) return;
    dlgTarget = id;
    const body = $("#dlgBody"); body.innerHTML = ""; const copy = src.cloneNode(true); copy.removeAttribute("id"); body.append(copy);
    dlg.showModal();
  };
  $("#dlgClose").onclick = () => dlg.close();
  $("#dlgGo").onclick = () => { dlg.close(); jump(dlgTarget); };
  dlg.addEventListener("click", (ev) => { if (ev.target === dlg) dlg.close(); if (ev.target.tagName === "IMG") ev.target.classList.toggle("big"); }, { signal });
  document.addEventListener("click", (ev) => {
    if (!ev.target.closest("main, .toc")) return;
    const ref = ev.target.closest("a.fref");
    if (ref) { ev.preventDefault(); openFloat(ref.dataset.float); return; }
    const j = ev.target.closest("a[data-jump]");
    if (j) { ev.preventDefault(); jump(j.dataset.jump); return; }
    if (ev.target.tagName === "IMG" && ev.target.closest("figure.float")) { openFloat(ev.target.closest("figure.float").id); return; }
    const num = ev.target.closest(".num");
    if (num && num.closest(".unit[id^='e']")) { editMemo(num.closest(".unit")); return; }
    if (ev.target.closest("a, textarea, .memo")) return;
    const body = ev.target.closest(".unit > .en, .unit > .ja");
    if (body && document.body.dataset.mode !== "both" && !String(getSelection()).trim()) body.parentElement.classList.toggle("flip");
  }, { signal });
  let posTimer, lastSaved = saved.position, started = false;
  const savePos = () => {
    const u = currentUnit();
    if (u && u.id !== lastSaved) { lastSaved = u.id; sync.savePosition(key, u.id); }
  };
  addEventListener("scroll", () => {
    const h = document.documentElement;
    $("#prog").style.width = (100 * h.scrollTop / Math.max(1, h.scrollHeight - h.clientHeight)) + "%";
    clearTimeout(posTimer); if (started) posTimer = setTimeout(savePos, 1500);
  }, { passive: true, signal });
  addEventListener("pagehide", () => { clearTimeout(posTimer); if (started) savePos(); }, { signal });

  // メモ
  function memoBox(u) { let b = $(".memo", u); if (!b) { b = el("div", "memo"); u.append(b); } return b; }
  function renderMemo(u) {
    const text = (notes[u.id] || {}).body;
    $(".num", u).classList.toggle("has", !!text);
    const box = $(".memo", u);
    if (!text) { if (box) box.remove(); return; }
    const b = memoBox(u); b.innerHTML = "";
    const s = el("div", "saved"); s.textContent = text; s.title = "押して編集"; s.onclick = () => editMemo(u); b.append(s);
  }
  function editor(box, para, done) {
    if ($("textarea", box)) return;
    box.innerHTML = "";
    const ta = el("textarea"); ta.value = (notes[para] || {}).body || ""; ta.placeholder = "メモ（入力をやめると自動で保存）";
    box.append(ta); ta.focus();
    let timer;
    const save = () => {
      const v = ta.value.trim();
      if (v === ((notes[para] || {}).body || "")) return;
      notes[para] = { body: v, ts: new Date().toISOString() };
      sync.saveNote(key, para, v);
    };
    ta.oninput = () => { clearTimeout(timer); timer = setTimeout(save, 600); };
    ta.onblur = () => { clearTimeout(timer); save(); done(); };
  }
  function editMemo(u) { editor(memoBox(u), u.id, () => renderMemo(u)); }
  const pm = $(".memo", $("#paperMemo"));
  const renderPaperMemo = () => {
    const text = (notes[""] || {}).body;
    pm.innerHTML = "";
    const s = el("div", text ? "saved" : "saved empty"); s.textContent = text || "メモを書く"; s.onclick = () => editor(pm, "", renderPaperMemo); pm.append(s);
    $("#paperMemo > summary").textContent = text ? "この論文のメモ（あり）" : "この論文のメモ";
  };
  renderPaperMemo();

  const lang = (state && state.settings && state.settings.lang) || pref.get("mode", matchMedia("(min-width: 60rem)").matches ? "both" : "en");
  setMode(lang, false);
  sync.saveAppState(key, "CloseReading", lang); // 「最後に読んだ論文」として覚える
  const first = units[0] && units[0].id;
  if (jumpTo && jumpTo !== "top") { jump(jumpTo, false); }
  else if (!jumpTo && saved.position && saved.position !== first && document.getElementById(saved.position)) {
    document.getElementById(saved.position).scrollIntoView({ block: "start" });
    const e = P.elements.find((x) => x.id === saved.position);
    const toast = el("div", "toast", `<span>前回の続き（段落 ${(e && e.n) || ""}）から開きました</span><button>最初から読む</button>`);
    toast.style.display = "flex"; document.body.append(toast);
    toast.querySelector("button").onclick = () => { scrollTo({ top: 0 }); toast.remove(); };
    signal.addEventListener("abort", () => toast.remove());
    setTimeout(() => toast.remove(), 6000);
  } else { scrollTo({ top: 0 }); }
  setTimeout(() => { started = true; }, 800); // 開いた直後の位置の飛びは、読んだ位置として保存しない
}

route();
