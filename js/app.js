/* SIMTEC - Tecnología Informática
 * App web de una sola página. Los datos se guardan en la nube (Vercel, carpeta /api)
 * y se comparten entre todas las computadoras; cada sección se puede descargar a Excel (.xlsx).
 */
(function () {
  'use strict';

  const TOKEN_KEY = 'simtec_token';
  const CACHE_KEY = 'simtec_cache_v2';
  const OLD_LOCAL_KEY = 'simtec_db_v1'; // datos de la versión anterior (solo en este navegador)
  const COLLECTIONS = ['clientes', 'cartera', 'movimientos', 'ordenes', 'inventario'];

  // ------------------------------------------------------------------ datos
  const emptyDB = () => ({
    config: {
      dgiUrl: 'https://dgi.mef.gob.pa/',
      negocio: 'SIMTEC Tecnología Informática',
      telefono: '',
      direccion: '',
      moneda: '$',
    },
    seq: { orden: 0 },
    clientes: [],
    cartera: [],
    movimientos: [],
    ordenes: [],
    inventario: [],
  });
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const normalize = (d) => {
    const base = emptyDB();
    const out = { ...base, ...(d || {}), config: { ...base.config, ...((d && d.config) || {}) }, seq: { ...base.seq, ...((d && d.seq) || {}) } };
    COLLECTIONS.forEach((c) => (out[c] = Array.isArray(out[c]) ? out[c] : []));
    return out;
  };

  const ls = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* almacenamiento bloqueado */ } },
    del(k) { try { localStorage.removeItem(k); } catch (e) { /* almacenamiento bloqueado */ } },
  };

  // db = lo que se ve y edita; synced = última versión confirmada por el servidor.
  // Lo que cambie entre los dos se envía al servidor.
  let token = ls.get(TOKEN_KEY);
  let db = emptyDB();
  let synced = emptyDB();
  let version = 0;
  (function loadCache() {
    try {
      const c = JSON.parse(ls.get(CACHE_KEY));
      if (c && c.db) { db = normalize(c.db); synced = normalize(c.synced); version = c.version || 0; }
    } catch (e) { /* sin caché */ }
  })();
  const cacheLocal = () => ls.set(CACHE_KEY, JSON.stringify({ db, synced, version }));

  // ---- diferencias entre dos versiones (lo que se manda al servidor)
  function diff(a, b) {
    const ops = [];
    COLLECTIONS.forEach((c) => {
      const old = new Map(a[c].map((x) => [x.id, x]));
      b[c].forEach((x) => {
        const o = old.get(x.id);
        if (!o || JSON.stringify(o) !== JSON.stringify(x)) ops.push({ c, id: x.id, item: x });
        old.delete(x.id);
      });
      old.forEach((_, id) => ops.push({ c, id, del: true }));
    });
    const config = {};
    Object.keys(b.config).forEach((k) => { if (a.config[k] !== b.config[k]) config[k] = b.config[k]; });
    const hasConfig = Object.keys(config).length > 0;
    const seq = b.seq.orden > a.seq.orden ? { orden: b.seq.orden } : null;
    if (!ops.length && !hasConfig && !seq) return null;
    return { ops, config: hasConfig ? config : undefined, seq: seq || undefined };
  }
  function applyChanges(data, ch) {
    (ch.ops || []).forEach((op) => {
      const list = data[op.c];
      const i = list.findIndex((x) => x.id === op.id);
      if (op.del) { if (i >= 0) list.splice(i, 1); }
      else if (i >= 0) list[i] = op.item;
      else list.push(op.item);
    });
    if (ch.config) Object.assign(data.config, ch.config);
    if (ch.seq) data.seq.orden = Math.max(data.seq.orden, ch.seq.orden);
    return data;
  }

  // ---- comunicación con el servidor
  class AuthError extends Error {}
  async function api(method, path, body) {
    const res = await fetch('/api/' + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      cache: 'no-store',
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) throw new AuthError(data.error || 'Sesión vencida');
    if (!res.ok) throw new Error(data.error || 'Error del servidor (' + res.status + ')');
    return data;
  }

  function setStatus(s) {
    const el = $('#sync-status');
    if (!el) return;
    const map = {
      ok: ['☁ Guardado', 'ok'], saving: ['⟳ Guardando…', 'busy'], pending: ['⟳ Guardando…', 'busy'],
      offline: ['⚠ Sin conexión — se guardará al volver', 'bad'], loading: ['⟳ Cargando…', 'busy'],
    };
    const [text, cls] = map[s] || map.ok;
    el.textContent = text;
    el.className = 'sync ' + cls;
  }

  // Cada cambio: se guarda en este navegador al instante y se sube a la nube enseguida.
  let pushTimer, retryTimer, pushing = false, again = false;
  function save() {
    cacheLocal();
    setStatus('pending');
    clearTimeout(pushTimer);
    pushTimer = setTimeout(push, 300);
  }
  const hasPending = () => !!diff(synced, db);

  async function push() {
    if (pushing) { again = true; return; }
    const changes = diff(synced, db);
    if (!changes) { setStatus('ok'); return; }
    pushing = true;
    setStatus('saving');
    const sent = clone(db);
    try {
      const r = await api('POST', 'data', changes);
      const later = diff(sent, db); // lo que se editó mientras se subía
      synced = normalize(r.data);
      version = r.version;
      db = applyChanges(clone(synced), later || {});
      cacheLocal();
      setStatus(later ? 'pending' : 'ok');
      if (later) again = true;
    } catch (e) {
      handleSyncError(e);
    } finally {
      pushing = false;
      if (again) { again = false; push(); }
    }
  }

  // Trae lo último del servidor (lo que hayan guardado otras computadoras).
  async function pull({ rerender = false } = {}) {
    if (!token) return;
    if (hasPending()) return push();
    try {
      const r = await api('GET', 'data');
      if (hasPending()) return; // el usuario editó mientras llegaba la respuesta
      const changed = r.version !== version;
      synced = normalize(r.data);
      db = clone(synced);
      version = r.version;
      cacheLocal();
      setStatus('ok');
      if (changed && rerender) refreshView();
    } catch (e) {
      handleSyncError(e);
    }
  }

  function handleSyncError(e) {
    if (e instanceof AuthError) {
      toast('Su sesión venció, vuelva a entrar');
      logout();
      return;
    }
    setStatus('offline');
    clearTimeout(retryTimer);
    retryTimer = setTimeout(() => (hasPending() ? push() : pull({ rerender: true })), 10000);
  }

  // Actualiza la pantalla con datos nuevos solo si el usuario no está escribiendo.
  function refreshView() {
    const active = document.activeElement;
    const typing = active && $('#view').contains(active) && /INPUT|SELECT|TEXTAREA/.test(active.tagName);
    const filled = $$('#view form input, #view form textarea').some((i) => i.type !== 'date' && i.type !== 'number' && i.value);
    if (typing || filled || document.querySelector('.modal-back')) return;
    route({ keepScroll: true });
  }
  setInterval(() => document.visibilityState === 'visible' && pull({ rerender: true }), 20000);
  window.addEventListener('focus', () => pull({ rerender: true }));
  window.addEventListener('online', () => (hasPending() ? push() : pull({ rerender: true })));

  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const today = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  const num = (v) => {
    const n = parseFloat(String(v).replace(',', '.'));
    return isFinite(n) ? n : 0;
  };
  const money = (n) => db.config.moneda + ' ' + num(n).toLocaleString('es', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fmtDate = (s) => (s ? s.split('-').reverse().join('/') : '');
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const clienteById = (id) => db.clientes.find((c) => c.id === id);
  const clienteNombre = (id) => (clienteById(id) || {}).nombre || '';
  const waDigits = (s) => String(s || '').replace(/\D/g, '');
  const waLink = (phone, text) => `https://wa.me/${waDigits(phone)}${text ? '?text=' + encodeURIComponent(text) : ''}`;

  let toastTimer;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.hidden = true), 2400);
  }

  // ------------------------------------------------------------------ Excel
  function exportXLSX(filename, sheets) {
    if (!window.XLSX) {
      toast('No se pudo cargar el módulo de Excel');
      return;
    }
    const wb = XLSX.utils.book_new();
    Object.entries(sheets).forEach(([name, rows]) => {
      const ws = XLSX.utils.json_to_sheet(rows.length ? rows : [{ '': 'Sin datos' }]);
      const keys = Object.keys(rows[0] || { '': '' });
      ws['!cols'] = keys.map((k) => ({ wch: Math.max(k.length, ...rows.map((r) => String(r[k] ?? '').length)) + 2 }));
      XLSX.utils.book_append_sheet(wb, ws, name.slice(0, 31));
    });
    XLSX.writeFile(wb, filename);
    toast('Archivo de Excel descargado');
  }

  // ------------------------------------------------------------------ login
  const isLogged = () => !!token;

  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('.btn-entrar');
    btn.disabled = true;
    $('#login-error').hidden = true;
    try {
      const r = await api('POST', 'login', { user: $('#login-user').value.trim(), pass: $('#login-pass').value });
      token = r.token;
      ls.set(TOKEN_KEY, token);
      ls.set('simtec_user', r.user);
      $('#login-pass').value = '';
      showApp();
      setStatus('loading');
      await pull({ rerender: true });
      route();
      await offerLocalMigration();
    } catch (err) {
      $('#login-error').textContent = err instanceof AuthError ? 'Usuario o contraseña incorrectos' : 'No hay conexión con el servidor. Intente de nuevo.';
      $('#login-error').hidden = false;
    } finally {
      btn.disabled = false;
    }
  });

  // Si esta computadora tenía datos de la versión anterior (guardados solo aquí), se ofrecen subir a la nube.
  async function offerLocalMigration() {
    let old;
    try { old = JSON.parse(ls.get(OLD_LOCAL_KEY)); } catch (e) { return; }
    if (!old) return;
    const total = COLLECTIONS.reduce((s, c) => s + ((old[c] || []).length), 0);
    if (!total) { ls.del(OLD_LOCAL_KEY); return; }
    const resumen = `${(old.clientes || []).length} clientes, ${(old.ordenes || []).length} órdenes, ${(old.cartera || []).length} deudas, ${(old.inventario || []).length} productos`;
    const nubeVacia = COLLECTIONS.every((c) => !db[c].length);
    const msg = nubeVacia
      ? `En esta computadora hay datos guardados de antes (${resumen}).\n\n¿Subirlos a la nube para verlos en todas las computadoras?`
      : `En esta computadora hay datos guardados de antes (${resumen}).\n\n¿Agregarlos a los datos de la nube? (no se borra nada de lo que ya está en la nube)`;
    if (!confirm(msg)) return;
    const local = normalize(old);
    COLLECTIONS.forEach((c) => local[c].forEach((x) => { if (!db[c].some((y) => y.id === x.id)) db[c].push(x); }));
    db.seq.orden = Math.max(db.seq.orden, local.seq.orden || 0);
    if (nubeVacia) ['dgiUrl', 'negocio', 'telefono', 'direccion', 'moneda'].forEach((k) => { if (local.config[k]) db.config[k] = local.config[k]; });
    save();
    await push();
    ls.set(OLD_LOCAL_KEY + '_subido', ls.get(OLD_LOCAL_KEY));
    ls.del(OLD_LOCAL_KEY);
    toast('Datos subidos a la nube ✅');
    route();
  }

  function logout() {
    token = null;
    ls.del(TOKEN_KEY);
    ls.del(CACHE_KEY);
    db = emptyDB();
    synced = emptyDB();
    version = 0;
    location.hash = '';
    showLogin();
  }
  $('#btn-logout').addEventListener('click', async () => {
    if (hasPending()) {
      await push();
      if (hasPending() && !confirm('Hay cambios que todavía no se subieron (sin conexión). Si sale ahora se pierden. ¿Salir igual?')) return;
    }
    logout();
  });

  function showLogin() {
    $('#app').hidden = true;
    $('#login').hidden = false;
    $('#login-user').focus();
  }
  function showApp() {
    $('#login').hidden = true;
    $('#app').hidden = false;
    route();
  }

  // ------------------------------------------------------------------ router
  const views = {};
  document.addEventListener('click', (e) => {
    const go = e.target.closest('[data-go]');
    if (go) {
      e.preventDefault();
      location.hash = go.dataset.go === 'menu' ? '' : go.dataset.go;
    }
  });
  window.addEventListener('hashchange', () => {
    if (!isLogged()) return;
    route();
    pull({ rerender: true });
  });

  function route({ keepScroll = false } = {}) {
    const name = location.hash.replace('#', '') || 'menu';
    const view = views[name] || views.menu;
    const main = $('#view');
    const y = window.scrollY;
    main.innerHTML = '';
    view(main);
    window.scrollTo(0, keepScroll ? y : 0);
  }

  const head = (title, cls, extra = '') => `
    <div class="section-head">
      <h1 class="${cls}"><button class="btn ghost back" data-go="menu" aria-label="Volver">←</button>${title}</h1>
      <div class="toolbar">${extra}</div>
    </div>`;

  const clienteOptions = (selected, placeholder = '— Seleccione cliente —') =>
    `<option value="">${placeholder}</option>` +
    db.clientes
      .slice()
      .sort((a, b) => a.nombre.localeCompare(b.nombre))
      .map((c) => `<option value="${c.id}" ${c.id === selected ? 'selected' : ''}>${esc(c.nombre)}${c.tienda ? ' — ' + esc(c.tienda) : ''}</option>`)
      .join('');

  // ================================================================== MENÚ
  views.menu = (el) => {
    const tiles = [
      ['clientes', 'Clientes'],
      ['cartera', 'Cartera'],
      ['estadistica', 'Estadística'],
      ['reporte', 'Reporte diario'],
      ['factura', 'Factura DGI'],
      ['orden', 'Orden de ingreso'],
      ['inventario', 'Inventario'],
    ];
    el.innerHTML = `
      <div class="menu-grid">
        <img class="menu-logo" src="assets/logo.jpg" alt="SIMTEC Tecnología Informática">
        ${tiles.map(([k, label]) => `<button class="tile t-${k}" data-go="${k}" aria-label="${label}"><img src="assets/${k}.jpg" alt="${label}"></button>`).join('')}
      </div>`;
  };

  // ================================================================== CLIENTES
  views.clientes = (el) => {
    let editId = null;
    el.innerHTML = `
      ${head('CLIENTES', 'h-blue', `<button class="btn green" id="cl-xls">⬇ Descargar Excel</button>`)}
      <form class="card" id="cl-form">
        <h2 id="cl-title">Crear cliente</h2>
        <div class="form-grid">
          <div class="field"><label for="cl-nombre">Nombre</label><input id="cl-nombre" required placeholder="Nombre del cliente"></div>
          <div class="field"><label for="cl-tienda">Tienda</label><input id="cl-tienda" placeholder="Nombre de la tienda"></div>
          <div class="field"><label for="cl-wa">WhatsApp</label><input id="cl-wa" type="tel" placeholder="Ej: 50760001234"></div>
        </div>
        <div class="form-actions">
          <button class="btn primary big" type="submit">GUARDAR</button>
          <button class="btn" type="button" id="cl-cancel" hidden>Cancelar</button>
        </div>
      </form>
      <div class="toolbar"><div class="search"><input id="cl-q" placeholder="Buscar cliente, tienda o número…"></div></div>
      <div class="table-wrap"><table>
        <thead><tr><th>Nombre</th><th>Tienda</th><th>WhatsApp</th><th class="num">Trabajos</th><th></th></tr></thead>
        <tbody id="cl-body"></tbody>
      </table></div>`;

    const trabajos = (id) => db.ordenes.filter((o) => o.clienteId === id).length;

    function render() {
      const q = $('#cl-q').value.toLowerCase();
      const rows = db.clientes
        .filter((c) => !q || [c.nombre, c.tienda, c.whatsapp].join(' ').toLowerCase().includes(q))
        .sort((a, b) => a.nombre.localeCompare(b.nombre));
      $('#cl-body').innerHTML = rows.length
        ? rows.map((c) => `
          <tr>
            <td><b>${esc(c.nombre)}</b></td>
            <td>${esc(c.tienda)}</td>
            <td>${c.whatsapp ? `<a class="wa" href="${waLink(c.whatsapp)}" target="_blank" rel="noopener">💬 ${esc(c.whatsapp)}</a>` : ''}</td>
            <td class="num">${trabajos(c.id)}</td>
            <td class="actions">
              <button class="btn sm" data-edit="${c.id}">Editar</button>
              <button class="btn sm red" data-del="${c.id}">Borrar</button>
            </td>
          </tr>`).join('')
        : `<tr><td colspan="5" class="empty">Aún no hay clientes. ¡Agregue el primero arriba!</td></tr>`;
    }

    function resetForm() {
      editId = null;
      $('#cl-form').reset();
      $('#cl-title').textContent = 'Crear cliente';
      $('#cl-cancel').hidden = true;
    }

    $('#cl-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const data = { nombre: $('#cl-nombre').value.trim(), tienda: $('#cl-tienda').value.trim(), whatsapp: $('#cl-wa').value.trim() };
      if (!data.nombre) return;
      if (editId) {
        Object.assign(clienteById(editId), data);
        toast('Cliente actualizado');
      } else {
        db.clientes.push({ id: uid(), fecha: today(), ...data });
        toast('Cliente guardado ✅');
      }
      save();
      resetForm();
      render();
    });
    $('#cl-cancel').addEventListener('click', resetForm);
    $('#cl-q').addEventListener('input', render);
    $('#cl-body').addEventListener('click', (e) => {
      const ed = e.target.closest('[data-edit]');
      const del = e.target.closest('[data-del]');
      if (ed) {
        const c = clienteById(ed.dataset.edit);
        editId = c.id;
        $('#cl-nombre').value = c.nombre;
        $('#cl-tienda').value = c.tienda;
        $('#cl-wa').value = c.whatsapp;
        $('#cl-title').textContent = 'Editar cliente';
        $('#cl-cancel').hidden = false;
        $('#cl-nombre').focus();
      }
      if (del) {
        const c = clienteById(del.dataset.del);
        if (confirm(`¿Borrar al cliente "${c.nombre}"? Sus registros de cartera y órdenes se conservan.`)) {
          db.clientes = db.clientes.filter((x) => x.id !== c.id);
          save();
          render();
        }
      }
    });
    $('#cl-xls').addEventListener('click', () =>
      exportXLSX(`Clientes_SIMTEC_${today()}.xlsx`, {
        Clientes: db.clientes.map((c) => ({ Nombre: c.nombre, Tienda: c.tienda, WhatsApp: c.whatsapp, 'Fecha registro': fmtDate(c.fecha), Trabajos: trabajos(c.id) })),
      })
    );
    render();
  };

  // ================================================================== CARTERA
  const saldo = (d) => Math.max(0, num(d.monto) - (d.abonos || []).reduce((s, a) => s + num(a.monto), 0));
  const abonado = (d) => (d.abonos || []).reduce((s, a) => s + num(a.monto), 0);

  views.cartera = (el) => {
    el.innerHTML = `
      ${head('CARTERA', 'h-yellow', `<button class="btn green" id="ca-xls">⬇ Descargar Excel</button>`)}
      <div class="stats-row" id="ca-stats"></div>
      <form class="card" id="ca-form">
        <h2>Agregar deuda (quién me debe)</h2>
        <div class="form-grid">
          <div class="field"><label for="ca-cli">Cliente</label><select id="ca-cli" required>${clienteOptions()}</select></div>
          <div class="field"><label for="ca-con">Concepto</label><input id="ca-con" required placeholder="Ej: Cambio de pantalla"></div>
          <div class="field"><label for="ca-monto">Monto</label><input id="ca-monto" type="number" step="0.01" min="0" required></div>
          <div class="field"><label for="ca-fecha">Fecha</label><input id="ca-fecha" type="date" value="${today()}"></div>
        </div>
        <div class="form-actions"><button class="btn yellow big" type="submit">GUARDAR</button>
        ${db.clientes.length ? '' : '<span style="color:var(--muted)">Primero cree clientes en la sección <a href="#clientes" style="color:#fff">Clientes</a>.</span>'}</div>
      </form>
      <div class="toolbar">
        <div class="search"><input id="ca-q" placeholder="Buscar…"></div>
        <div class="seg"><button class="on" data-f="pend">Pendientes</button><button data-f="all">Todas</button></div>
      </div>
      <div class="table-wrap"><table>
        <thead><tr><th>Fecha</th><th>Cliente</th><th>Concepto</th><th class="num">Monto</th><th class="num">Abonado</th><th class="num">Debe</th><th></th></tr></thead>
        <tbody id="ca-body"></tbody>
        <tfoot><tr><td colspan="5">TOTAL QUE ME DEBEN</td><td class="num" id="ca-total"></td><td></td></tr></tfoot>
      </table></div>`;

    let filtro = 'pend';

    function render() {
      const q = $('#ca-q').value.toLowerCase();
      const rows = db.cartera
        .filter((d) => (filtro === 'all' || saldo(d) > 0))
        .filter((d) => !q || [clienteNombre(d.clienteId), d.concepto].join(' ').toLowerCase().includes(q))
        .sort((a, b) => b.fecha.localeCompare(a.fecha));
      $('#ca-body').innerHTML = rows.length
        ? rows.map((d) => {
          const c = clienteById(d.clienteId) || {};
          const s = saldo(d);
          return `<tr>
            <td>${fmtDate(d.fecha)}</td>
            <td><b>${esc(c.nombre || '(cliente borrado)')}</b>${c.tienda ? `<br><small style="color:var(--muted)">${esc(c.tienda)}</small>` : ''}</td>
            <td>${esc(d.concepto)}</td>
            <td class="num">${money(d.monto)}</td>
            <td class="num">${money(abonado(d))}</td>
            <td class="num">${s > 0 ? `<span class="tag due">${money(s)}</span>` : '<span class="tag ok">PAGADO</span>'}</td>
            <td class="actions">
              ${s > 0 ? `<button class="btn sm green" data-abono="${d.id}">Abonar</button>` : ''}
              ${s > 0 && c.whatsapp ? `<a class="btn sm" target="_blank" rel="noopener" href="${waLink(c.whatsapp, `Hola ${c.nombre}, le saluda ${db.config.negocio}. Le recordamos su saldo pendiente de ${money(s)} por: ${d.concepto}. ¡Gracias!`)}">💬 Cobrar</a>` : ''}
              <button class="btn sm red" data-del="${d.id}">Borrar</button>
            </td></tr>`;
        }).join('')
        : `<tr><td colspan="7" class="empty">Nadie le debe 🎉</td></tr>`;

      const total = db.cartera.reduce((s, d) => s + saldo(d), 0);
      const deudores = new Set(db.cartera.filter((d) => saldo(d) > 0).map((d) => d.clienteId)).size;
      $('#ca-total').textContent = money(total);
      $('#ca-stats').innerHTML = `
        <div class="stat yellow"><div class="label">Total por cobrar</div><div class="value">${money(total)}</div></div>
        <div class="stat red"><div class="label">Clientes que deben</div><div class="value">${deudores}</div></div>
        <div class="stat green"><div class="label">Cobrado (abonos)</div><div class="value">${money(db.cartera.reduce((s, d) => s + abonado(d), 0))}</div></div>`;
    }

    $('#ca-form').addEventListener('submit', (e) => {
      e.preventDefault();
      db.cartera.push({
        id: uid(), origen: 'manual',
        clienteId: $('#ca-cli').value,
        concepto: $('#ca-con').value.trim(),
        monto: num($('#ca-monto').value),
        fecha: $('#ca-fecha').value || today(),
        abonos: [],
      });
      save();
      $('#ca-con').value = '';
      $('#ca-monto').value = '';
      toast('Deuda registrada');
      render();
    });
    $('#ca-q').addEventListener('input', render);
    $$('.seg button', el).forEach((b) => b.addEventListener('click', () => {
      $$('.seg button', el).forEach((x) => x.classList.toggle('on', x === b));
      filtro = b.dataset.f;
      render();
    }));
    $('#ca-body').addEventListener('click', (e) => {
      const ab = e.target.closest('[data-abono]');
      const del = e.target.closest('[data-del]');
      if (ab) {
        const d = db.cartera.find((x) => x.id === ab.dataset.abono);
        const v = prompt(`Abono para "${d.concepto}" (debe ${money(saldo(d))}):`, saldo(d).toFixed(2));
        if (v === null) return;
        const m = Math.min(num(v), saldo(d));
        if (m <= 0) return;
        d.abonos.push({ fecha: today(), monto: m });
        db.movimientos.push({
          id: uid(), origen: 'abono', fecha: today(), tipo: 'ingreso',
          concepto: `Abono cartera: ${d.concepto}`, clienteId: d.clienteId, monto: m,
        });
        save();
        toast('Abono registrado y sumado al reporte diario');
        render();
      }
      if (del) {
        if (confirm('¿Borrar este registro de cartera?')) {
          db.cartera = db.cartera.filter((x) => x.id !== del.dataset.del);
          save();
          render();
        }
      }
    });
    $('#ca-xls').addEventListener('click', () =>
      exportXLSX(`Cartera_SIMTEC_${today()}.xlsx`, {
        Cartera: db.cartera.map((d) => {
          const c = clienteById(d.clienteId) || {};
          return {
            Fecha: fmtDate(d.fecha), Cliente: c.nombre || '', Tienda: c.tienda || '', WhatsApp: c.whatsapp || '',
            Concepto: d.concepto, Monto: num(d.monto), Abonado: abonado(d), Debe: saldo(d),
            Estado: saldo(d) > 0 ? 'PENDIENTE' : 'PAGADO',
          };
        }),
      })
    );
    render();
  };

  // ================================================================== ESTADÍSTICA
  views.estadistica = (el) => {
    el.innerHTML = `
      ${head('ESTADÍSTICA', 'h-blue', `<div class="seg"><button class="on" data-m="trabajos">Por trabajos</button><button data-m="dinero">Por consumo $</button></div>`)}
      <div class="stats-row" id="es-stats"></div>
      <div class="card"><h2 id="es-title">Ranking de clientes</h2><div class="rank" id="es-rank"></div></div>`;

    // Trabajos: órdenes de ingreso + ventas manuales del reporte + deudas manuales de cartera.
    // Consumo: costo de órdenes + ventas manuales + deudas manuales (los abonos no cuentan doble).
    function compute() {
      const m = new Map();
      const add = (id, monto) => {
        if (!id) return;
        const r = m.get(id) || { id, trabajos: 0, dinero: 0 };
        r.trabajos += 1;
        r.dinero += num(monto);
        m.set(id, r);
      };
      db.ordenes.forEach((o) => add(o.clienteId, o.costo));
      db.movimientos.filter((x) => x.origen === 'manual' && x.tipo === 'ingreso').forEach((x) => add(x.clienteId, x.monto));
      db.cartera.filter((x) => x.origen === 'manual').forEach((x) => add(x.clienteId, x.monto));
      return Array.from(m.values()).filter((r) => clienteById(r.id));
    }

    function render(modo) {
      const data = compute().sort((a, b) => b[modo] - a[modo] || b.trabajos - a.trabajos);
      const max = Math.max(1, ...data.map((r) => r[modo]));
      $('#es-title').textContent = modo === 'trabajos' ? 'Del que más trabajos trae al que menos' : 'Del que más consume al que menos';
      $('#es-rank').innerHTML = data.length
        ? data.map((r, i) => {
          const c = clienteById(r.id);
          return `<div class="rank-row" style="animation-delay:${i * 0.06}s">
            <div class="rank-pos">${i + 1}</div>
            <div class="rank-name">${esc(c.nombre)}<small>${esc(c.tienda || '')}</small></div>
            <div class="bar-track"><div class="bar c${i % 5}" data-w="${Math.max(6, (r[modo] / max) * 100)}">${modo === 'trabajos' ? r.trabajos + (r.trabajos === 1 ? ' trabajo' : ' trabajos') : money(r.dinero)}</div></div>
          </div>`;
        }).join('')
        : `<p class="empty">Todavía no hay trabajos registrados. Cree órdenes de ingreso o ventas en el reporte diario.</p>`;
      requestAnimationFrame(() => requestAnimationFrame(() => $$('.bar', el).forEach((b) => (b.style.width = b.dataset.w + '%'))));

      const totalT = data.reduce((s, r) => s + r.trabajos, 0);
      const totalD = data.reduce((s, r) => s + r.dinero, 0);
      $('#es-stats').innerHTML = `
        <div class="stat blue"><div class="label">Clientes registrados</div><div class="value" data-count="${db.clientes.length}">0</div></div>
        <div class="stat green"><div class="label">Trabajos totales</div><div class="value" data-count="${totalT}">0</div></div>
        <div class="stat yellow"><div class="label">Consumo total</div><div class="value" data-count="${totalD}" data-money="1">0</div></div>
        <div class="stat red"><div class="label">Mejor cliente</div><div class="value" style="font-size:24px">${data[0] ? esc(clienteById(data[0].id).nombre) : '—'}</div></div>`;
      countUp();
    }

    function countUp() {
      $$('[data-count]', el).forEach((n) => {
        const target = num(n.dataset.count);
        const isMoney = !!n.dataset.money;
        const t0 = performance.now();
        const step = (t) => {
          const p = Math.min(1, (t - t0) / 900);
          const v = target * (1 - Math.pow(1 - p, 3));
          n.textContent = isMoney ? money(v) : Math.round(v);
          if (p < 1) requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      });
    }

    $$('.seg button', el).forEach((b) => b.addEventListener('click', () => {
      $$('.seg button', el).forEach((x) => x.classList.toggle('on', x === b));
      render(b.dataset.m);
    }));
    render('trabajos');
  };

  // ================================================================== REPORTE DIARIO
  views.reporte = (el) => {
    el.innerHTML = `
      ${head('REPORTE DIARIO', 'h-red', `<input type="date" id="rd-fecha" class="btn ghost" value="${today()}"><button class="btn green" id="rd-xls">⬇ Descargar Excel</button><button class="btn" id="rd-xls-all">⬇ Excel completo</button>`)}
      <div class="stats-row" id="rd-stats"></div>
      <form class="card" id="rd-form">
        <h2>Agregar movimiento</h2>
        <div class="form-grid">
          <div class="field"><label for="rd-tipo">Tipo</label><select id="rd-tipo"><option value="ingreso">Ingreso (venta / trabajo)</option><option value="gasto">Gasto</option></select></div>
          <div class="field"><label for="rd-con">Concepto</label><input id="rd-con" required placeholder="Ej: Venta de cargador"></div>
          <div class="field"><label for="rd-cli">Cliente (opcional)</label><select id="rd-cli">${clienteOptions('', '— Sin cliente —')}</select></div>
          <div class="field"><label for="rd-monto">Monto</label><input id="rd-monto" type="number" step="0.01" min="0" required></div>
        </div>
        <div class="form-actions"><button class="btn red big" type="submit">GUARDAR</button></div>
      </form>
      <div class="table-wrap"><table>
        <thead><tr><th>#</th><th>Tipo</th><th>Concepto</th><th>Cliente</th><th class="num">Monto</th><th class="num">Acumulado</th><th></th></tr></thead>
        <tbody id="rd-body"></tbody>
        <tfoot><tr><td colspan="5">TOTAL DEL DÍA</td><td class="num" id="rd-total"></td><td></td></tr></tfoot>
      </table></div>`;

    const fecha = () => $('#rd-fecha').value || today();
    const signed = (m) => (m.tipo === 'gasto' ? -num(m.monto) : num(m.monto));

    function render() {
      const rows = db.movimientos.filter((m) => m.fecha === fecha());
      let acc = 0;
      $('#rd-body').innerHTML = rows.length
        ? rows.map((m, i) => {
          acc += signed(m);
          return `<tr>
            <td>${i + 1}</td>
            <td>${m.tipo === 'gasto' ? '<span class="tag due">Gasto</span>' : '<span class="tag ok">Ingreso</span>'}</td>
            <td>${esc(m.concepto)}</td>
            <td>${esc(clienteNombre(m.clienteId))}</td>
            <td class="num">${m.tipo === 'gasto' ? '-' : ''}${money(m.monto)}</td>
            <td class="num">${money(acc)}</td>
            <td class="actions">${m.origen === 'manual' ? `<button class="btn sm red" data-del="${m.id}">Borrar</button>` : '<small style="color:var(--muted)">auto</small>'}</td>
          </tr>`;
        }).join('')
        : `<tr><td colspan="7" class="empty">Sin movimientos el ${fmtDate(fecha())}</td></tr>`;
      const ing = rows.filter((m) => m.tipo !== 'gasto').reduce((s, m) => s + num(m.monto), 0);
      const gas = rows.filter((m) => m.tipo === 'gasto').reduce((s, m) => s + num(m.monto), 0);
      $('#rd-total').textContent = money(ing - gas);
      $('#rd-stats').innerHTML = `
        <div class="stat green"><div class="label">Ingresos</div><div class="value">${money(ing)}</div></div>
        <div class="stat red"><div class="label">Gastos</div><div class="value">${money(gas)}</div></div>
        <div class="stat yellow"><div class="label">Total del día</div><div class="value">${money(ing - gas)}</div></div>
        <div class="stat blue"><div class="label">Movimientos</div><div class="value">${rows.length}</div></div>`;
    }

    const toRows = (list) => {
      let acc = 0;
      return list.map((m) => {
        acc += signed(m);
        return { Fecha: fmtDate(m.fecha), Tipo: m.tipo === 'gasto' ? 'Gasto' : 'Ingreso', Concepto: m.concepto, Cliente: clienteNombre(m.clienteId), Monto: signed(m), Acumulado: acc };
      });
    };

    $('#rd-form').addEventListener('submit', (e) => {
      e.preventDefault();
      db.movimientos.push({
        id: uid(), origen: 'manual', fecha: fecha(),
        tipo: $('#rd-tipo').value, concepto: $('#rd-con').value.trim(),
        clienteId: $('#rd-cli').value, monto: num($('#rd-monto').value),
      });
      save();
      $('#rd-con').value = '';
      $('#rd-monto').value = '';
      toast('Movimiento guardado');
      render();
    });
    $('#rd-fecha').addEventListener('change', render);
    $('#rd-body').addEventListener('click', (e) => {
      const del = e.target.closest('[data-del]');
      if (del && confirm('¿Borrar este movimiento?')) {
        db.movimientos = db.movimientos.filter((m) => m.id !== del.dataset.del);
        save();
        render();
      }
    });
    $('#rd-xls').addEventListener('click', () => {
      const rows = toRows(db.movimientos.filter((m) => m.fecha === fecha()));
      rows.push({ Fecha: '', Tipo: '', Concepto: 'TOTAL DEL DÍA', Cliente: '', Monto: rows.length ? rows[rows.length - 1].Acumulado : 0, Acumulado: '' });
      exportXLSX(`Reporte_Diario_${fecha()}.xlsx`, { [`Reporte ${fecha()}`]: rows });
    });
    $('#rd-xls-all').addEventListener('click', () => {
      const all = db.movimientos.slice().sort((a, b) => a.fecha.localeCompare(b.fecha));
      const porDia = {};
      all.forEach((m) => (porDia[m.fecha] = (porDia[m.fecha] || 0) + signed(m)));
      exportXLSX(`Reporte_Completo_SIMTEC_${today()}.xlsx`, {
        Movimientos: toRows(all),
        'Total por día': Object.entries(porDia).map(([f, t]) => ({ Fecha: fmtDate(f), Total: t })),
      });
    });
    render();
  };

  // ================================================================== FACTURA DGI
  views.factura = (el) => {
    el.innerHTML = `
      ${head('FACTURA DGI', 'h-yellow')}
      <div class="card dgi-box">
        <img src="assets/factura.jpg" alt="Factura DGI">
        <div><a class="btn yellow big" href="${esc(db.config.dgiUrl)}" target="_blank" rel="noopener">ABRIR PORTAL DE FACTURACIÓN DGI ↗</a></div>
        <p>Se abre el portal web de facturación electrónica de la DGI en una pestaña nueva.<br>
        Enlace actual: <b>${esc(db.config.dgiUrl)}</b></p>
        <p><a href="#ajustes" style="color:#fff">Cambiar el enlace en Ajustes</a></p>
      </div>`;
  };

  // ================================================================== ORDEN DE INGRESO
  const ESTADOS = ['Recibido', 'En reparación', 'Listo', 'Entregado'];

  function receiptHTML(o) {
    const c = clienteById(o.clienteId) || {};
    const cfg = db.config;
    const row = (k, v) => `<tr><th>${k}</th><td>${esc(v) || '&nbsp;'}</td></tr>`;
    return `<div class="receipt">
      <div class="r-head">
        <img src="assets/logo.jpg" alt="">
        <div><h3>${esc(cfg.negocio)}</h3><div>${esc(cfg.direccion)}</div><div>${cfg.telefono ? 'Tel/WhatsApp: ' + esc(cfg.telefono) : ''}</div></div>
        <div class="r-num">ORDEN DE INGRESO<br><b>${esc(o.numero)}</b><br>${fmtDate(o.fecha)}</div>
      </div>
      <table>
        ${row('Cliente', c.nombre)}${row('Tienda', c.tienda)}${row('WhatsApp', c.whatsapp)}
        ${row('Equipo', o.equipo)}${row('Marca / Modelo', [o.marca, o.modelo].filter(Boolean).join(' '))}
        ${row('IMEI / Serie', o.imei)}${row('Color', o.color)}${row('Clave / Patrón', o.clave)}
        ${row('Accesorios recibidos', o.accesorios)}${row('Falla reportada', o.falla)}
        ${row('Trabajo a realizar', o.trabajo)}${row('Técnico', o.tecnico)}
        ${row('Fecha estimada de entrega', fmtDate(o.entrega))}${row('Estado', o.estado)}
        ${row('Costo', money(o.costo))}${row('Abono', money(o.abono))}
        <tr><th>SALDO PENDIENTE</th><td><b>${money(Math.max(0, num(o.costo) - num(o.abono)))}</b></td></tr>
      </table>
      <div class="r-sign"><div>Firma del cliente</div><div>Recibido por SIMTEC</div></div>
      <p class="r-note">Conserve esta orden para retirar su equipo. Equipos no retirados en 30 días después de notificados no son responsabilidad del local. El local no se responsabiliza por la información almacenada en el equipo.</p>
    </div>`;
  }

  function openReceipt(o) {
    const c = clienteById(o.clienteId) || {};
    const msg = `Hola ${c.nombre || ''}, le saluda ${db.config.negocio}.\nOrden de ingreso: ${o.numero}\nEquipo: ${[o.equipo, o.marca, o.modelo].filter(Boolean).join(' ')}\nFalla: ${o.falla}\nCosto: ${money(o.costo)} | Abono: ${money(o.abono)} | Saldo: ${money(Math.max(0, num(o.costo) - num(o.abono)))}\nEstado: ${o.estado}`;
    const m = document.createElement('div');
    m.className = 'modal-back';
    m.innerHTML = `<div style="width:100%">
      <div class="modal-actions">
        <button class="btn primary" data-act="print">🖨 Imprimir / PDF</button>
        ${c.whatsapp ? `<a class="btn green" target="_blank" rel="noopener" href="${waLink(c.whatsapp, msg)}">💬 Enviar por WhatsApp</a>` : ''}
        <button class="btn" data-act="close">Cerrar</button>
      </div>
      ${receiptHTML(o)}
    </div>`;
    m.addEventListener('click', (e) => {
      const a = e.target.closest('[data-act]');
      if (e.target === m || (a && a.dataset.act === 'close')) m.remove();
      if (a && a.dataset.act === 'print') window.print();
    });
    document.body.appendChild(m);
  }

  views.orden = (el) => {
    el.innerHTML = `
      ${head('ORDEN DE INGRESO', 'h-blue', `<button class="btn green" id="or-xls">⬇ Descargar Excel</button>`)}
      <form class="card" id="or-form">
        <h2>Plantilla de servicio técnico</h2>
        <div class="form-grid">
          <div class="field"><label for="or-cli">Cliente registrado</label><select id="or-cli">${clienteOptions('', '— Cliente nuevo (llenar abajo) —')}</select></div>
          <div class="field nuevo"><label for="or-nom">Nombre (cliente nuevo)</label><input id="or-nom"></div>
          <div class="field nuevo"><label for="or-tie">Tienda</label><input id="or-tie"></div>
          <div class="field nuevo"><label for="or-wa">WhatsApp</label><input id="or-wa" type="tel"></div>
          <div class="field"><label for="or-eq">Equipo</label><select id="or-eq"><option>Celular</option><option>Tablet</option><option>Laptop</option><option>PC</option><option>Otro</option></select></div>
          <div class="field"><label for="or-marca">Marca</label><input id="or-marca" placeholder="Samsung, iPhone, Xiaomi…"></div>
          <div class="field"><label for="or-modelo">Modelo</label><input id="or-modelo"></div>
          <div class="field"><label for="or-imei">IMEI / Serie</label><input id="or-imei"></div>
          <div class="field"><label for="or-color">Color</label><input id="or-color"></div>
          <div class="field"><label for="or-clave">Clave / Patrón</label><input id="or-clave"></div>
          <div class="field full"><label for="or-acc">Accesorios recibidos</label><input id="or-acc" placeholder="Cargador, forro, chip, memoria…"></div>
          <div class="field full"><label for="or-falla">Falla reportada</label><textarea id="or-falla" required></textarea></div>
          <div class="field full"><label for="or-trab">Trabajo a realizar / Diagnóstico</label><textarea id="or-trab"></textarea></div>
          <div class="field"><label for="or-tec">Técnico</label><input id="or-tec"></div>
          <div class="field"><label for="or-ent">Fecha estimada de entrega</label><input id="or-ent" type="date"></div>
          <div class="field"><label for="or-costo">Costo</label><input id="or-costo" type="number" step="0.01" min="0" value="0"></div>
          <div class="field"><label for="or-abono">Abono</label><input id="or-abono" type="number" step="0.01" min="0" value="0"></div>
        </div>
        <div class="form-actions"><button class="btn primary big" type="submit">GUARDAR E IMPRIMIR</button></div>
      </form>
      <div class="toolbar"><div class="search"><input id="or-q" placeholder="Buscar por número, cliente, marca, IMEI…"></div></div>
      <div class="table-wrap"><table>
        <thead><tr><th>N°</th><th>Fecha</th><th>Cliente</th><th>Equipo</th><th>Estado</th><th class="num">Saldo</th><th></th></tr></thead>
        <tbody id="or-body"></tbody>
      </table></div>`;

    const toggleNuevo = () => $$('.field.nuevo', el).forEach((f) => (f.hidden = !!$('#or-cli').value));
    $('#or-cli').addEventListener('change', toggleNuevo);
    toggleNuevo();

    function render() {
      const q = $('#or-q').value.toLowerCase();
      const rows = db.ordenes
        .filter((o) => !q || [o.numero, clienteNombre(o.clienteId), o.marca, o.modelo, o.imei, o.falla].join(' ').toLowerCase().includes(q))
        .slice().reverse();
      $('#or-body').innerHTML = rows.length
        ? rows.map((o) => {
          const s = Math.max(0, num(o.costo) - num(o.abono) - abonosOrden(o));
          return `<tr>
            <td><b>${esc(o.numero)}</b></td>
            <td>${fmtDate(o.fecha)}</td>
            <td>${esc(clienteNombre(o.clienteId))}</td>
            <td>${esc([o.equipo, o.marca, o.modelo].filter(Boolean).join(' '))}</td>
            <td><select data-estado="${o.id}" class="btn sm" style="background:#000">${ESTADOS.map((e) => `<option ${e === o.estado ? 'selected' : ''}>${e}</option>`).join('')}</select></td>
            <td class="num">${s > 0 ? `<span class="tag due">${money(s)}</span>` : '<span class="tag ok">PAGADO</span>'}</td>
            <td class="actions"><button class="btn sm" data-ver="${o.id}">Ver / Imprimir</button><button class="btn sm red" data-del="${o.id}">Borrar</button></td>
          </tr>`;
        }).join('')
        : `<tr><td colspan="7" class="empty">Aún no hay órdenes de ingreso</td></tr>`;
    }
    // abonos hechos después desde Cartera
    const abonosOrden = (o) => {
      const d = db.cartera.find((x) => x.ordenId === o.id);
      return d ? abonado(d) : 0;
    };

    $('#or-form').addEventListener('submit', (e) => {
      e.preventDefault();
      let clienteId = $('#or-cli').value;
      if (!clienteId) {
        const nombre = $('#or-nom').value.trim();
        if (!nombre) {
          toast('Seleccione un cliente o escriba el nombre del cliente nuevo');
          $('#or-nom').focus();
          return;
        }
        clienteId = uid();
        db.clientes.push({ id: clienteId, fecha: today(), nombre, tienda: $('#or-tie').value.trim(), whatsapp: $('#or-wa').value.trim() });
      }
      db.seq.orden += 1;
      const o = {
        id: uid(), numero: 'SIM-' + String(db.seq.orden).padStart(4, '0'), fecha: today(), clienteId,
        equipo: $('#or-eq').value, marca: $('#or-marca').value.trim(), modelo: $('#or-modelo').value.trim(),
        imei: $('#or-imei').value.trim(), color: $('#or-color').value.trim(), clave: $('#or-clave').value.trim(),
        accesorios: $('#or-acc').value.trim(), falla: $('#or-falla').value.trim(), trabajo: $('#or-trab').value.trim(),
        tecnico: $('#or-tec').value.trim(), entrega: $('#or-ent').value,
        costo: num($('#or-costo').value), abono: num($('#or-abono').value), estado: 'Recibido',
      };
      o.abono = Math.min(o.abono, o.costo || o.abono);
      db.ordenes.push(o);
      if (o.abono > 0) {
        db.movimientos.push({ id: uid(), origen: 'orden', ordenId: o.id, fecha: today(), tipo: 'ingreso', concepto: `Abono orden ${o.numero}`, clienteId, monto: o.abono });
      }
      const pendiente = o.costo - o.abono;
      if (pendiente > 0) {
        db.cartera.push({ id: uid(), origen: 'orden', ordenId: o.id, clienteId, concepto: `Orden ${o.numero} - ${[o.equipo, o.marca, o.modelo].filter(Boolean).join(' ')}`, monto: pendiente, fecha: today(), abonos: [] });
      }
      save();
      $('#or-form').reset();
      $('#or-cli').innerHTML = clienteOptions('', '— Cliente nuevo (llenar abajo) —');
      toggleNuevo();
      render();
      toast(`Orden ${o.numero} guardada`);
      openReceipt(o);
    });
    $('#or-q').addEventListener('input', render);
    $('#or-body').addEventListener('change', (e) => {
      const s = e.target.closest('[data-estado]');
      if (s) {
        db.ordenes.find((o) => o.id === s.dataset.estado).estado = s.value;
        save();
        toast('Estado actualizado');
      }
    });
    $('#or-body').addEventListener('click', (e) => {
      const ver = e.target.closest('[data-ver]');
      const del = e.target.closest('[data-del]');
      if (ver) openReceipt(db.ordenes.find((o) => o.id === ver.dataset.ver));
      if (del) {
        const o = db.ordenes.find((x) => x.id === del.dataset.del);
        if (confirm(`¿Borrar la orden ${o.numero}? También se borra su deuda en cartera y su abono del reporte.`)) {
          db.ordenes = db.ordenes.filter((x) => x.id !== o.id);
          db.cartera = db.cartera.filter((x) => x.ordenId !== o.id);
          db.movimientos = db.movimientos.filter((x) => x.ordenId !== o.id);
          save();
          render();
        }
      }
    });
    $('#or-xls').addEventListener('click', () =>
      exportXLSX(`Ordenes_Ingreso_SIMTEC_${today()}.xlsx`, {
        Ordenes: db.ordenes.map((o) => ({
          'N°': o.numero, Fecha: fmtDate(o.fecha), Cliente: clienteNombre(o.clienteId), Equipo: o.equipo, Marca: o.marca, Modelo: o.modelo,
          'IMEI/Serie': o.imei, Color: o.color, Accesorios: o.accesorios, Falla: o.falla, Trabajo: o.trabajo, Técnico: o.tecnico,
          Entrega: fmtDate(o.entrega), Estado: o.estado, Costo: num(o.costo), Abono: num(o.abono) + abonosOrden(o),
          Saldo: Math.max(0, num(o.costo) - num(o.abono) - abonosOrden(o)),
        })),
      })
    );
    render();
  };

  // ================================================================== INVENTARIO
  views.inventario = (el) => {
    el.innerHTML = `
      ${head('INVENTARIO', 'h-yellow', `<button class="btn green" id="in-xls">⬇ Descargar Excel</button>`)}
      <form class="card" id="in-form">
        <h2>Agregar producto</h2>
        <div class="form-grid">
          <div class="field"><label for="in-prod">Producto</label><input id="in-prod" required placeholder="Ej: Pantalla Samsung A10" list="in-list"><datalist id="in-list"></datalist></div>
          <div class="field"><label for="in-cant">Cantidad</label><input id="in-cant" type="number" step="1" required value="1"></div>
        </div>
        <div class="form-actions"><button class="btn yellow big" type="submit">GUARDAR</button></div>
      </form>
      <div class="stats-row" id="in-stats"></div>
      <div class="toolbar"><div class="search"><input id="in-q" placeholder="Buscar producto…"></div></div>
      <div class="table-wrap"><table>
        <thead><tr><th>Producto</th><th class="num">Cantidad</th><th></th></tr></thead>
        <tbody id="in-body"></tbody>
      </table></div>`;

    function render() {
      const q = $('#in-q').value.toLowerCase();
      const rows = db.inventario.filter((p) => !q || p.producto.toLowerCase().includes(q)).sort((a, b) => a.producto.localeCompare(b.producto));
      $('#in-list').innerHTML = db.inventario.map((p) => `<option value="${esc(p.producto)}">`).join('');
      $('#in-body').innerHTML = rows.length
        ? rows.map((p) => `<tr>
            <td><b>${esc(p.producto)}</b> ${p.cantidad <= 0 ? '<span class="tag due">AGOTADO</span>' : p.cantidad <= 2 ? '<span class="tag in">POCAS</span>' : ''}</td>
            <td class="num" style="font-size:20px"><b>${p.cantidad}</b></td>
            <td class="actions">
              <button class="btn sm" data-mas="${p.id}" aria-label="Sumar uno">＋</button>
              <button class="btn sm" data-menos="${p.id}" aria-label="Restar uno">－</button>
              <button class="btn sm" data-edit="${p.id}">Editar</button>
              <button class="btn sm red" data-del="${p.id}">Borrar</button>
            </td></tr>`).join('')
        : `<tr><td colspan="3" class="empty">Inventario vacío</td></tr>`;
      $('#in-stats').innerHTML = `
        <div class="stat blue"><div class="label">Productos</div><div class="value">${db.inventario.length}</div></div>
        <div class="stat green"><div class="label">Unidades</div><div class="value">${db.inventario.reduce((s, p) => s + p.cantidad, 0)}</div></div>
        <div class="stat red"><div class="label">Agotados</div><div class="value">${db.inventario.filter((p) => p.cantidad <= 0).length}</div></div>`;
    }

    $('#in-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const producto = $('#in-prod').value.trim();
      const cantidad = Math.round(num($('#in-cant').value));
      const ex = db.inventario.find((p) => p.producto.toLowerCase() === producto.toLowerCase());
      if (ex) {
        ex.cantidad += cantidad;
        toast(`Se sumaron ${cantidad} a "${ex.producto}"`);
      } else {
        db.inventario.push({ id: uid(), producto, cantidad });
        toast('Producto guardado');
      }
      save();
      $('#in-form').reset();
      render();
    });
    $('#in-q').addEventListener('input', render);
    $('#in-body').addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      const id = b.dataset.mas || b.dataset.menos || b.dataset.edit || b.dataset.del;
      const p = db.inventario.find((x) => x.id === id);
      if (!p) return;
      if (b.dataset.mas) p.cantidad += 1;
      if (b.dataset.menos) p.cantidad = Math.max(0, p.cantidad - 1);
      if (b.dataset.edit) {
        const nombre = prompt('Nombre del producto:', p.producto);
        if (nombre === null) return;
        const cant = prompt('Cantidad:', p.cantidad);
        if (cant === null) return;
        p.producto = nombre.trim() || p.producto;
        p.cantidad = Math.max(0, Math.round(num(cant)));
      }
      if (b.dataset.del) {
        if (!confirm(`¿Borrar "${p.producto}" del inventario?`)) return;
        db.inventario = db.inventario.filter((x) => x.id !== id);
      }
      save();
      render();
    });
    $('#in-xls').addEventListener('click', () =>
      exportXLSX(`Inventario_SIMTEC_${today()}.xlsx`, {
        Inventario: db.inventario.map((p) => ({ Producto: p.producto, Cantidad: p.cantidad })),
      })
    );
    render();
  };

  // ================================================================== AJUSTES
  views.ajustes = (el) => {
    const c = db.config;
    el.innerHTML = `
      ${head('AJUSTES', 'h-blue')}
      <form class="card" id="aj-negocio">
        <h2>Datos del negocio (salen en la orden de ingreso)</h2>
        <div class="form-grid">
          <div class="field"><label for="aj-neg">Nombre</label><input id="aj-neg" value="${esc(c.negocio)}"></div>
          <div class="field"><label for="aj-tel">Teléfono / WhatsApp</label><input id="aj-tel" value="${esc(c.telefono)}"></div>
          <div class="field"><label for="aj-dir">Dirección</label><input id="aj-dir" value="${esc(c.direccion)}"></div>
          <div class="field"><label for="aj-mon">Símbolo de moneda</label><input id="aj-mon" value="${esc(c.moneda)}" maxlength="4"></div>
          <div class="field full"><label for="aj-dgi">Enlace del portal de facturación DGI</label><input id="aj-dgi" type="url" value="${esc(c.dgiUrl)}"></div>
        </div>
        <div class="form-actions"><button class="btn primary" type="submit">Guardar datos</button></div>
      </form>
      <form class="card" id="aj-login">
        <h2>Usuario y contraseña</h2>
        <div class="form-grid">
          <div class="field"><label for="aj-user">Usuario</label><input id="aj-user" value="${esc(ls.get('simtec_user') || 'admin')}" required autocomplete="username"></div>
          <div class="field"><label for="aj-pass">Nueva contraseña</label><input id="aj-pass" type="password" minlength="4" required autocomplete="new-password"></div>
        </div>
        <p style="color:var(--muted);margin:10px 0 0">Aplica para todas las computadoras. Las demás sesiones abiertas se cierran y deberán entrar con la nueva contraseña.</p>
        <div class="form-actions"><button class="btn primary" type="submit">Cambiar acceso</button></div>
      </form>
      <div class="card">
        <h2>Datos en la nube y copias</h2>
        <p style="color:var(--muted);margin-top:0">Todo se guarda automáticamente en la nube (Vercel) y se ve igual en todas las computadoras donde entre con su usuario. Además, cada día se guarda una copia de seguridad automática en la nube. Cuando quiera tener los datos en esta PC, use <b>Descargar todo en Excel</b>.</p>
        <div class="form-actions">
          <button class="btn green" id="aj-xls">⬇ Descargar todo en Excel</button>
          <button class="btn" id="aj-backup">⬇ Descargar copia (.json)</button>
          <label class="btn">⬆ Restaurar copia<input type="file" id="aj-restore" accept="application/json,.json" hidden></label>
        </div>
      </div>`;

    $('#aj-negocio').addEventListener('submit', (e) => {
      e.preventDefault();
      Object.assign(c, {
        negocio: $('#aj-neg').value.trim() || 'SIMTEC', telefono: $('#aj-tel').value.trim(), direccion: $('#aj-dir').value.trim(),
        moneda: $('#aj-mon').value.trim() || '$', dgiUrl: $('#aj-dgi').value.trim() || c.dgiUrl,
      });
      save();
      toast('Datos guardados');
    });
    $('#aj-login').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        const r = await api('POST', 'password', { user: $('#aj-user').value.trim(), pass: $('#aj-pass').value });
        token = r.token;
        ls.set(TOKEN_KEY, token);
        ls.set('simtec_user', r.user);
        $('#aj-pass').value = '';
        toast('Usuario y contraseña actualizados');
      } catch (err) {
        if (err instanceof AuthError) return handleSyncError(err);
        toast(navigator.onLine ? err.message : 'Sin conexión: no se pudo cambiar la contraseña');
      }
    });
    $('#aj-xls').addEventListener('click', () =>
      exportXLSX(`SIMTEC_Completo_${today()}.xlsx`, {
        Clientes: db.clientes.map((x) => ({ Nombre: x.nombre, Tienda: x.tienda, WhatsApp: x.whatsapp })),
        Cartera: db.cartera.map((d) => ({ Fecha: fmtDate(d.fecha), Cliente: clienteNombre(d.clienteId), Concepto: d.concepto, Monto: num(d.monto), Abonado: abonado(d), Debe: saldo(d) })),
        Reporte: db.movimientos.map((m) => ({ Fecha: fmtDate(m.fecha), Tipo: m.tipo, Concepto: m.concepto, Cliente: clienteNombre(m.clienteId), Monto: m.tipo === 'gasto' ? -num(m.monto) : num(m.monto) })),
        Ordenes: db.ordenes.map((o) => ({ 'N°': o.numero, Fecha: fmtDate(o.fecha), Cliente: clienteNombre(o.clienteId), Equipo: [o.equipo, o.marca, o.modelo].join(' '), Falla: o.falla, Estado: o.estado, Costo: num(o.costo), Abono: num(o.abono) })),
        Inventario: db.inventario.map((p) => ({ Producto: p.producto, Cantidad: p.cantidad })),
      })
    );
    $('#aj-backup').addEventListener('click', () => {
      const blob = new Blob([JSON.stringify(db, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `SIMTEC_copia_${today()}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    });
    $('#aj-restore').addEventListener('change', (e) => {
      const f = e.target.files[0];
      if (!f) return;
      const r = new FileReader();
      r.onload = () => {
        try {
          const data = JSON.parse(r.result);
          if (!data || !Array.isArray(data.clientes)) throw new Error('formato');
          if (!confirm('Esto reemplazará TODOS los datos de la nube (en todas las computadoras) por los de la copia. ¿Continuar?')) return;
          api('POST', 'data', { replace: normalize(data) })
            .then((res) => {
              synced = normalize(res.data);
              db = clone(synced);
              version = res.version;
              cacheLocal();
              toast('Copia restaurada');
              route();
            })
            .catch((err) => (err instanceof AuthError ? handleSyncError(err) : toast('No se pudo restaurar: ' + err.message)));
        } catch (err) {
          toast('El archivo no es una copia válida de SIMTEC');
        }
      };
      r.readAsText(f);
    });
  };

  // ------------------------------------------------------------------ inicio
  if (isLogged()) {
    showApp();
    if (hasPending()) push();
    else pull({ rerender: true });
  } else showLogin();
})();
