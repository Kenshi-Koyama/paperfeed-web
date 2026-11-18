// メモ・読書位置・表示設定の保存。
// 書いた内容はまずこの端末に残し（未送信の列）、Supabase へ送る。通信が切れていても消えない。
// PC とスマホで食い違ったときは、あとから保存された（updated_at が新しい）ほうを使う。

export function createSync(sb) {
  const QK = "pf:queue";
  let uid = null;
  let status = "ok"; // ok | saving | pending
  let flushing = false;
  const listeners = new Set();

  const readQ = () => { try { return JSON.parse(localStorage.getItem(QK) || "[]"); } catch (e) { return []; } };
  const writeQ = (q) => { try { localStorage.setItem(QK, JSON.stringify(q)); } catch (e) {} };
  const cacheGet = (k, d) => { try { const v = localStorage.getItem("pf:cache:" + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } };
  const cacheSet = (k, v) => { try { localStorage.setItem("pf:cache:" + k, JSON.stringify(v)); } catch (e) {} };
  const now = () => new Date().toISOString();

  function setStatus(s) { status = s; listeners.forEach((f) => f(s)); }

  function enqueue(id, table, conflict, row) {
    if (!uid) return;
    row = { ...row, user_id: uid, updated_at: now() };
    const q = readQ().filter((o) => o.id !== id);
    q.push({ id, table, conflict, row });
    writeQ(q);
    setStatus("saving");
    flush();
    return row;
  }

  async function flush() {
    if (flushing || !uid) return;
    flushing = true;
    try {
      for (;;) {
        const q = readQ();
        if (!q.length) { setStatus("ok"); return; }
        const op = q[0];
        const { error } = await sb.from(op.table).upsert(op.row, { onConflict: op.conflict });
        if (error) { setStatus("pending"); return; }
        // 送っている間に同じものが書き直されていたら、新しいほうを残す
        writeQ(readQ().filter((o) => !(o.id === op.id && o.row.updated_at === op.row.updated_at)));
      }
    } catch (e) {
      setStatus("pending");
    } finally {
      flushing = false;
      if (status !== "pending" && readQ().length) flush();
    }
  }

  addEventListener("online", flush);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") flush(); });

  return {
    status: () => status,
    onStatus(f) { listeners.add(f); return () => listeners.delete(f); },
    setUser(id) { uid = id; flush(); },

    saveNote(key, para, body) {
      const row = enqueue(`notes:${key}:${para}`, "notes", "user_id,zotero_key,para_id", { zotero_key: key, para_id: para, body });
      const c = cacheGet("notes:" + key, {});
      c[para] = { body, ts: row ? row.updated_at : now() };
      cacheSet("notes:" + key, c);
    },
    savePosition(key, para) {
      enqueue(`positions:${key}`, "positions", "user_id,zotero_key", { zotero_key: key, para_id: para });
      cacheSet("pos:" + key, { para_id: para, updated_at: now() });
    },
    saveAppState(key, mode, lang) {
      enqueue("app_state", "app_state", "user_id", { zotero_key: key, mode, settings: { lang } });
    },
    // 完読。外すときは done = false
    saveFinished(key, done) {
      const row = enqueue(`finished:${key}`, "finished", "user_id,zotero_key", { zotero_key: key, done, finished_at: done ? now() : null })
        || { zotero_key: key, done, finished_at: done ? now() : null, updated_at: now() };
      const c = cacheGet("finished", {});
      c[key] = row;
      cacheSet("finished", c);
      return row;
    },
    // 線。h = { id, zotero_key, para_id, start_pos, end_pos, quote, deleted }
    saveHighlight(h) {
      const row = enqueue(`highlights:${h.id}`, "highlights", "user_id,id", h) || { ...h, updated_at: now() };
      const c = cacheGet("hl:" + h.zotero_key, {});
      c[h.id] = row;
      cacheSet("hl:" + h.zotero_key, c);
    },

    // 完読した論文 { 番号: { done, finished_at, updated_at } }
    async loadFinished() {
      const r = await sb.from("finished").select("zotero_key,done,finished_at,updated_at");
      let map;
      if (r.error) map = cacheGet("finished", {});
      else {
        map = {};
        for (const x of r.data) map[x.zotero_key] = x;
        cacheSet("finished", map);
      }
      for (const o of readQ()) {
        if (o.table === "finished" && (!map[o.row.zotero_key] || o.row.updated_at > map[o.row.zotero_key].updated_at)) map[o.row.zotero_key] = o.row;
      }
      return map;
    },

    // 全体の状態（最後に読んだ論文・読み方・英日の設定）
    async loadState() {
      const r = await sb.from("app_state").select("zotero_key,mode,settings,updated_at").maybeSingle();
      let s = r.error ? cacheGet("state", null) : r.data;
      if (!r.error) cacheSet("state", s);
      const op = readQ().find((o) => o.id === "app_state");
      if (op && (!s || op.row.updated_at > s.updated_at)) s = op.row;
      return s;
    },

    // 1本の論文のメモ・位置・線
    async loadPaper(key) {
      const [n, p, h] = await Promise.all([
        sb.from("notes").select("para_id,body,updated_at").eq("zotero_key", key),
        sb.from("positions").select("para_id,updated_at").eq("zotero_key", key).maybeSingle(),
        sb.from("highlights").select("id,zotero_key,para_id,start_pos,end_pos,quote,deleted,updated_at").eq("zotero_key", key),
      ]);
      let hl;
      if (h.error) hl = cacheGet("hl:" + key, {});
      else {
        hl = {};
        for (const x of h.data) hl[x.id] = x;
        cacheSet("hl:" + key, hl);
      }
      let notes;
      if (n.error) notes = cacheGet("notes:" + key, {});
      else {
        notes = {};
        for (const x of n.data) notes[x.para_id] = { body: x.body, ts: x.updated_at };
        cacheSet("notes:" + key, notes);
      }
      let pos = p.error ? cacheGet("pos:" + key, null) : p.data;
      if (!p.error) cacheSet("pos:" + key, pos);
      // 未送信のものが新しければ、それを使う
      for (const o of readQ()) {
        if (o.row.zotero_key !== key) continue;
        if (o.table === "notes" && (!notes[o.row.para_id] || o.row.updated_at > notes[o.row.para_id].ts)) {
          notes[o.row.para_id] = { body: o.row.body, ts: o.row.updated_at };
        }
        if (o.table === "positions" && (!pos || o.row.updated_at > pos.updated_at)) pos = o.row;
        if (o.table === "highlights" && (!hl[o.row.id] || o.row.updated_at > hl[o.row.id].updated_at)) hl[o.row.id] = o.row;
      }
      const highlights = Object.values(hl).filter((x) => !x.deleted);
      return { notes, position: pos ? pos.para_id : null, highlights };
    },
  };
}
