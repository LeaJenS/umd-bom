import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm'

// === EDIT THESE TWO LINES WITH YOUR VALUES ===================================
// Put your Project URL from Supabase Settings → API (looks like https://xxxx.supabase.co)
const SUPABASE_URL = "https://knwisdfowjvocuquwcyo.supabase.co";    // <--- TODO: INSERT YOUR SUPABASE URL
// Put your 'anon public key' from Supabase Settings → API
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imtud2lzZGZvd2p2b2N1cXV3Y3lvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjI5OTY1MDQsImV4cCI6MjA3ODU3MjUwNH0.jTi27OmqFwXTkzfWrMJHCdNrnZkxl3LIHgOocTyhhh0";              // <--- TODO: INSERT YOUR ANON KEY
// Optional: change the site id (row key) if you want multiple environments
const SITE_ID = "prod";

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Debounce helper so we don't write on every keystroke
function debounce(fn, ms=400){ let t; return (...args)=>{ clearTimeout(t); t=setTimeout(()=>fn(...args), ms); }; }

// ===== Multi-assembly mode =====
    const SINGLE_MODE = false; // enable multiple assemblies

    // ===== Data model =====
    // assemblies[] with { id, name, items[] } where items have id, mpn, hersteller, shop, status, lager, selected

    /* Replaces localStorage with Supabase-backed JSON storage */
const ls = {
  // Load full state JSON from Supabase
  get: async (k, d) => {
    if (k !== 'umd.bom.v2.multi') return d;
    const { data, error } = await supabase
      .from('site_states')
      .select('state')
      .eq('id', SITE_ID)
      .maybeSingle();
    if (error) { console.warn('[Supabase] load error', error); return d; }
    return data?.state ?? d;
  },
  // Save state JSON to Supabase (debounced)
  set: (() => {
    const save = async (k, v) => {
      if (k !== 'umd.bom.v2.multi') return;
      const { error } = await supabase.from('site_states').upsert({ id: SITE_ID, state: v });
      if (error) console.warn('[Supabase] save error', error);
    };
    return debounce((k, v)=> save(k, v), 500);
  })()
};


    const STATUSES = ['Open','Sample','Order','Delivered'];
    function toEnglishStatus(s){
      const t = String(s || '').trim();
      if (t === 'Open' || t === 'Sample' || t === 'Order' || t === 'Delivered') return t;
      if (t === 'Offen') return 'Open';
      if (t === 'Bestellen') return 'Order';
      if (t === 'Geliefert') return 'Delivered';
      if (t === 'Sample') return 'Sample';
      return 'Open';
    }

    const state = {
      assemblies: [],       // [{ id, name, items: [] }]
      active: null,         // id of the active assembly or 'order'/'all'
      query: '',
      order: { col: 'mpn', dir: 1 },
      showSelectedOnly: false,
      appTitle: 'UMD – Accumulator'
    };

    // Demo seed
    function seed() { addAssembly('Main', []); }

    // Utils
    const uid = () => Math.random().toString(36).slice(2, 9);
    const norm = s => (s+ '').normalize('NFKD').toLowerCase();
    const comparer = (col, dir) => (a,b) => {
      let va=a[col], vb=b[col];
      if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * dir;
      va = String(va ?? ''); vb = String(vb ?? '');
      va = norm(va); vb = norm(vb);
      return va < vb ? -1*dir : va > vb ? 1*dir : 0;
    };
    const asNumber = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

    // Assemblies API
    function addAssembly(name, presetItems=[]) {
      const id = uid();
      const items = presetItems.map(p => ({ id: uid(), selected: false, status: 'Open', lager: 0, ...p }));
      for(const it of items){ it.status = toEnglishStatus(it.status); }
      state.assemblies.push({ id, name, items });
      state.active = id;
      save();
      renderAll();
    }

    function renameAssembly(id, newName){
      const a = state.assemblies.find(x=>x.id===id); if(!a) return;
      a.name = newName.trim();
      save(); renderAll();
    }

    function addPart(toAssemblyId, part) {
      const a = state.assemblies.find(x => x.id === toAssemblyId);
      if (!a) return;
      const status = toEnglishStatus(part.status ?? 'Open');
      a.items.push({ id: uid(), selected: false, status, lager: 0, ...part, status });
      save();
      renderAll();
    }

    function deletePart(assemblyId, itemId){
      let a = state.assemblies.find(x => x.id === assemblyId) || state.assemblies.find(grp => grp.items.some(it => it.id === itemId));
      if (!a) return;
      const i = a.items.findIndex(x => x.id === itemId);
      if (i < 0) return;
      a.items.splice(i,1);
      save(); renderAll();
    }

    // Persistence
    function save() { ls.set('umd.bom.v2.multi', state); }

    function migrateState(){
      // If coming from older single-assembly storage, try to import
      const old = ls.get('umd.bom.v1.single');
      if (!state.assemblies.length && old && Array.isArray(old.assemblies)) {
        state.assemblies = old.assemblies.map(a => ({ id: a.id || uid(), name: a.name || 'Main', items: (a.items||[]).map(it => ({...it, status: toEnglishStatus(it.status)})) }));
        state.active = old.active && old.active !== 'order' && old.active !== 'all' ? old.active : state.assemblies[0]?.id;
        state.appTitle = old.appTitle || state.appTitle;
      }
      for (const a of state.assemblies){ for (const it of a.items){ it.status = toEnglishStatus(it.status); } }
    }

    async function load() {
      const v = await ls.get('umd.bom.v2.multi');
      if (v && v.assemblies) Object.assign(state, v);
      if (!state.assemblies || !state.assemblies.length) {
        seed();
      }
      migrateState();
      if (!state.appTitle) state.appTitle = 'UMD – Accumulator';
      const valid = ['order','all'].includes(state.active) || state.assemblies.some(a => a.id === state.active);
      if (!valid) state.active = state.assemblies[0]?.id || 'order';
    }

    // UI widgets
    function renderTabs() {
      const el = document.getElementById('tabs');
      el.innerHTML = '';

      // One tab per assembly
      for (const a of state.assemblies) {
        const t = document.createElement('a');
        t.href = `#${a.id}`;
        t.className = 'tab';
        t.textContent = a.name;
        if (state.active === a.id) t.setAttribute('aria-current','page');
        t.addEventListener('click', (e)=>{ e.preventDefault(); state.active = a.id; renderAll(); });
        el.appendChild(t);
      }

      // Tab: All Parts
      const allTab = document.createElement('a');
      allTab.href = '#all'; allTab.className = 'tab'; allTab.textContent = 'All parts';
      if (state.active === 'all') allTab.setAttribute('aria-current','page');
      allTab.addEventListener('click', (e)=>{ e.preventDefault(); state.active = 'all'; renderAll(); });
      el.appendChild(allTab);

      // Tab: Order
      const orderTab = document.createElement('a');
      orderTab.href = '#order'; orderTab.className = 'tab'; orderTab.textContent = 'Order';
      if (state.active === 'order') orderTab.setAttribute('aria-current','page');
      orderTab.addEventListener('click', (e)=>{ e.preventDefault(); state.active = 'order'; renderAll(); });
      el.appendChild(orderTab);
    }

    function renderViews() {
      const container = document.getElementById('views');
      container.innerHTML = '';

      // View: All parts (across assemblies)
      if (state.active === 'all') {
        const all = state.assemblies.flatMap(a => a.items.map(it => ({...it, _group: a.name, _aid: a.id})));
        const query = norm(state.query || '').trim();
        const filtered = all.filter(r => !query || [r._group, r.mpn, r.hersteller, r.shop, r.status, r.lager].some(x => (x+"").toLowerCase().includes(query)));
        const panel = document.createElement('div'); panel.className = 'panel';
        panel.innerHTML = `
          <div class="toolbar"><span class="hint">${filtered.length} part(s) total</span></div>
          <div style="overflow:auto">
          <table id="tblAll"><thead><tr>
            <th data-col="_group">Assembly <span class="arrow"></span></th>
            <th data-col="mpn">MPN <span class="arrow"></span></th>
            <th data-col="hersteller">Manufacturer <span class="arrow"></span></th>
            <th data-col="shop">Shop <span class="arrow"></span></th>
            <th data-col="status">Status <span class="arrow"></span></th>
            <th data-col="lager" class="num">Stock <span class="arrow"></span></th>
          </tr></thead><tbody></tbody></table></div>`;
        container.appendChild(panel);
        filtered.sort(comparer(state.order.col, state.order.dir));
        const tbodyAll = panel.querySelector('tbody');
        if (filtered.length === 0){
          const tr = document.createElement('tr');
          tr.innerHTML = `<td colspan="6" class="hint">No parts yet. Use “New part” or “Add multiple parts”.</td>`;
          tbodyAll.appendChild(tr);
        }
        for (const r of filtered){
          const tr = document.createElement('tr');
          tr.innerHTML = `<td>${r._group}</td><td>${escapeHTML(r.mpn)}</td><td>${escapeHTML(r.hersteller||'')}</td><td>${linkify(r.shop)}</td><td>${badge(r.status)}</td><td class="num">${r.lager}</td>`;
          tbodyAll.appendChild(tr);
        }
        panel.querySelectorAll('#tblAll thead th[data-col]').forEach(th => {
          const col = th.getAttribute('data-col');
          const arrow = th.querySelector('.arrow');
          if (arrow) arrow.textContent = state.order.col === col ? (state.order.dir===1 ? '▲' : '▼') : '';
        });
        panel.querySelector('#tblAll thead').addEventListener('click', (e)=>{
          const th = e.target.closest('th[data-col]'); if (!th) return;
          const col = th.getAttribute('data-col');
          if (state.order.col === col) state.order.dir *= -1; else { state.order.col = col; state.order.dir = 1; }
          renderAll();
        });
        return;
      }

      // View: Order
      if (state.active === 'order') {
        const all = state.assemblies.flatMap(a => a.items.map(it => ({...it, _group: a.name, _aid: a.id})) ).filter(x => x.selected);
        const queryRaw = (state.query ?? '');
        const query = norm(queryRaw).trim();
        const filtered = all.filter(r => !query || [r._group, r.mpn, r.hersteller, r.shop, r.status, r.lager]
          .some(x => (x+"").toLowerCase().includes(query)));
        const panel = document.createElement('div'); panel.className = 'panel';
        const noneMsg = filtered.length ? '' : `<div class="hint">${query ? 'No matching items in order. Clear the search or switch assembly.' : 'No items selected. Go to an assembly and tick the first column.'}</div>`;
        panel.innerHTML = `
          <div class="toolbar">
            <span class="hint">${all.length} item(s) selected</span>
            <button id="clearAll" class="btn small" style="margin-left:auto">Uncheck all</button>
          </div>
          ${noneMsg}
          <div style="overflow:auto">
          <table id="tblOrder"><thead><tr>
            <th data-sortable="false">✓</th>
            <th data-col="_group">Assembly</th>
            <th data-col="mpn">MPN</th>
            <th data-col="hersteller">Manufacturer</th>
            <th data-col="shop">Shop</th>
            <th data-col="status">Status</th>
            <th data-col="lager" class="num">Stock</th>
          </tr></thead><tbody></tbody></table></div>`;
        container.appendChild(panel);
        const tbody = panel.querySelector('tbody');
        for (const r of filtered) {
          const tr = document.createElement('tr');
          tr.innerHTML = `<td class="center"><input type="checkbox" data-id="${r.id}" checked /></td><td>${r._group}</td><td>${escapeHTML(r.mpn)}</td><td>${escapeHTML(r.hersteller||'')}</td><td>${linkify(r.shop)}</td><td>${badge(r.status)}</td><td class="num">${r.lager}</td>`;
          tbody.appendChild(tr);
        }
        panel.querySelector('#tblOrder').addEventListener('change', (e)=>{
          const cb = e.target.closest('input[type="checkbox"][data-id]');
          if (!cb) return;
          const id = cb.getAttribute('data-id');
          for (const a of state.assemblies){
            const it = a.items.find(x => x.id === id);
            if (it){ it.selected = cb.checked; break; }
          }
          save(); renderAll();
        });
        panel.querySelector('#clearAll').addEventListener('click', ()=>{
          if (!confirm('Uncheck all selected items?')) return;
          for (const a of state.assemblies){ for (const it of a.items){ it.selected = false; } }
          save(); renderAll();
        });
        return;
      }

      // Active assembly view
      const a = state.assemblies.find(x => x.id === state.active) || state.assemblies[0];
      if (!a) return;

      const panel = document.createElement('div'); panel.className = 'panel';
      panel.innerHTML = `
        <div class="toolbar" style="flex-direction:column; align-items:flex-start; gap:6px">
          <div class="section-title">Assembly: ${escapeHTML(a.name)}</div>
          <label style="margin-left:auto"><input type="checkbox" id="toggleShowSelected" ${state.showSelectedOnly?'checked':''}/> Selected only</label>
        </div>
        <div style="overflow:auto">
        <table id="tbl"><thead><tr>
          <th data-col="selected" data-sortable="false" title="Include in order">✓</th>
          <th data-col="mpn">MPN <span class="arrow"></span></th>
          <th data-col="hersteller">Manufacturer <span class="arrow"></span></th>
          <th data-col="shop">Shop <span class="arrow"></span></th>
          <th data-col="status">Status <span class="arrow"></span></th>
          <th data-col="lager" class="num">Stock <span class="arrow"></span></th>
          </tr></thead><tbody></tbody></table></div>
        <div class="footer"><div>Items: <span class="chip" id="count">0</span> • In order: <span class="chip" id="countSel">0</span></div></div>
      `;
      container.appendChild(panel);

      const tbody = panel.querySelector('tbody');
      const queryRaw = (state.query ?? '');
      const query = norm(queryRaw).trim();
      const filtered = a.items
        .filter(r => !query || [r.mpn, r.hersteller, r.shop, r.status, r.lager].some(x => (x+"").toLowerCase().includes(query)))
        .filter(r => state.showSelectedOnly ? !!r.selected : true);
      filtered.sort(comparer(state.order.col, state.order.dir));

      let selCount = 0;
      if (filtered.length === 0){
        const tr = document.createElement('tr');
        tr.innerHTML = `<td colspan="6" class="hint">No parts yet. Use “New part” or “Add multiple parts”.</td>`;
        tbody.appendChild(tr);
      }
      for (const r of filtered) {
        if (r.selected) selCount++;
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td class="center"><input type="checkbox" aria-label="Include in order" data-id="${r.id}" ${r.selected ? 'checked' : ''} /></td>
          <td contenteditable="true" data-field="mpn" data-id="${r.id}">${escapeHTML(r.mpn)}</td>
          <td contenteditable="true" data-field="hersteller" data-id="${r.id}">${escapeHTML(r.hersteller||'')}</td>
          <td contenteditable="true" data-field="shop" data-id="${r.id}">${escapeHTML(r.shop||'')}</td>
          <td>${statusEditor(r)}</td>
          <td class="num" contenteditable="true" data-field="lager" data-id="${r.id}">${r.lager}</td>
          `;
        tbody.appendChild(tr);
      }
      panel.querySelector('#count').textContent = a.items.length;
      panel.querySelector('#countSel').textContent = selCount;

      // header sort arrows
      panel.querySelectorAll('th[data-col]').forEach(th => {
        const col = th.getAttribute('data-col');
        const arrow = th.querySelector('.arrow');
        if (!arrow) return;
        arrow.textContent = state.order.col === col ? (state.order.dir===1 ? '▲' : '▼') : '';
      });

      panel.querySelector('#tbl thead').addEventListener('click', (e) => {
        const th = e.target.closest('th');
        if (!th) return; const col = th.getAttribute('data-col');
        const sortable = th.getAttribute('data-sortable') !== 'false';
        if (!sortable || !col) return;
        if (state.order.col === col) state.order.dir *= -1; else { state.order.col = col; state.order.dir = 1; }
        renderAll();
      });

      panel.querySelector('#tbl tbody').addEventListener('change', (e) => {
        const cb = e.target.closest('input[type="checkbox"][data-id]');
        if (cb) {
          const id = cb.getAttribute('data-id');
          const item = a.items.find(x => x.id === id); if (!item) return;
          item.selected = cb.checked;
          save(); renderAll(); return;
        }
        const sel = e.target.closest('select[data-id]');
        if (sel) {
          const id = sel.getAttribute('data-id');
          const item = a.items.find(x => x.id === id); if (item) item.status = toEnglishStatus(sel.value);
          save();
        }
      });

      panel.querySelector('#toggleShowSelected')?.addEventListener('change', (e)=>{
        state.showSelectedOnly = !!e.target.checked; save(); renderAll();
      });

      panel.querySelector('#tbl tbody').addEventListener('blur', (e) => {
        const cell = e.target.closest('[contenteditable][data-id]');
        if (!cell) return;
        const id = cell.getAttribute('data-id');
        const field = cell.getAttribute('data-field');
        const item = a.items.find(x => x.id === id); if (!item) return;
        let val = cell.textContent.trim();
        if (field === 'lager') { item.lager = asNumber(val); cell.textContent = item.lager; }
        else if (field === 'shop') { item.shop = val; cell.innerHTML = escapeHTML(val); }
        else { item[field] = val; cell.innerHTML = escapeHTML(val); }
        save();
      }, true);
    }

    // helpers
    function badge(status){
      const st = toEnglishStatus(status);
      const c = st === 'Delivered' ? 'background:rgba(52,211,153,.12); border-color:#065f46; color:#a7f3d0;' : st === 'Order' ? 'background:rgba(96,165,250,.12); border-color:#1e3a8a; color:#bfdbfe;' : st === 'Sample' ? 'background:rgba(251,191,36,.12); border-color:#7c2d12; color:#fde68a;' : 'background:#0b1225; border-color:#334155; color:#cbd5e1;';
      return `<span class="chip" style="${c}">${st}</span>`;
    }
    function statusEditor(r){
      const cur = toEnglishStatus(r.status);
      const opts = STATUSES.map(o => `<option ${o===cur?'selected':''}>${o}</option>`).join('');
      return `<select data-id="${r.id}">${opts}</select>`;
    }
    function linkify(s){
      if (!s) return '';
      try { const u = new URL(/^https?:\/\//i.test(s) ? s : 'https://' + s); return `<a href="${u.href}" target="_blank" rel="noopener">${u.hostname}</a>`; } catch { return escapeHTML(s); }
    }
    function escapeHTML(s){
      return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;','\'':'&#39;'}[c]));
    }

    // ===== Bulk import =====
    function detectDelimiter(text){
      const first = text.split(/\r?\n/).find(l => l.trim().length);
      if (!first) return '\t';
      const delSel = document.getElementById('bulkDelimiter').value;
      if (delSel !== 'auto') return delSel === '\\t' ? '\t' : delSel; // normalize Tab option
      const cand = ['\t',';',','];
      let best = '\t', bestCount = -1;
      for (const d of cand){ const c = first.split(d).length; if (c > bestCount){ bestCount = c; best = d; } }
      return best;
    }

    function parseBulk(text){
      const delim = detectDelimiter(text);
      const lines = text.split(/\r?\n/).map(l=>l.trim()).filter(l=>l.length);
      const rows = [];
      for (const l of lines){
        const c = l.split(delim).map(x=>x.trim());
        const mpn = c[0]||'';
        const hersteller = c[1]||'';
        const shop = c[2]||'';
        const status = toEnglishStatus(c[3]||'Open');
        const lager = c[4] ? asNumber(c[4]) : 0;
        rows.push({ mpn, hersteller, shop, status, lager });
      }
      return rows;
    }

    function previewBulk(){
      const text = document.getElementById('bulkText').value;
      const rows = parseBulk(text).slice(0,5);
      const hint = rows.length ? rows.map(r=>`${r.mpn} · ${r.hersteller} · ${r.shop} · ${r.status} · ${r.lager}`).join('<br>') : 'No rows detected.';
      document.getElementById('bulkPreview').innerHTML = `Preview (${rows.length} of up to 5):<br>${hint}`;
    }

    function applyBulk(){
      const a = state.assemblies.find(x=>x.id===state.active) || state.assemblies[0];
      if (!a) { alert('Assembly not ready.'); return; }
      const text = document.getElementById('bulkText').value.trim();
      if (!text) { alert('Please paste some rows.'); return; }
      const rows = parseBulk(text);
      for (const r of rows) addPart(a.id, r);
      closeModal('#modalBulk');
    }

    // ===== App title edit =====
    function setAppTitle(){
      const el = document.getElementById('appTitle');
      if (el) el.textContent = state.appTitle || 'UMD – Accumulator';
    }
    function openAppTitleModal(){
      const inp = document.getElementById('appTitleInput');
      inp.value = state.appTitle || 'UMD – Accumulator';
      openModal('#modalAppTitle');
    }
    function saveAppTitle(){
      const val = (document.getElementById('appTitleInput').value || '').trim();
      if (!val) { alert('Please enter a title'); return; }
      state.appTitle = val; save(); setAppTitle(); closeModal('#modalAppTitle');
    }

    // ===== Rename modal =====
    function openRenameModal(){
      const wrap = document.getElementById('renameSelectWrap');
      const sel = document.getElementById('renameSelect');
      const inp = document.getElementById('renameName');
      sel.innerHTML = '';
      for (const a of state.assemblies){
        const opt = document.createElement('option');
        opt.value = a.id; opt.textContent = a.name; sel.appendChild(opt);
      }
      // If single mode, hide selector and rename the only assembly; else show it
      wrap.style.display = SINGLE_MODE ? 'none' : '';
      if (SINGLE_MODE) {
        const a = state.assemblies[0];
        inp.value = a ? a.name : '';
      } else {
        const current = state.assemblies.find(x=>x.id===state.active) || state.assemblies[0];
        sel.value = current?.id;
        inp.value = current?.name || '';
      }
      openModal('#modalRename');
    }
    function saveRename(){
      const inp = document.getElementById('renameName');
      const newName = (inp.value || '').trim();
      if (!newName) { alert('Please enter a new name'); return; }
      const targetId = SINGLE_MODE ? state.assemblies[0]?.id : document.getElementById('renameSelect').value;
      if (targetId) renameAssembly(targetId, newName);
      closeModal('#modalRename');
    }

    // ===== Add assembly button =====
    function openAddAssemblyModal(){
      const nextIndex = state.assemblies.length + 1;
      const suggested = `Assembly ${nextIndex}`;
      const input = document.getElementById('newAsmName');
      input.value = suggested;
      openModal('#modalAddAssembly');
      input.select();
    }
    function saveNewAssembly(){
      const name = (document.getElementById('newAsmName').value || '').trim();
      if (!name) { alert('Please enter a name'); return; }
      addAssembly(name, []); // switches active to the new assembly and re-renders
      closeModal('#modalAddAssembly');
    }

    // Rendering & global events
    function setToolbarDisabled(dis){
      ['addPart','bulkAdd','editAppTitle','renameAssemblyBtnBottom','addAssemblyBtn'].forEach(id=>{
        const el = document.getElementById(id);
        if (el) el.disabled = !!dis;
      });
    }
    function renderAll(){ setAppTitle(); renderTabs(); renderViews(); }

    function openModal(id){
      document.querySelector(id).classList.add('open');
      setToolbarDisabled(true);
      const first = document.querySelector(id).querySelector('input,select,textarea,button');
      if (first) first.focus();
    }
    function closeModal(id){
      document.querySelector(id).classList.remove('open');
      setToolbarDisabled(false);
    }

    // Realtime subscription: when another user saves, we update our UI
function subscribeRealtime(onRemoteUpdate){
  supabase.channel('realtime:site_states')
    .on('postgres_changes', {
      event: '*',
      schema: 'public',
      table: 'site_states',
      filter: `id=eq.${SITE_ID}`
    }, payload => {
      if (payload?.new?.state) {
        console.log('[Supabase] realtime update received');
        onRemoteUpdate(payload.new.state);
      }
    })
    .subscribe();
}

async function setup(){
      await load();
      renderAll();

      // Start realtime syncing with other clients
      subscribeRealtime((remoteState)=>{ Object.assign(state, remoteState); renderAll(); });

      // Persist once to ensure the DB row exists
      save();

      // Search (per active view)
      const q = document.getElementById('q');
      q.addEventListener('input', (e)=>{ state.query = e.target.value; renderAll(); });
      document.getElementById('resetView').addEventListener('click', ()=>{
        state.query = '';
        state.showSelectedOnly = false;
        state.order = { col: 'mpn', dir: 1 };
        q.value = '';
        save();
        renderAll();
      });

      // Rename assembly (modal)
      document.getElementById('editAppTitle').addEventListener('click', openAppTitleModal);
      document.getElementById('renameAssemblyBtnBottom').addEventListener('click', openRenameModal);
      document.querySelectorAll('[data-close="#modalAppTitle"]').forEach(b => b.addEventListener('click', ()=> closeModal('#modalAppTitle')));
      document.getElementById('saveAppTitle').addEventListener('click', saveAppTitle);
      document.getElementById('appTitleInput').addEventListener('keydown', (e)=>{ if (e.key === 'Enter') { e.preventDefault(); saveAppTitle(); } });
      document.querySelectorAll('[data-close="#modalRename"]').forEach(b => b.addEventListener('click', ()=> closeModal('#modalRename')));
      document.getElementById('saveRename').addEventListener('click', saveRename);

      // Add assembly (opens modal)
      document.getElementById('addAssemblyBtn').addEventListener('click', openAddAssemblyModal);
      document.querySelectorAll('[data-close="#modalAddAssembly"]').forEach(b => b.addEventListener('click', ()=> closeModal('#modalAddAssembly')));
      document.getElementById('saveAddAssembly').addEventListener('click', saveNewAssembly);
      document.getElementById('newAsmName').addEventListener('keydown', (e)=>{ if (e.key === 'Enter') { e.preventDefault(); saveNewAssembly(); } });

      // New part
      document.getElementById('addPart').addEventListener('click', ()=>{
        document.getElementById('partMPN').value='';
        document.getElementById('partManu').value='';
        document.getElementById('partShop').value='';
        document.getElementById('partStatus').value='Open';
        document.getElementById('partStock').value='0';
        openModal('#modalPart');
      });
      document.querySelectorAll('[data-close="#modalPart"]').forEach(b => b.addEventListener('click', ()=> closeModal('#modalPart')));
      document.getElementById('savePart').addEventListener('click', ()=>{
        const current = state.assemblies.find(x=>x.id===state.active) || state.assemblies[0];
        if (!current) return;
        const mpn = document.getElementById('partMPN').value.trim();
        if (!mpn) return alert('Please enter an MPN');
        addPart(current.id, {
          mpn,
          hersteller: document.getElementById('partManu').value.trim(),
          shop: document.getElementById('partShop').value.trim(),
          status: document.getElementById('partStatus').value,
          lager: Math.max(0, parseInt(document.getElementById('partStock').value || '0', 10))
        });
        closeModal('#modalPart');
      });

      // Bulk add
      document.getElementById('bulkAdd').addEventListener('click', ()=>{
        document.getElementById('bulkText').value='';
        document.getElementById('bulkPreview').textContent='';
        document.getElementById('bulkDelimiter').value='auto';
        openModal('#modalBulk');
      });
      document.querySelectorAll('[data-close="#modalBulk"]').forEach(b => b.addEventListener('click', ()=> closeModal('#modalBulk')));
      document.getElementById('previewBulk').addEventListener('click', previewBulk);
      document.getElementById('applyBulk').addEventListener('click', applyBulk);

      // Smoke tests (lightweight)
      runSmokeTests();
    }

    function runSmokeTests(){
      try{
        if (!state.assemblies || state.assemblies.length < 1) throw new Error('Assembly initialization failed');
        const first = state.assemblies[0];
        const oldName = first.name;
        const tmp = oldName + ' _test';
        renameAssembly(first.id, tmp);
        if (state.assemblies[0].name !== tmp) throw new Error('renameAssembly failed');
        renameAssembly(first.id, oldName);
        const before = first.items.length;
        addPart(first.id, { mpn: 'TEST123', hersteller: 'T', shop: 'example.com', status: 'Bestellen', lager: 1 });
        const after = state.assemblies[0].items.length;
        if (after !== before + 1) throw new Error('addPart failed');
        const added = state.assemblies[0].items[after - 1];
        if (added.status !== 'Order') throw new Error('status mapping failed');
        deletePart(first.id, added.id);
        console.log('[SmokeTests] OK');
      } catch(err){ showError(err.message || String(err)); }
    }

    // Visible error banner for JS errors
    function showError(msg){
      try{
        let el = document.getElementById('err');
        if(!el){
          el = document.createElement('div');
          el.id = 'err';
          el.style.position = 'fixed';
          el.style.left = '10px'; el.style.right = '10px'; el.style.bottom = '10px';
          el.style.background = '#7f1d1d'; el.style.color = '#fecaca';
          el.style.padding = '8px 12px'; el.style.borderRadius = '8px';
          el.style.border = '1px solid #b91c1c'; el.style.zIndex = 9999;
          document.body.appendChild(el);
        }
        el.textContent = 'Error: ' + msg;
      } catch(e) {}
    }

    window.addEventListener('error', (e)=> showError(e.message));
    window.addEventListener('unhandledrejection', (e)=> showError(e.reason && e.reason.message ? e.reason.message : String(e.reason)));
    document.addEventListener('DOMContentLoaded', setup);
