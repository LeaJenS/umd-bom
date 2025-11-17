// === Konfiguration ===========================================================
const SUPABASE_URL = "https://knwisdfowjvocuquwcyo.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imtud2lzZGZvd2p2b2N1cXV3Y3lvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjI5OTY1MDQsImV4cCI6MjA3ODU3MjUwNH0.jTi27OmqFwXTkzfWrMJHCdNrnZkxl3LIHgOocTyhhh0";
const SITE_ID = "prod";
const STORAGE_KEY = "umd.bom.v2.multi";

// === kleine Helfer ===========================================================
function debounce(fn, ms = 400) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

const STATUSES = ["Open", "Sample", "Order", "Delivered"];
function toEnglishStatus(s) {
  const t = String(s || "").trim();
  if (STATUSES.includes(t)) return t;
  if (t === "Offen") return "Open";
  if (t === "Bestellen") return "Order";
  if (t === "Geliefert") return "Delivered";
  return "Open";
}

const state = {
  assemblies: [],   // [{ id, name, items:[{id,selected,mpn,hersteller,shop,status,lager,benoetigt}] }]
  active: null,     // assembly id oder 'all' / 'order'
  query: "",
  order: { col: "mpn", dir: 1 },
  appTitle: "UMD - BOM",
};

const uid  = () => Math.random().toString(36).slice(2, 9);
const norm = (s) => (s ?? "").toString().toLowerCase();
const asNumber = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

function comparer(col, dir) {
  return (a, b) => {
    let va = a[col], vb = b[col];
    if (typeof va === "number" && typeof vb === "number") return (va - vb) * dir;
    va = norm(va); vb = norm(vb);
    if (va < vb) return -1 * dir;
    if (va > vb) return  1 * dir;
    return 0;
  };
}

function badge(status) {
  const span = document.createElement("span");
  span.className = "chip";
  span.textContent = toEnglishStatus(status || "Open");
  return span.outerHTML;
}

function statusEditor(item) {
  const cur = toEnglishStatus(item.status);
  const options = STATUSES
    .map(s => `<option ${s === cur ? "selected" : ""}>${s}</option>`)
    .join("");
  return `<select data-id="${item.id}" data-field="status">${options}</select>`;
}

function linkifyShop(shop) {
  if (!shop) return "";
  const s = String(shop);
  if (s.startsWith("http://") || s.startsWith("https://")) {
    try {
      const u = new URL(s);
      return `<a href="${u.href}" target="_blank" rel="noopener">${u.hostname}</a>`;
    } catch {
      return s;
    }
  }
  return s;
}

function escapeHTML(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

// === Supabase / Storage mit Fallback ========================================
let supabase = null;

async function initSupabase() {
  try {
    const { createClient } = await import("https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm");
    supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    console.log("[Supabase] initialisiert");
  } catch (e) {
    console.warn("[Supabase] konnte nicht geladen werden, benutze localStorage:", e);
    supabase = null;
  }
}

const ls = {
  get: async (k, fallback) => {
    if (k !== STORAGE_KEY) return fallback;
    // Fallback: localStorage
    if (!supabase) {
      try {
        const raw = localStorage.getItem(k);
        return raw ? JSON.parse(raw) : fallback;
      } catch {
        return fallback;
      }
    }
    // Supabase
    const { data, error } = await supabase
      .from("site_states")
      .select("state")
      .eq("id", SITE_ID)
      .maybeSingle();
    if (error) {
      console.warn("[Supabase] load error", error);
      return fallback;
    }
    return data?.state ?? fallback;
  },
  set: (() => {
    const save = async (k, v) => {
      if (k !== STORAGE_KEY) return;
      if (!supabase) {
        // Fallback: localStorage
        try {
          localStorage.setItem(k, JSON.stringify(v));
        } catch (e) {
          console.warn("[localStorage] save error", e);
        }
        return;
      }
      const { error } = await supabase
        .from("site_states")
        .upsert({ id: SITE_ID, state: v });
      if (error) console.warn("[Supabase] save error", error);
    };
    return debounce((k, v) => save(k, v), 500);
  })(),
};

function saveState() {
  ls.set(STORAGE_KEY, state);
}

// === Assemblies-API =========================================================
function addAssembly(name, presetItems = []) {
  const id = uid();
  const items = presetItems.map(p => ({
    id: uid(),
    selected: false,
    mpn: "",
    hersteller: "",
    shop: "",
    status: "Open",
    lager: 0,
    benoetigt: 0,
    ...p,
    status: toEnglishStatus(p.status ?? "Open"),
    lager: asNumber(p.lager ?? 0),
    benoetigt: asNumber(p.benoetigt ?? 0),
  }));
  state.assemblies.push({ id, name, items });
  state.active = id;
  saveState();
  renderAll();
}

function addPart(assemblyId, part) {
  const a = state.assemblies.find(x => x.id === assemblyId);
  if (!a) return;
  const item = {
    id: uid(),
    selected: false,
    mpn: part.mpn || "",
    hersteller: part.hersteller || "",
    shop: part.shop || "",
    status: toEnglishStatus(part.status ?? "Open"),
    lager: asNumber(part.lager ?? 0),
    benoetigt: asNumber(part.benoetigt ?? 0),
  };
  a.items.push(item);
  saveState();
  renderAll();
}

function deletePart(assemblyId, itemId) {
  const asm = state.assemblies.find(a => a.id === assemblyId)
    || state.assemblies.find(a => a.items.some(it => it.id === itemId));
  if (!asm) return;
  const idx = asm.items.findIndex(it => it.id === itemId);
  if (idx < 0) return;
  asm.items.splice(idx, 1);
  saveState();
  renderAll();
}

// === Laden des States =======================================================
async function loadState() {
  const loaded = await ls.get(STORAGE_KEY, null);
  if (loaded && loaded.assemblies) {
    Object.assign(state, loaded);
  }
  if (!state.assemblies || !state.assemblies.length) {
    addAssembly("Main", []);
  }
  for (const a of state.assemblies) {
    a.id = a.id || uid();
    a.name = a.name || "Main";
    a.items = (a.items || []).map(it => ({
      id: it.id || uid(),
      selected: !!it.selected,
      mpn: it.mpn || "",
      hersteller: it.hersteller || "",
      shop: it.shop || "",
      status: toEnglishStatus(it.status),
      lager: asNumber(it.lager),
      benoetigt: asNumber(it.benoetigt),
    }));
  }
  if (
    !state.active ||
    (state.active !== "all" &&
     state.active !== "order" &&
     !state.assemblies.some(a => a.id === state.active))
  ) {
    state.active = state.assemblies[0].id;
  }
  if (!state.appTitle) state.appTitle = "UMD - BOM";
}

// === Tabs, Views & Rendering ================================================
function setAppTitle() {
  const el = document.getElementById("appTitle");
  if (el) el.textContent = state.appTitle || "UMD - BOM";
}

function renderTabs() {
  const nav = document.getElementById("tabs");
  if (!nav) return;
  nav.innerHTML = "";

  for (const a of state.assemblies) {
    const t = document.createElement("a");
    t.href = "#" + a.id;
    t.className = "tab";
    t.textContent = a.name;
    if (state.active === a.id) t.setAttribute("aria-current","page");
    t.addEventListener("click", e => {
      e.preventDefault();
      state.active = a.id;
      renderAll();
    });
    nav.appendChild(t);
  }

  const allTab = document.createElement("a");
  allTab.href = "#all";
  allTab.className = "tab";
  allTab.textContent = "All parts";
  if (state.active === "all") allTab.setAttribute("aria-current","page");
  allTab.addEventListener("click", e => {
    e.preventDefault();
    state.active = "all";
    renderAll();
  });
  nav.appendChild(allTab);

  const orderTab = document.createElement("a");
  orderTab.href = "#order";
  orderTab.className = "tab";
  orderTab.textContent = "Order";
  if (state.active === "order") orderTab.setAttribute("aria-current","page");
  orderTab.addEventListener("click", e => {
    e.preventDefault();
    state.active = "order";
    renderAll();
  });
  nav.appendChild(orderTab);
}

function renderViews() {
  const container = document.getElementById("views");
  if (!container) return;
  container.innerHTML = "";

  const q = norm(state.query).trim();

  // --- View: All parts ------------------------------------------------------
  if (state.active === "all") {
    const all = state.assemblies.flatMap(a =>
      a.items.map(it => ({ ...it, _group: a.name, _aid: a.id }))
    );
    const rows = all.filter(r =>
      !q || [r._group, r.mpn, r.hersteller, r.shop, r.status, r.lager, r.benoetigt]
        .some(x => norm(x).includes(q))
    );
    rows.sort(comparer(state.order.col, state.order.dir));

    const panel = document.createElement("div");
    panel.className = "panel";
    panel.innerHTML = `
      <div class="toolbar"><span class="hint">${rows.length} part(s) total</span></div>
      <div style="overflow:auto">
        <table id="tblAll">
          <thead><tr>
            <th data-col="_group">Assembly <span class="arrow"></span></th>
            <th data-col="mpn">MPN <span class="arrow"></span></th>
            <th data-col="hersteller">Manufacturer <span class="arrow"></span></th>
            <th data-col="shop">Shop <span class="arrow"></span></th>
            <th data-col="status">Status <span class="arrow"></span></th>
            <th data-col="lager" class="num">Stock <span class="arrow"></span></th>
            <th data-col="benoetigt" class="num">Required <span class="arrow"></span></th>
          </tr></thead>
          <tbody></tbody>
        </table>
      </div>`;
    container.appendChild(panel);

    const tbody = panel.querySelector("tbody");
    if (!rows.length) {
      const tr = document.createElement("tr");
      tr.innerHTML = `<td colspan="7" class="hint">No parts yet. Use "New part" or "Add multiple parts".</td>`;
      tbody.appendChild(tr);
    } else {
      for (const r of rows) {
        const tr = document.createElement("tr");
        tr.innerHTML = `
          <td>${escapeHTML(r._group)}</td>
          <td>${escapeHTML(r.mpn || "")}</td>
          <td>${escapeHTML(r.hersteller || "")}</td>
          <td>${linkifyShop(r.shop)}</td>
          <td>${badge(r.status)}</td>
          <td class="num">${r.lager}</td>
          <td class="num">${r.benoetigt}</td>`;
        tbody.appendChild(tr);
      }
    }

    panel.querySelectorAll("th[data-col]").forEach(th => {
      const col = th.getAttribute("data-col");
      const arrow = th.querySelector(".arrow");
      if (arrow) arrow.textContent =
        state.order.col === col ? (state.order.dir === 1 ? "▲" : "▼") : "";
    });
    panel.querySelector("thead").addEventListener("click", e => {
      const th = e.target.closest("th[data-col]");
      if (!th) return;
      const col = th.getAttribute("data-col");
      if (state.order.col === col) state.order.dir *= -1;
      else { state.order.col = col; state.order.dir = 1; }
      renderAll();
    });
    return;
  }

  // --- View: Order ----------------------------------------------------------
  if (state.active === "order") {
    const all = state.assemblies.flatMap(a =>
      a.items.map(it => ({ ...it, _group: a.name, _aid: a.id }))
    ).filter(x => x.selected);
    const rows = all.filter(r =>
      !q || [r._group, r.mpn, r.hersteller, r.shop, r.status, r.lager, r.benoetigt]
        .some(x => norm(x).includes(q))
    );
    rows.sort(comparer(state.order.col, state.order.dir));

    const panel = document.createElement("div");
    panel.className = "panel";
    panel.innerHTML = `
      <div class="toolbar">
        <span class="hint">${rows.length} part(s) selected for order</span>
        <button id="clearAll" class="btn small" style="margin-left:auto">Uncheck all</button>
      </div>
      <div style="overflow:auto">
        <table id="tblOrder">
          <thead><tr>
            <th>✓</th>
            <th data-col="_group">Assembly <span class="arrow"></span></th>
            <th data-col="mpn">MPN <span class="arrow"></span></th>
            <th data-col="hersteller">Manufacturer <span class="arrow"></span></th>
            <th data-col="shop">Shop <span class="arrow"></span></th>
            <th data-col="status">Status <span class="arrow"></span></th>
            <th data-col="lager" class="num">Stock <span class="arrow"></span></th>
            <th data-col="benoetigt" class="num">Required <span class="arrow"></span></th>
          </tr></thead>
          <tbody></tbody>
        </table>
      </div>`;
    container.appendChild(panel);

    const tbody = panel.querySelector("tbody");
    if (!rows.length) {
      const tr = document.createElement("tr");
      tr.innerHTML = `<td colspan="8" class="hint">No parts selected. Tick the checkbox next to parts in an assembly.</td>`;
      tbody.appendChild(tr);
    } else {
      for (const r of rows) {
        const tr = document.createElement("tr");
        tr.innerHTML = `
          <td class="center"><input type="checkbox" data-id="${r.id}" checked></td>
          <td>${escapeHTML(r._group)}</td>
          <td>${escapeHTML(r.mpn || "")}</td>
          <td>${escapeHTML(r.hersteller || "")}</td>
          <td>${linkifyShop(r.shop)}</td>
          <td>${badge(r.status)}</td>
          <td class="num">${r.lager}</td>
          <td class="num">${r.benoetigt}</td>`;
        tbody.appendChild(tr);
      }
    }

    panel.addEventListener("change", e => {
      const cb = e.target.closest('input[type="checkbox"][data-id]');
      if (!cb) return;
      const id = cb.getAttribute("data-id");
      for (const a of state.assemblies) {
        const it = a.items.find(x => x.id === id);
        if (it) { it.selected = cb.checked; break; }
      }
      saveState();
      renderAll();
    });

    panel.querySelector("#clearAll")?.addEventListener("click", () => {
      if (!confirm("Uncheck all selected items?")) return;
      for (const a of state.assemblies) {
        for (const it of a.items) it.selected = false;
      }
      saveState();
      renderAll();
    });

    panel.querySelectorAll("th[data-col]").forEach(th => {
      const col = th.getAttribute("data-col");
      const arrow = th.querySelector(".arrow");
      if (arrow) arrow.textContent =
        state.order.col === col ? (state.order.dir === 1 ? "▲" : "▼") : "";
    });
    panel.querySelector("thead").addEventListener("click", e => {
      const th = e.target.closest("th[data-col]");
      if (!th) return;
      const col = th.getAttribute("data-col");
      if (state.order.col === col) state.order.dir *= -1;
      else { state.order.col = col; state.order.dir = 1; }
      renderAll();
    });
    return;
  }

  // --- View: einzelnes Assembly --------------------------------------------
  const assembly = state.assemblies.find(a => a.id === state.active) || state.assemblies[0];
  if (!assembly) return;

  const rows = assembly.items.filter(r =>
    !q || [r.mpn, r.hersteller, r.shop, r.status, r.lager, r.benoetigt]
      .some(x => norm(x).includes(q))
  );
  rows.sort(comparer(state.order.col, state.order.dir));

  const panel = document.createElement("div");
  panel.className = "panel";
  panel.innerHTML = `
    <div class="toolbar"><span class="hint">${rows.length} part(s) in “${escapeHTML(assembly.name)}”</span></div>
    <div style="overflow:auto">
      <table id="tblAsm">
        <thead><tr>
          <th></th>
          <th data-col="mpn">MPN <span class="arrow"></span></th>
          <th data-col="hersteller">Manufacturer <span class="arrow"></span></th>
          <th data-col="shop">Shop <span class="arrow"></span></th>
          <th data-col="status">Status <span class="arrow"></span></th>
          <th data-col="lager" class="num">Stock <span class="arrow"></span></th>
          <th data-col="benoetigt" class="num">Required <span class="arrow"></span></th>
          <th>Delete</th>
        </tr></thead>
        <tbody></tbody>
      </table>
    </div>`;
  container.appendChild(panel);

  const tbodyAsm = panel.querySelector("tbody");
  if (!rows.length) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td colspan="8" class="hint">No parts yet. Use "New part" or "Add multiple parts".</td>`;
    tbodyAsm.appendChild(tr);
  } else {
    for (const r of rows) {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td class="center"><input type="checkbox" data-id="${r.id}" ${r.selected ? "checked" : ""}></td>
        <td contenteditable="true" data-field="mpn" data-id="${r.id}">${escapeHTML(r.mpn || "")}</td>
        <td contenteditable="true" data-field="hersteller" data-id="${r.id}">${escapeHTML(r.hersteller || "")}</td>
        <td contenteditable="true" data-field="shop" data-id="${r.id}">${escapeHTML(r.shop || "")}</td>
        <td>${statusEditor(r)}</td>
        <td class="num" contenteditable="true" data-field="lager" data-id="${r.id}">${r.lager}</td>
        <td class="num" contenteditable="true" data-field="benoetigt" data-id="${r.id}">${r.benoetigt}</td>
        <td class="center"><button class="btn ghost btnDel" data-id="${r.id}">🗑️</button></td>`;
      tbodyAsm.appendChild(tr);
    }
  }

  panel.addEventListener("change", e => {
    const cb = e.target.closest('input[type="checkbox"][data-id]');
    if (cb) {
      const item = assembly.items.find(it => it.id === cb.getAttribute("data-id"));
      if (!item) return;
      item.selected = cb.checked;
      saveState();
      return;
    }
    const sel = e.target.closest('select[data-id][data-field="status"]');
    if (sel) {
      const id = sel.getAttribute("data-id");
      const item = assembly.items.find(it => it.id === id);
      if (!item) return;
      item.status = toEnglishStatus(sel.value);
      saveState();
      renderAll();
    }
  });

  panel.addEventListener("click", e => {
    const btn = e.target.closest(".btnDel");
    if (!btn) return;
    const id = btn.getAttribute("data-id");
    deletePart(assembly.id, id);
  });

  panel.querySelector("#tblAsm tbody").addEventListener("blur", e => {
    const cell = e.target.closest("[contenteditable][data-id][data-field]");
    if (!cell) return;
    const id = cell.getAttribute("data-id");
    const field = cell.getAttribute("data-field");
    const item = assembly.items.find(it => it.id === id);
    if (!item) return;
    let val = cell.textContent.trim();
    if (field === "lager" || field === "benoetigt") {
      item[field] = asNumber(val);
      cell.textContent = item[field];
    } else {
      item[field] = val;
      cell.textContent = val;
    }
    saveState();
  }, true);

  panel.querySelectorAll("th[data-col]").forEach(th => {
    const col = th.getAttribute("data-col");
    const arrow = th.querySelector(".arrow");
    if (arrow) arrow.textContent =
      state.order.col === col ? (state.order.dir === 1 ? "▲" : "▼") : "";
  });
  panel.querySelector("thead").addEventListener("click", e => {
    const th = e.target.closest("th[data-col]");
    if (!th) return;
    const col = th.getAttribute("data-col");
    if (state.order.col === col) state.order.dir *= -1;
    else { state.order.col = col; state.order.dir = 1; }
    renderAll();
  });
}

function renderAll() {
  setAppTitle();
  renderTabs();
  renderViews();
}

// === Modals & Aktionen ======================================================
function openModal(sel) {
  const m = document.querySelector(sel);
  if (!m) return;
  m.classList.add("open");
  const first = m.querySelector("input,textarea,select");
  if (first) first.focus();
}

function closeModal(sel) {
  const m = document.querySelector(sel);
  if (!m) return;
  m.classList.remove("open");
}

function setupActions() {
  const q = document.getElementById("q");
  if (q) {
    q.addEventListener("input", e => {
      state.query = e.target.value;
      renderAll();
    });
  }

  const reset = document.getElementById("resetView");
  if (reset) {
    reset.addEventListener("click", () => {
      state.query = "";
      state.order = { col: "mpn", dir: 1 };
      if (q) q.value = "";
      renderAll();
    });
  }

  document.getElementById("addPart")?.addEventListener("click", () => openModal("#modalPart"));
  document.getElementById("bulkAdd")?.addEventListener("click", () => openModal("#modalBulk"));

  document.getElementById("editAppTitle")?.addEventListener("click", () => {
    const inp = document.getElementById("appTitleInput");
    if (inp) inp.value = state.appTitle || "";
    openModal("#modalAppTitle");
  });

  document.getElementById("renameAssemblyBtnBottom")?.addEventListener("click", () => {
    const sel = document.getElementById("renameSelect");
    if (sel) {
      sel.innerHTML = "";
      for (const a of state.assemblies) {
        const opt = document.createElement("option");
        opt.value = a.id;
        opt.textContent = a.name;
        if (a.id === state.active) opt.selected = true;
        sel.appendChild(opt);
      }
    }
    const name = document.getElementById("renameName");
    if (name) {
      const a = state.assemblies.find(x => x.id === state.active) || state.assemblies[0];
      name.value = a ? a.name : "";
    }
    openModal("#modalRename");
  });

  document.getElementById("addAssemblyBtn")?.addEventListener("click", () => {
    const inp = document.getElementById("newAsmName");
    if (inp) inp.value = "";
    openModal("#modalAddAssembly");
  });

  document.getElementById("savePart")?.addEventListener("click", () => {
    const asm = state.assemblies.find(a => a.id === state.active) || state.assemblies[0];
    if (!asm) return;
    const mpn = document.getElementById("partMPN").value.trim();
    if (!mpn) return alert("Please enter an MPN");
    const manu  = document.getElementById("partManu").value.trim();
    const shop  = document.getElementById("partShop").value.trim();
    const status = document.getElementById("partStatus").value || "Open";
    const stock  = asNumber(document.getElementById("partStock").value);
    const required = asNumber(document.getElementById("partRequired")?.value || 0);
    addPart(asm.id, {
      mpn,
      hersteller: manu,
      shop,
      status,
      lager: stock,
      benoetigt: required,
    });
    closeModal("#modalPart");
  });

  document.getElementById("saveAppTitle")?.addEventListener("click", () => {
    const inp = document.getElementById("appTitleInput");
    if (inp) {
      state.appTitle = inp.value.trim() || "UMD - BOM";
      saveState();
      renderAll();
    }
    closeModal("#modalAppTitle");
  });

  document.getElementById("saveRename")?.addEventListener("click", () => {
    const sel = document.getElementById("renameSelect");
    const nameInput = document.getElementById("renameName");
    if (!sel || !nameInput) return;
    const id = sel.value;
    const a = state.assemblies.find(x => x.id === id);
    if (!a) return;
    a.name = nameInput.value.trim() || a.name;
    saveState();
    closeModal("#modalRename");
    renderAll();
  });

  document.getElementById("saveAddAssembly")?.addEventListener("click", () => {
    const inp = document.getElementById("newAsmName");
    const name = (inp?.value.trim()) || `Assembly ${state.assemblies.length + 1}`;
    addAssembly(name, []);
    closeModal("#modalAddAssembly");
  });

  // Bulk add
  document.getElementById("previewBulk")?.addEventListener("click", () => {
    const txt = document.getElementById("bulkText").value.trim();
    const info = document.getElementById("bulkPreview");
    if (!info) return;
    if (!txt) { info.textContent = "Nothing to parse."; return; }
    const lines = txt.split(/\r?\n/).filter(Boolean);
    info.textContent = `Detected ${lines.length} row(s). Click “Insert” to add.`;
  });

  document.getElementById("applyBulk")?.addEventListener("click", () => {
    const asm = state.assemblies.find(a => a.id === state.active) || state.assemblies[0];
    if (!asm) return;
    const txt = document.getElementById("bulkText").value.trim();
    if (!txt) { closeModal("#modalBulk"); return; }
    const delimSel = document.getElementById("bulkDelimiter").value;
    let delim = delimSel === "auto" ? null : delimSel;
    const lines = txt.split(/\r?\n/).filter(Boolean);
    const parts = [];
    for (const line of lines) {
      let d = delim;
      if (!d) {
        if (line.includes("\t")) d = "\t";
        else if (line.includes(";")) d = ";";
        else d = ",";
      }
      const cols = line.split(d).map(s => s.trim());
      const [mpn, manu, shop, status="Open", stock="0", required="0"] = cols;
      if (!mpn && !manu) continue;
      parts.push({
        mpn,
        hersteller: manu,
        shop,
        status,
        lager: asNumber(stock),
        benoetigt: asNumber(required),
      });
    }
    for (const p of parts) addPart(asm.id, p);
    closeModal("#modalBulk");
  });

  // generische Close-Buttons
  document.addEventListener("click", e => {
    const btn = e.target.closest("[data-close]");
    if (!btn) return;
    const sel = btn.getAttribute("data-close");
    if (sel) closeModal(sel);
  });
}

// === Realtime nur, wenn Supabase ok =========================================
function subscribeRealtime(onRemoteUpdate) {
  if (!supabase) return; // kein Supabase → kein Realtime
  supabase.channel("realtime:site_states")
    .on("postgres_changes", {
      event: "*",
      schema: "public",
      table: "site_states",
      filter: `id=eq.${SITE_ID}`,
    }, payload => {
      if (payload?.new?.state) {
        console.log("[Supabase] realtime update received");
        onRemoteUpdate(payload.new.state);
      }
    })
    .subscribe();
}

// === Setup ===================================================================
async function setup() {
  console.log("setup startet");
  await initSupabase();    // Supabase versuchen, sonst localStorage
  await loadState();       // state aus Supabase oder localStorage
  renderAll();
  setupActions();
  subscribeRealtime(remote => {
    Object.assign(state, remote);
    renderAll();
  });
  saveState();             // einmal initial speichern
}

document.addEventListener("DOMContentLoaded", () => {
  setup();
});
