/* SIMTEC - Tecnología Informática
 * App web de una sola página. Los datos se guardan en la nube (Vercel, carpeta /api)
 * y se comparten entre todas las computadoras; cada sección se puede descargar a Excel (.xlsx).
 */
(function () {
  'use strict';

  const TOKEN_KEY = 'simtec_token';
  const CACHE_KEY = 'simtec_cache_v2';
  const OLD_LOCAL_KEY = 'simtec_db_v1'; // datos de la versión anterior (solo en este navegador)
  const COLLECTIONS = ['clientes', 'cartera', 'movimientos', 'ordenes', 'inventario', 'cierres'];
  const ENCARGADO_WA = '6240-9181'; // recibe siempre el cierre del día (se puede cambiar en Ajustes)
  const encargado = () => db.config.encargadoWa || ENCARGADO_WA;

  // ------------------------------------------------------------------ datos
  const emptyDB = () => ({
    config: {
      dgiUrl: 'https://dgi.mef.gob.pa/',
      negocio: 'SIMTEC Tecnología Informática',
      telefono: '',
      direccion: '',
      moneda: '$',
      paisWa: '507',
      encargadoWa: ENCARGADO_WA,
      importOct2026: '',
    },
    seq: { orden: 0, factura: 0 },
    clientes: [],
    cartera: [],
    movimientos: [],
    ordenes: [],
    inventario: [],
    cierres: [],
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

  // Colores de la app (se guarda en este equipo): 'clasico' o 'rojo' (solo rojo, blanco y negro)
  const TEMA_KEY = 'simtec_tema';
  const aplicarTema = (t) => { document.documentElement.dataset.tema = t === 'rojo' ? 'rojo' : 'clasico'; };
  aplicarTema(ls.get(TEMA_KEY));

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
    const seq = {};
    ['orden', 'factura'].forEach((k) => { if ((b.seq[k] || 0) > (a.seq[k] || 0)) seq[k] = b.seq[k]; });
    const hasSeq = Object.keys(seq).length > 0;
    if (!ops.length && !hasConfig && !hasSeq) return null;
    return { ops, config: hasConfig ? config : undefined, seq: hasSeq ? seq : undefined };
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
    if (ch.seq) Object.keys(ch.seq).forEach((k) => (data.seq[k] = Math.max(data.seq[k] || 0, ch.seq[k])));
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

  // Sube ya los cambios pendientes y espera la respuesta (máx. ~5 s; sin conexión sigue igual).
  async function syncNow() {
    clearTimeout(pushTimer);
    for (let i = 0; i < 25 && hasPending(); i++) {
      if (!pushing) await push();
      else await new Promise((r) => setTimeout(r, 200));
      if (document.querySelector('#sync-status.bad')) break;
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
      importarOctubre();
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
  // Sincronización automática: cada 10 s mientras se usa la app; si nadie la toca en 5 min, cada minuto.
  let ultimoUso = Date.now();
  ['pointerdown', 'keydown', 'touchstart'].forEach((ev) => window.addEventListener(ev, () => { ultimoUso = Date.now(); }, { passive: true }));
  let ultimoPull = 0;
  setInterval(() => {
    if (document.visibilityState !== 'visible') return;
    const espera = Date.now() - ultimoUso > 300000 ? 60000 : 10000;
    if (Date.now() - ultimoPull < espera) return;
    ultimoPull = Date.now();
    pull({ rerender: true });
  }, 2000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') { ultimoPull = Date.now(); pull({ rerender: true }); }
  });

  // ---- instalar como aplicación (PWA): ícono en el escritorio / pantalla de inicio, ventana propia
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  let installPrompt = null;
  const installButtons = () => $$('[data-install]');
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault(); // se muestra nuestro botón en lugar del aviso del navegador
    installPrompt = e;
    installButtons().forEach((b) => (b.hidden = false));
  });
  window.addEventListener('appinstalled', () => {
    installPrompt = null;
    installButtons().forEach((b) => (b.hidden = true));
    toast('SIMTEC quedó instalado ✅ Búsquelo en el escritorio o en sus aplicaciones');
  });
  document.addEventListener('click', async (e) => {
    if (!e.target.closest('[data-install]') || !installPrompt) return;
    installPrompt.prompt();
    await installPrompt.userChoice.catch(() => {});
    installPrompt = null;
    installButtons().forEach((b) => (b.hidden = true));
  });

  // ---- versión nueva de la página (después de cada publicación en Vercel): se actualiza sola.
  // La versión actual sale del ?v= con que se cargó este archivo, así nunca queda desfasada.
  const APP_VERSION = (() => {
    try { return new URL(document.currentScript.src).searchParams.get('v'); } catch (e) { return null; }
  })();
  let actualizando = false;
  async function checkVersion() {
    if (!APP_VERSION || actualizando) return;
    try {
      const r = await fetch('version.json?t=' + Date.now(), { cache: 'no-store' });
      const { v } = await r.json();
      if (!v || v === APP_VERSION) return;
      // espera a que no estén escribiendo ni con una ventana abierta (orden, cierre, escáner…)
      const active = document.activeElement;
      const typing = active && /INPUT|SELECT|TEXTAREA/.test(active.tagName);
      const filled = $$('#view form input, #view form textarea').some((i) => i.type !== 'date' && i.type !== 'number' && i.value);
      if (typing || filled || document.querySelector('.modal-back')) return;
      actualizando = true;
      if (hasPending()) await push();
      if (hasPending()) { actualizando = false; return; } // sin internet: no perder lo anotado
      toast('Actualizando SIMTEC…');
      setTimeout(() => location.reload(), 600);
    } catch (e) { /* sin conexión */ }
  }
  setInterval(checkVersion, 60000);
  window.addEventListener('focus', checkVersion);
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && checkVersion());
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
  // número para WhatsApp: si se anotó sin código de país (p. ej. 6123-4567) se le agrega el de Ajustes (507 = Panamá)
  const waDigits = (s) => {
    const d = String(s || '').replace(/\D/g, '');
    const pais = String(db.config.paisWa || '').replace(/\D/g, '');
    return d && pais && d.length <= 8 ? pais + d : d;
  };
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
    let name = location.hash.replace('#', '') || 'menu';
    let scanCode = null;
    if (name.startsWith('scan')) {
      // link del código QR: abre Orden de ingreso con esa orden
      scanCode = decodeURIComponent(name.split('/')[1] || '');
      name = 'orden';
      history.replaceState(null, '', '#orden');
    }
    const view = views[name] || views.menu;
    const main = $('#view');
    const y = window.scrollY;
    main.innerHTML = '';
    view(main);
    window.scrollTo(0, keepScroll ? y : 0);
    if (scanCode !== null) openScanner(scanCode);
  }

  // En el celular las tablas se ven como tarjetas: cada dato lleva el nombre de su columna.
  function etiquetarTablas() {
    $$('.table-wrap table').forEach((t) => {
      const cols = $$('thead th', t).map((th) => th.textContent.trim());
      $$('tbody tr', t).forEach((tr) => {
        let i = 0;
        Array.from(tr.cells).forEach((td) => {
          const span = td.colSpan || 1;
          const lab = span === 1 ? cols[i] || '' : '';
          if (td.dataset.col !== lab) td.dataset.col = lab;
          i += span;
        });
      });
    });
  }
  let etiquetaPend = false;
  new MutationObserver(() => {
    if (etiquetaPend) return;
    etiquetaPend = true;
    requestAnimationFrame(() => { etiquetaPend = false; etiquetarTablas(); });
  }).observe(document.body, { childList: true, subtree: true });

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
  // Las deudas de órdenes pasan a Cartera con el CIERRE DEL DÍA (o solas al día siguiente si no se cerró).
  const esperaCierre = (d) => d.origen === 'orden' || d.origen === 'diario';
  const enCartera = (d) => !esperaCierre(d) || !!d.cerrado || d.fecha < today();
  const ordenById = (id) => db.ordenes.find((o) => o.id === id);
  const modeloDe = (d) => {
    const o = d.ordenId && ordenById(d.ordenId);
    return o ? [o.marca, o.modelo].filter(Boolean).join(' ') || o.equipo || 'Equipo' : d.concepto;
  };
  // "4 × Honor 400 Lite, 1 × Samsung A15"
  const resumenModelos = (deudas) => {
    const m = new Map();
    deudas.forEach((d) => m.set(modeloDe(d), (m.get(modeloDe(d)) || 0) + 1));
    return [...m].map(([k, n]) => (n > 1 ? `${n} × ${k}` : k)).join(', ');
  };
  // agrupa deudas por cliente
  const porCliente = (deudas) => {
    const g = new Map();
    deudas.forEach((d) => {
      const r = g.get(d.clienteId) || { clienteId: d.clienteId, deudas: [], monto: 0, abonado: 0, debe: 0 };
      r.deudas.push(d);
      r.monto += num(d.monto);
      r.abonado += abonado(d);
      r.debe += saldo(d);
      g.set(d.clienteId, r);
    });
    return [...g.values()].sort((a, b) => b.debe - a.debe);
  };
  // registra un abono a un cliente repartiéndolo en sus deudas, de la más vieja a la más nueva
  function abonarCliente(clienteId, deudas, monto, concepto) {
    let resto = monto;
    deudas.filter((d) => saldo(d) > 0).sort((a, b) => a.fecha.localeCompare(b.fecha)).forEach((d) => {
      if (resto <= 0) return;
      const m = Math.min(resto, saldo(d));
      d.abonos.push({ fecha: today(), monto: m });
      resto -= m;
    });
    db.movimientos.push({ id: uid(), origen: 'abono', fecha: today(), tipo: 'ingreso', concepto, clienteId, monto: monto - resto });
    save();
  }

  views.cartera = (el) => {
    el.innerHTML = `
      ${head('CARTERA', 'h-yellow', `<button class="btn green" id="ca-xls">⬇ Descargar Excel</button>`)}
      <div class="stats-row" id="ca-stats"></div>
      <div class="toolbar">
        <div class="search"><input id="ca-q" placeholder="Buscar cliente o modelo…"></div>
        <div class="seg" id="ca-vista"><button class="on" data-v="cliente">Por cliente</button><button data-v="detalle">Detalle</button></div>
        <div class="seg" id="ca-filtro"><button class="on" data-f="pend">Pendientes</button><button data-f="all">Todas</button></div>
      </div>
      <div class="table-wrap"><table>
        <thead id="ca-head"></thead>
        <tbody id="ca-body"></tbody>
        <tfoot><tr><td id="ca-total-lab">TOTAL QUE ME DEBEN</td><td class="num" id="ca-total"></td><td></td></tr></tfoot>
      </table></div>
      <p id="ca-pend" class="hint-line"></p>
      <form class="card" id="ca-form" style="margin-top:18px">
        <h2>Agregar deuda a mano</h2>
        <div class="form-grid">
          <div class="field"><label for="ca-cli">Cliente</label><select id="ca-cli" required>${clienteOptions()}</select></div>
          <div class="field"><label for="ca-con">Concepto / modelo</label><input id="ca-con" required placeholder="Ej: Honor 400 Lite"></div>
          <div class="field"><label for="ca-monto">Monto</label><input id="ca-monto" type="number" step="0.01" min="0" required></div>
          <div class="field"><label for="ca-fecha">Fecha</label><input id="ca-fecha" type="date" value="${today()}"></div>
        </div>
        <div class="form-actions"><button class="btn yellow big" type="submit">GUARDAR</button>
        ${db.clientes.length ? '' : '<span style="color:var(--muted)">Primero cree clientes en la sección <a href="#clientes" style="color:#fff">Clientes</a>.</span>'}</div>
      </form>`;

    let filtro = 'pend';
    let vista = 'cliente';
    // ---- cuenta de un cliente: lista completa de lo que debe y resumen para WhatsApp
    const deudasDe = (id) => db.cartera.filter((d) => enCartera(d) && d.clienteId === id && saldo(d) > 0).sort((a, b) => a.fecha.localeCompare(b.fecha));
    function resumenCuenta(id) {
      const c = clienteById(id) || {};
      const ds = deudasDe(id);
      const debe = ds.reduce((t, d) => t + saldo(d), 0);
      const abon = ds.reduce((t, d) => t + abonado(d), 0);
      return [
        `*${db.config.negocio}*`,
        `Estado de cuenta: *${c.nombre || ''}*`,
        `Fecha: ${fmtDate(today())}`,
        '',
        ...ds.map((d) => `• ${fmtDate(d.fecha)} · ${modeloDe(d)} · ${money(saldo(d))}${abonado(d) > 0 ? ` (abonó ${money(abonado(d))})` : ''}`),
        '',
        `Equipos: ${resumenModelos(ds)}`,
        ...(abon > 0 ? [`Ya abonado: ${money(abon)}`] : []),
        `*TOTAL A PAGAR: ${money(debe)}*`,
        '',
        '¡Gracias por su preferencia!',
      ].join('\n');
    }
    // resumen de la cuenta en imagen (mismo diseño que la orden)
    async function enviarResumen(id) {
      const c = clienteById(id) || {};
      const ds = deudasDe(id);
      const debe = ds.reduce((t, d) => t + saldo(d), 0);
      const total = ds.reduce((t, d) => t + num(d.monto), 0);
      toast('Preparando imagen…');
      const blob = await tarjetaImagen({
        nombre: c.nombre,
        aviso: 'ESTADO DE CUENTA',
        filas: [
          { icono: '📌', etiqueta: 'Fecha:', valor: fmtDate(today()), color: 'azul' },
          { icono: '📱', etiqueta: 'Equipos:', valor: resumenModelos(ds) || '-', color: 'rosa' },
          { icono: '🧾', etiqueta: 'Deudas:', valor: `${ds.length} ${ds.length === 1 ? 'pendiente' : 'pendientes'}`, color: 'amarillo' },
          { icono: '💵', etiqueta: 'Total:', valor: money(total), color: 'verde' },
          { icono: '💳', etiqueta: 'Abonado:', valor: money(total - debe), color: 'morado' },
          { icono: '👛', etiqueta: 'A pagar:', valor: money(debe), color: 'naranja' },
        ],
      });
      compartirImagen(blob, `SIMTEC_cuenta_${(c.nombre || 'cliente').replace(/\W+/g, '_')}.png`, `Estado de cuenta · ${db.config.negocio}`, c.whatsapp);
    }
    function verCuenta(id) {
      const c = clienteById(id) || {};
      const todas = db.cartera.filter((d) => enCartera(d) && d.clienteId === id).sort((a, b) => b.fecha.localeCompare(a.fecha));
      const ds = deudasDe(id);
      const debe = ds.reduce((t, d) => t + saldo(d), 0);
      const total = todas.reduce((t, d) => t + num(d.monto), 0);
      const abon = todas.reduce((t, d) => t + abonado(d), 0);
      const abonos = todas.flatMap((d) => (d.abonos || []).map((a) => ({ ...a, modelo: modeloDe(d) }))).sort((a, b) => b.fecha.localeCompare(a.fecha));
      openModal(`
        <div class="card cierre-box cuenta-box">
          <h2>📋 Cuenta de ${esc(c.nombre || '(cliente borrado)')}</h2>
          <p class="hint-line" style="margin:-4px 0 12px">${[c.tienda && esc(c.tienda), c.whatsapp && `WhatsApp ${esc(c.whatsapp)}`].filter(Boolean).join(' · ') || 'Sin tienda ni WhatsApp guardado'}</p>
          <div class="stats-row">
            <div class="stat red"><div class="label">Debe</div><div class="value">${money(debe)}</div></div>
            <div class="stat yellow"><div class="label">Equipos pendientes</div><div class="value">${ds.length}</div></div>
            <div class="stat green"><div class="label">Abonado</div><div class="value">${money(abon)}</div></div>
            <div class="stat blue"><div class="label">Total histórico</div><div class="value">${money(total)}</div></div>
          </div>
          <div class="table-wrap"><table>
            <thead><tr><th>Fecha</th><th>Equipo / modelo</th><th>Orden</th><th class="num">Monto</th><th class="num">Abonado</th><th class="num">Debe</th></tr></thead>
            <tbody>${todas.map((d) => {
              const o = d.ordenId && ordenById(d.ordenId);
              const s = saldo(d);
              return `<tr><td>${fmtDate(d.fecha)}</td><td>${esc(modeloDe(d))}</td><td>${o ? `${esc(o.numero)}${o.factura != null ? ` · N°${esc(o.factura)}` : ''}` : '—'}</td>
                <td class="num">${money(d.monto)}</td><td class="num">${money(abonado(d))}</td>
                <td class="num">${s > 0 ? `<span class="tag due">${money(s)}</span>` : '<span class="tag ok">PAGADO</span>'}</td></tr>`;
            }).join('') || '<tr><td colspan="6" class="empty">Sin deudas</td></tr>'}</tbody>
            <tfoot><tr><td colspan="5">TOTAL A PAGAR</td><td class="num">${money(debe)}</td></tr></tfoot>
          </table></div>
          ${abonos.length ? `<p class="hint-line"><b>Abonos:</b> ${abonos.map((a) => `${fmtDate(a.fecha)} ${money(a.monto)} (${esc(a.modelo)})`).join(' · ')}</p>` : ''}
          ${debe > 0 ? `<h2 style="margin-top:16px;font-size:20px">Resumen para WhatsApp</h2><pre class="cierre-resumen">${esc(resumenCuenta(id).replace(/\*/g, ''))}</pre>` : ''}
          <div class="modal-actions">
            ${debe > 0 ? `<button class="btn green" data-act="wa">🖼 Enviar resumen en imagen</button><button class="btn" data-act="watexto">💬 Enviar solo texto</button><button class="btn" data-act="copiar">📄 Copiar resumen</button><button class="btn yellow" data-act="abonar">Abonar</button>` : ''}
            <button class="btn" data-act="close">Cerrar</button>
          </div>
        </div>`, (e, a, close) => {
        if (!a) return;
        if (a.dataset.act === 'wa') enviarResumen(id);
        if (a.dataset.act === 'watexto') {
          const c = clienteById(id) || {};
          window.open(waDigits(c.whatsapp) ? waLink(c.whatsapp, resumenCuenta(id)) : 'https://wa.me/?text=' + encodeURIComponent(resumenCuenta(id)), '_blank', 'noopener');
        }
        if (a.dataset.act === 'copiar') {
          const t = resumenCuenta(id).replace(/\*/g, '');
          (navigator.clipboard ? navigator.clipboard.writeText(t) : Promise.reject()).then(() => toast('Resumen copiado'), () => toast('No se pudo copiar'));
        }
        if (a.dataset.act === 'abonar') {
          close();
          abonarDe(id);
        }
      });
    }

    function render() {
      const q = $('#ca-q').value.toLowerCase();
      const visibles = db.cartera.filter(enCartera);
      const deudas = visibles.filter((d) => filtro === 'all' || saldo(d) > 0);
      const match = (d) => !q || [clienteNombre(d.clienteId), d.concepto, modeloDe(d)].join(' ').toLowerCase().includes(q);

      if (vista === 'cliente') {
        $('#ca-head').innerHTML = '<tr><th>Cliente</th><th>Equipos / modelos</th><th class="num">Total</th><th class="num">Abonado</th><th class="num">Debe</th><th></th></tr>';
        $('#ca-total-lab').colSpan = 4;
        const grupos = porCliente(deudas.filter(match));
        $('#ca-body').innerHTML = grupos.length
          ? grupos.map((g) => {
            const c = clienteById(g.clienteId) || {};
            return `<tr>
              <td><b>${esc(c.nombre || '(cliente borrado)')}</b>${c.tienda ? `<br><small style="color:var(--muted)">${esc(c.tienda)}</small>` : ''}</td>
              <td>${esc(resumenModelos(g.deudas))}<br><small style="color:var(--muted)">${g.deudas.length} ${g.deudas.length === 1 ? 'deuda' : 'deudas'} · desde ${fmtDate(g.deudas.map((d) => d.fecha).sort()[0])}</small></td>
              <td class="num">${money(g.monto)}</td>
              <td class="num">${money(g.abonado)}</td>
              <td class="num">${g.debe > 0 ? `<span class="tag due">${money(g.debe)}</span>` : '<span class="tag ok">PAGADO</span>'}</td>
              <td class="actions">
                ${g.debe > 0 ? `<button class="btn sm green" data-abono-cli="${g.clienteId}">Abonar</button>` : ''}
                <button class="btn sm" data-cuenta="${g.clienteId}">📋 Ver cuenta</button>
                ${g.debe > 0 ? `<button class="btn sm" data-wa-cli="${g.clienteId}">💬 Resumen</button>` : ''}
              </td></tr>`;
          }).join('')
          : `<tr><td colspan="6" class="empty">Nadie le debe 🎉</td></tr>`;
      } else {
        $('#ca-head').innerHTML = '<tr><th>Fecha</th><th>Cliente</th><th>Concepto / modelo</th><th class="num">Monto</th><th class="num">Abonado</th><th class="num">Debe</th><th></th></tr>';
        $('#ca-total-lab').colSpan = 5;
        const rows = deudas.filter(match).sort((a, b) => b.fecha.localeCompare(a.fecha));
        $('#ca-body').innerHTML = rows.length
          ? rows.map((d) => {
            const c = clienteById(d.clienteId) || {};
            const s = saldo(d);
            return `<tr>
              <td>${fmtDate(d.fecha)}</td>
              <td><b>${esc(c.nombre || '(cliente borrado)')}</b></td>
              <td>${esc(modeloDe(d))}${d.ordenId ? `<br><small style="color:var(--muted)">${esc(d.concepto.split(' - ')[0])}</small>` : ''}</td>
              <td class="num">${money(d.monto)}</td>
              <td class="num">${money(abonado(d))}</td>
              <td class="num">${s > 0 ? `<span class="tag due">${money(s)}</span>` : '<span class="tag ok">PAGADO</span>'}</td>
              <td class="actions">
                ${s > 0 ? `<button class="btn sm green" data-abono="${d.id}">Abonar</button>` : ''}
                <button class="btn sm red" data-del="${d.id}">Borrar</button>
              </td></tr>`;
          }).join('')
          : `<tr><td colspan="7" class="empty">Nadie le debe 🎉</td></tr>`;
      }

      const total = visibles.reduce((s, d) => s + saldo(d), 0);
      const deudores = new Set(visibles.filter((d) => saldo(d) > 0).map((d) => d.clienteId)).size;
      $('#ca-total').textContent = money(total);
      $('#ca-stats').innerHTML = `
        <div class="stat yellow"><div class="label">Total por cobrar</div><div class="value">${money(total)}</div></div>
        <div class="stat red"><div class="label">Clientes que deben</div><div class="value">${deudores}</div></div>
        <div class="stat green"><div class="label">Cobrado (abonos)</div><div class="value">${money(visibles.reduce((s, d) => s + abonado(d), 0))}</div></div>`;
      const pendHoy = db.cartera.filter((d) => !enCartera(d) && saldo(d) > 0);
      $('#ca-pend').innerHTML = pendHoy.length
        ? `⏳ Hay ${pendHoy.length} ${pendHoy.length === 1 ? 'trabajo' : 'trabajos'} de hoy con saldo (${money(pendHoy.reduce((s, d) => s + saldo(d), 0))}) que pasan a Cartera con el <a href="#reporte">cierre del día</a>.`
        : '';
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
    $$('#ca-filtro button', el).forEach((b) => b.addEventListener('click', () => {
      $$('#ca-filtro button', el).forEach((x) => x.classList.toggle('on', x === b));
      filtro = b.dataset.f;
      render();
    }));
    const setVista = (v) => {
      vista = v;
      $$('#ca-vista button', el).forEach((x) => x.classList.toggle('on', x.dataset.v === v));
      render();
    };
    $$('#ca-vista button', el).forEach((b) => b.addEventListener('click', () => setVista(b.dataset.v)));
    function abonarDe(id) {
      const deudas = deudasDe(id);
      const debe = deudas.reduce((t, d) => t + saldo(d), 0);
      const v = prompt(`Abono de ${clienteNombre(id)} (debe ${money(debe)} por ${resumenModelos(deudas)}):`, debe.toFixed(2));
      if (v === null) return;
      const m = Math.min(num(v), debe);
      if (m <= 0) return;
      abonarCliente(id, deudas, m, `Abono cartera: ${resumenModelos(deudas)}`);
      toast('Abono registrado y sumado al reporte diario');
      render();
    }
    $('#ca-body').addEventListener('click', (e) => {
      const abCli = e.target.closest('[data-abono-cli]');
      const verCli = e.target.closest('[data-ver-cli]');
      const ab = e.target.closest('[data-abono]');
      const del = e.target.closest('[data-del]');
      const cuenta = e.target.closest('[data-cuenta]');
      const waCli = e.target.closest('[data-wa-cli]');
      if (abCli) abonarDe(abCli.dataset.abonoCli);
      if (cuenta) verCuenta(cuenta.dataset.cuenta);
      if (waCli) enviarResumen(waCli.dataset.waCli);
      if (verCli) {
        $('#ca-q').value = verCli.dataset.verCli;
        setVista('detalle');
      }
      if (ab) {
        const d = db.cartera.find((x) => x.id === ab.dataset.abono);
        const v = prompt(`Abono para "${modeloDe(d)}" (debe ${money(saldo(d))}):`, saldo(d).toFixed(2));
        if (v === null) return;
        const m = Math.min(num(v), saldo(d));
        if (m <= 0) return;
        abonarCliente(d.clienteId, [d], m, `Abono cartera: ${modeloDe(d)}`);
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
    $('#ca-xls').addEventListener('click', () => {
      const visibles = db.cartera.filter(enCartera);
      exportXLSX(`Cartera_SIMTEC_${today()}.xlsx`, {
        'Por cliente': porCliente(visibles.filter((d) => saldo(d) > 0)).map((g) => {
          const c = clienteById(g.clienteId) || {};
          return { Cliente: c.nombre || '', Tienda: c.tienda || '', WhatsApp: c.whatsapp || '', Modelos: resumenModelos(g.deudas), Total: g.monto, Abonado: g.abonado, Debe: g.debe };
        }),
        Detalle: visibles.map((d) => {
          const c = clienteById(d.clienteId) || {};
          return {
            Fecha: fmtDate(d.fecha), Cliente: c.nombre || '', Tienda: c.tienda || '', Modelo: modeloDe(d), Concepto: d.concepto,
            Monto: num(d.monto), Abonado: abonado(d), Debe: saldo(d), Estado: saldo(d) > 0 ? 'PENDIENTE' : 'PAGADO',
          };
        }),
      });
    });
    render();
  };

  // ================================================================== ESTADÍSTICA
  views.estadistica = (el) => {
    el.innerHTML = `
      ${head('ESTADÍSTICA', 'h-blue')}
      <div class="stats-row" id="es-stats"></div>
      <div class="card fallas-card"><h2>Trabajos</h2><div class="fallas-row" id="es-fallas"></div></div>
      <div class="card"><h2>🏆 Ranking de clientes</h2><p class="es-sub">Del que más trabajos trae al que menos · en cada barra: trabajos y dinero</p><div class="rank" id="es-rank"></div></div>`;

    // Trabajos: órdenes de ingreso + ventas manuales del reporte + deudas manuales de cartera.
    // Consumo: costo de órdenes + ventas manuales + deudas manuales (los abonos no cuentan doble).
    function compute() {
      const m = new Map();
      const add = (id, monto, n = 1) => {
        if (!id) return;
        const r = m.get(id) || { id, trabajos: 0, dinero: 0 };
        r.trabajos += n;
        r.dinero += num(monto);
        m.set(id, r);
      };
      db.ordenes.forEach((o) => add(o.clienteId, o.costo));
      db.movimientos.filter((x) => x.origen === 'manual' && x.tipo === 'ingreso').forEach((x) => add(x.clienteId, x.total != null ? x.total : x.monto, num(x.cantidad) || 1));
      // los saldos importados ya están contados en sus trabajos del reporte
      db.cartera.filter((x) => x.origen === 'manual' && !x.importado).forEach((x) => add(x.clienteId, x.monto));
      return Array.from(m.values()).filter((r) => clienteById(r.id));
    }

    // total hasta la fecha de FRP / KG / PAY: órdenes (botones de falla) + reporte diario (texto del trabajo)
    function contarFallas() {
      const tipos = [
        { k: 'FRP', re: /\bFRP\b/i },
        { k: 'KG', re: /\bKG\b/i },
        { k: 'PAY', re: /\bPAY\s*JOY\b|\bPAY\b/i },
      ];
      const items = [
        ...db.ordenes.map((o) => ({ texto: o.falla || '', fecha: o.fecha, n: 1 })),
        ...db.movimientos.filter((m) => m.origen === 'manual' && m.tipo !== 'gasto').map((m) => ({ texto: m.concepto || '', fecha: m.fecha, n: num(m.cantidad) || 1 })),
      ];
      return tipos.map((t) => {
        const r = { ...t, total: 0 };
        items.filter((x) => t.re.test(x.texto)).forEach((x) => { r.total += x.n; });
        return r;
      });
    }

    // una sola lista: en la misma barra van los trabajos y el dinero de cada cliente
    function render() {
      $('#es-fallas').innerHTML = contarFallas().map((f) => `
        <div class="falla-box">
          <div class="falla-k">${f.k}</div>
          <div class="falla-n" data-count="${f.total}">0</div>
        </div>`).join('');
      const data = compute().sort((a, b) => b.trabajos - a.trabajos || b.dinero - a.dinero);
      const max = Math.max(1, ...data.map((r) => r.trabajos));
      $('#es-rank').innerHTML = data.length
        ? data.map((r, i) => {
          const c = clienteById(r.id);
          return `<div class="rank-row" style="animation-delay:${i * 0.06}s">
            <div class="rank-pos">${i + 1}</div>
            <div class="rank-name">${esc(c.nombre)}<small>${esc(c.tienda || '')}</small></div>
            <div class="bar-track"><div class="bar c${i % 5}" data-w="${Math.max(6, (r.trabajos / max) * 100)}">${r.trabajos} ${r.trabajos === 1 ? 'trabajo' : 'trabajos'} · ${money(r.dinero)}</div></div>
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

    render();
  };

  // ================================================================== REPORTE DIARIO
  // Se anotan los trabajos/ventas del día con lo que el cliente pagó. Lo que quedó debiendo
  // (de aquí y de las órdenes de ingreso) pasa solo a Cartera con el CIERRE DEL DÍA.
  const pendientesDelDia = (f) => db.cartera.filter((d) => esperaCierre(d) && d.fecha === f && saldo(d) > 0);
  const cierreDe = (f) => db.cierres.find((c) => c.fecha === f);

  // ---- PDF del cierre y de la cartera (se guardan como datos en la nube y se pueden volver a generar)
  const loadScript = (src) => new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = res;
    s.onerror = () => rej(new Error('No se pudo cargar ' + src));
    document.head.appendChild(s);
  });
  let pdfLib;
  const loadPdf = () =>
    pdfLib || (pdfLib = loadScript('vendor/jspdf.umd.min.js').then(() => loadScript('vendor/jspdf.plugin.autotable.min.js')).then(() => window.jspdf.jsPDF));
  let logoData;
  const loadLogo = () =>
    logoData || (logoData = fetch('assets/logo.jpg').then((r) => r.blob()).then((b) => new Promise((res) => {
      const fr = new FileReader();
      fr.onload = () => res(fr.result);
      fr.readAsDataURL(b);
    })).catch(() => null));

  // fotografía del día que se guarda con el cierre (para poder sacar el PDF igual tiempo después)
  function snapshotCierre(f) {
    const movs = db.movimientos.filter((m) => m.fecha === f).map((m) => ({
      tipo: m.tipo === 'gasto' ? 'Gasto' : m.origen === 'manual' ? 'Trabajo' : 'Abono',
      concepto: (m.cantidad > 1 ? `${m.cantidad} × ` : '') + m.concepto,
      cliente: clienteNombre(m.clienteId),
      total: m.tipo === 'gasto' ? 0 : m.total != null ? num(m.total) : num(m.monto),
      caja: m.tipo === 'gasto' ? -num(m.monto) : num(m.monto),
      debe: m.total != null ? Math.max(0, num(m.total) - num(m.monto)) : 0,
    }));
    const ordenes = db.ordenes.filter((o) => o.fecha === f).map((o) => ({
      factura: o.factura != null ? 'N°' + o.factura : '', orden: o.numero, cliente: clienteNombre(o.clienteId),
      equipo: [o.marca, o.modelo].filter(Boolean).join(' ') || o.equipo, falla: o.falla, total: num(o.costo), debe: saldoOrden(o),
    }));
    const cartera = porCliente(db.cartera.filter((d) => (enCartera(d) || (esperaCierre(d) && d.fecha === f)) && saldo(d) > 0)).map((g) => {
      const c = clienteById(g.clienteId) || {};
      return { cliente: c.nombre || '', tienda: c.tienda || '', whatsapp: c.whatsapp || '', modelos: resumenModelos(g.deudas.filter((d) => saldo(d) > 0)), desde: g.deudas.map((d) => d.fecha).sort()[0], debe: g.debe };
    });
    return { movs, ordenes, cartera, carteraTotal: cartera.reduce((s, x) => s + x.debe, 0) };
  }

  async function pdfHeader(doc, titulo, subtitulo) {
    const cfg = db.config;
    const logo = await loadLogo();
    if (logo) doc.addImage(logo, 'JPEG', 14, 10, 24, 24);
    doc.setFont('helvetica', 'bold').setFontSize(16).text(cfg.negocio || 'SIMTEC', 42, 18);
    doc.setFont('helvetica', 'normal').setFontSize(9).setTextColor(90);
    doc.text([cfg.direccion, cfg.telefono ? 'Tel/WhatsApp: ' + cfg.telefono : ''].filter(Boolean), 42, 24);
    doc.setTextColor(0).setFont('helvetica', 'bold').setFontSize(14).text(titulo, 196, 18, { align: 'right' });
    doc.setFont('helvetica', 'normal').setFontSize(10).text(subtitulo, 196, 24, { align: 'right' });
    doc.setDrawColor(0).setLineWidth(0.6).line(14, 37, 196, 37);
    return 44;
  }
  function pdfFooter(doc) {
    const n = doc.getNumberOfPages();
    for (let i = 1; i <= n; i++) {
      doc.setPage(i);
      const h = doc.internal.pageSize.getHeight();
      doc.setFontSize(8).setTextColor(120).text(`Generado por SIMTEC · ${new Date().toLocaleString('es')} · Página ${i} de ${n}`, 105, h - 8, { align: 'center' });
    }
    doc.setTextColor(0);
  }
  const tabla = (doc, y, head, body, opts = {}) => {
    doc.autoTable({
      startY: y, head: [head], body, theme: 'grid', margin: { left: 14, right: 14 },
      styles: { fontSize: 9, cellPadding: 1.8 }, headStyles: { fillColor: [74, 74, 85], textColor: 255 },
      ...opts,
    });
    return doc.lastAutoTable.finalY + 8;
  };
  const subtitulo = (doc, y, t) => {
    doc.setFont('helvetica', 'bold').setFontSize(12).text(t, 14, y);
    doc.setFont('helvetica', 'normal');
    return y + 3;
  };

  async function pdfCierre(c) {
    const JsPDF = await loadPdf();
    const doc = new JsPDF({ unit: 'mm', format: 'letter' });
    const s = c.snap || snapshotCierre(c.fecha);
    let y = await pdfHeader(doc, 'CIERRE DEL DÍA', `${fmtDate(c.fecha)} · ${c.hora}`);
    y = tabla(doc, y, ['Entró a caja', 'Gastos', 'Total en caja', 'Trabajos del día', 'Quedaron debiendo'],
      [[money(c.ingresos), money(c.gastos), money(c.total), String(c.trabajos), money(c.enMora)]],
      { styles: { fontSize: 11, halign: 'center', fontStyle: 'bold' } });
    y = subtitulo(doc, y, 'Movimientos de caja');
    y = tabla(doc, y, ['#', 'Tipo', 'Concepto', 'Cliente', 'Total', 'Entró a caja', 'Debe'],
      s.movs.length ? s.movs.map((m, i) => [i + 1, m.tipo, m.concepto, m.cliente, m.tipo === 'Gasto' ? '' : money(m.total), money(m.caja), m.debe ? money(m.debe) : '']) : [['', '', 'Sin movimientos', '', '', '', '']],
      { columnStyles: { 4: { halign: 'right' }, 5: { halign: 'right' }, 6: { halign: 'right', textColor: [200, 0, 0] } },
        foot: [['', '', 'TOTAL EN CAJA', '', '', money(c.total), '']], footStyles: { fillColor: [235, 235, 235], textColor: 0, halign: 'right' } });
    if (s.ordenes.length) {
      y = subtitulo(doc, y, 'Órdenes de ingreso del día');
      y = tabla(doc, y, ['Factura', 'Orden', 'Cliente', 'Equipo', 'Falla', 'Total', 'Debe'],
        s.ordenes.map((o) => [o.factura, o.orden, o.cliente, o.equipo, o.falla, money(o.total), o.debe ? money(o.debe) : '']),
        { columnStyles: { 5: { halign: 'right' }, 6: { halign: 'right', textColor: [200, 0, 0] } } });
    }
    y = subtitulo(doc, y, `Pasaron a Cartera (${money(c.enMora)})`);
    tabla(doc, y, ['Cliente', 'Equipos / modelos', 'Debe'],
      c.deudores.length ? c.deudores.map((d) => [d.cliente, d.modelos, money(d.debe)]) : [['Nadie quedó debiendo', '', '']],
      { columnStyles: { 2: { halign: 'right', textColor: [200, 0, 0], fontStyle: 'bold' } } });
    pdfFooter(doc);
    return new File([doc.output('blob')], `Cierre_${c.fecha}.pdf`, { type: 'application/pdf' });
  }

  async function pdfCartera(c) {
    const JsPDF = await loadPdf();
    const doc = new JsPDF({ unit: 'mm', format: 'letter' });
    const s = c.snap || snapshotCierre(c.fecha);
    let y = await pdfHeader(doc, 'CARTERA', `Al cierre del ${fmtDate(c.fecha)}`);
    y = tabla(doc, y, ['Total por cobrar', 'Clientes que deben'], [[money(s.carteraTotal), String(s.cartera.length)]],
      { styles: { fontSize: 11, halign: 'center', fontStyle: 'bold' } });
    tabla(doc, y, ['Cliente', 'Tienda', 'Equipos / modelos', 'Desde', 'Debe'],
      s.cartera.length ? s.cartera.map((x) => [x.cliente, x.tienda, x.modelos, fmtDate(x.desde), money(x.debe)]) : [['Nadie debe', '', '', '', '']],
      { columnStyles: { 4: { halign: 'right', textColor: [200, 0, 0], fontStyle: 'bold' } },
        foot: [['TOTAL', '', '', '', money(s.carteraTotal)]], footStyles: { fillColor: [235, 235, 235], textColor: 0, halign: 'right' } });
    pdfFooter(doc);
    return new File([doc.output('blob')], `Cartera_${c.fecha}.pdf`, { type: 'application/pdf' });
  }

  const resumenCierreTexto = (c) => {
    const s = c.snap || snapshotCierre(c.fecha);
    return [
      `🔒 *Cierre del día ${fmtDate(c.fecha)}* (${c.hora}) — ${db.config.negocio}`,
      `💵 Entró a caja: ${money(c.ingresos)}`,
      `🧾 Gastos: ${money(c.gastos)}`,
      `✅ *Total en caja: ${money(c.total)}*`,
      `📱 Trabajos del día: ${c.trabajos}`,
      `⏳ Quedaron debiendo: ${money(c.enMora)}${c.deudores.length ? ' — ' + c.deudores.map((d) => `${d.cliente} (${d.modelos})`).join('; ') : ''}`,
      `📒 Cartera total: ${money(s.carteraTotal)} (${s.cartera.length} clientes)`,
    ].join('\n');
  };
  const descargar = (file) => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(file);
    a.download = file.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  };

  // se busca por fecha (no se usa el objeto viejo: al sincronizar los datos se reemplazan por copias)
  const marcarEnviado = (f) => {
    const cur = cierreDe(f);
    if (cur) { cur.enviado = new Date().toISOString(); save(); refreshReporte(); }
  };
  let refreshReporte = () => {};
  // Envía los PDF del cierre al encargado. Debe llamarse directo desde un toque (el navegador lo exige).
  async function enviarCierre(c, files) {
    const texto = resumenCierreTexto(c);
    if (navigator.canShare && navigator.canShare({ files })) {
      // Android / Windows: menú de compartir con los PDF adjuntos → WhatsApp → encargado
      try {
        await navigator.share({ files, title: `Cierre ${fmtDate(c.fecha)}`, text: texto });
        marcarEnviado(c.fecha);
        toast('Cierre enviado ✅');
      } catch (err) {
        if (err.name !== 'AbortError') toast('No se pudo compartir: ' + err.message);
      }
    } else {
      // sin compartir archivos: se abre directo el chat del encargado con el resumen y se descargan los PDF
      window.open(waLink(encargado(), texto + '\n\n📎 Adjunto los PDF del cierre y de la cartera.'), '_blank', 'noopener');
      files.forEach(descargar);
      marcarEnviado(c.fecha);
      toast(`WhatsApp abierto con ${encargado()}: adjunte los 2 PDF descargados y toque Enviar`);
    }
  }
  // ventana del cierre: genera los 2 PDF y permite enviarlos por WhatsApp o descargarlos
  function openCierreListo(c, { recien = false } = {}) {
    let files = null;
    const enc = encargado();
    const { el } = openModal(`
      <div class="cierre-box">
        <div class="modal-actions"><button class="btn" data-act="close">Cerrar</button></div>
        <h2 class="scan-title">${recien ? '✅ DÍA CERRADO' : '📄 CIERRE'} ${fmtDate(c.fecha)}</h2>
        <pre class="cierre-resumen">${esc(resumenCierreTexto(c).replace(/\*/g, ''))}</pre>
        <p class="modal-hint" id="cl-estado">Preparando los PDF…</p>
        <div class="form-actions" style="justify-content:center">
          <button class="btn green big" data-act="enviar" disabled>📤 ENVIAR PDF POR WHATSAPP</button>
          <button class="btn" data-act="pdf" disabled>⬇ Descargar PDF</button>
          <button class="btn" data-act="excel">⬇ Excel</button>
        </div>
        <p class="modal-hint">Se envía al encargado: <b>${esc(enc)}</b> (se cambia en Ajustes)</p>
      </div>`,
    async (e, a) => {
      if (!a) return;
      if (a.dataset.act === 'excel') excelCierre(c.fecha);
      if (!files) return;
      if (a.dataset.act === 'pdf') files.forEach(descargar);
      if (a.dataset.act === 'enviar') enviarCierre(c, files);
    });
    Promise.all([pdfCierre(c), pdfCartera(c)])
      .then((f) => {
        files = f;
        $$('[data-act=enviar], [data-act=pdf]', el).forEach((b) => (b.disabled = false));
        $('#cl-estado', el).textContent = '2 PDF listos: Cierre del día y Cartera';
      })
      .catch((err) => ($('#cl-estado', el).textContent = 'No se pudieron crear los PDF: ' + err.message));
  }
  let excelCierre = () => {};

  views.reporte = (el) => {
    el.innerHTML = `
      ${head('REPORTE DIARIO', 'h-red', `<input type="date" id="rd-fecha" class="btn ghost" value="${today()}"><button class="btn yellow big" id="rd-cierre">🔒 CIERRE DEL DÍA</button><button class="btn green" id="rd-xls">⬇ Excel del día</button><button class="btn" id="rd-xls-all">⬇ Excel completo</button>`)}
      <div id="rd-cierre-estado"></div>
      <div class="stats-row" id="rd-stats"></div>
      <form class="card" id="rd-form">
        <h2>Anotar trabajo / venta o gasto</h2>
        <div class="seg" id="rd-tipo" style="margin-bottom:12px"><button type="button" class="on" data-t="ingreso">💵 Trabajo / venta</button><button type="button" data-t="gasto">🧾 Gasto</button></div>
        <div class="form-grid">
          <div class="field solo-ing"><label for="rd-cli">Cliente</label><select id="rd-cli">${clienteOptions('', '— Sin cliente / cliente de paso —')}</select></div>
          <div class="field"><label for="rd-con" id="rd-con-lab">Modelo / trabajo</label><input id="rd-con" required list="rd-modelos" placeholder="Ej: Honor 400 Lite – FRP"><datalist id="rd-modelos">${Object.entries(MODELOS).flatMap(([m, l]) => l.map((x) => `<option value="${esc(m === 'iPhone' ? 'iPhone ' + x : m + ' ' + x)}">`)).join('')}</datalist></div>
          <div class="field solo-ing"><label for="rd-cant">Cantidad</label><input id="rd-cant" type="number" min="1" step="1" value="1"></div>
          <div class="field"><label for="rd-monto" id="rd-monto-lab">Total a cobrar</label><input id="rd-monto" type="number" step="0.01" min="0" required></div>
          <div class="field solo-ing"><label for="rd-pago">Pagó</label><input id="rd-pago" type="number" step="0.01" min="0" placeholder="Lo que entregó hoy"></div>
        </div>
        <p class="hint-line solo-ing" id="rd-debe-hint"></p>
        <div class="form-actions"><button class="btn red big" type="submit">GUARDAR</button></div>
      </form>
      <div class="card">
        <h2>Movimientos de caja</h2>
        <div class="table-wrap"><table>
          <thead><tr><th>#</th><th>Tipo</th><th>Concepto</th><th>Cliente</th><th class="num">Total</th><th class="num">Entró a caja</th><th class="num">Debe</th><th></th></tr></thead>
          <tbody id="rd-body"></tbody>
          <tfoot><tr><td colspan="5">TOTAL EN CAJA DEL DÍA</td><td class="num" id="rd-total"></td><td></td><td></td></tr></tfoot>
        </table></div>
      </div>
      <div class="card">
        <h2>Quedaron debiendo hoy <small style="font-family:var(--font-body);font-size:15px;color:var(--muted)">(pasan a Cartera con el cierre)</small></h2>
        <div class="table-wrap"><table>
          <thead><tr><th>Cliente</th><th>Equipos / modelos</th><th class="num">Debe</th><th>Estado</th></tr></thead>
          <tbody id="rd-mora"></tbody>
        </table></div>
      </div>
      <div class="card">
        <h2>Historial de cierres <small style="font-family:var(--font-body);font-size:15px;color:var(--muted)">(PDF guardados en la plataforma)</small></h2>
        <div class="table-wrap"><table>
          <thead><tr><th>Fecha</th><th>Hora</th><th class="num">En caja</th><th class="num">Pasó a cartera</th><th>Enviado</th><th></th></tr></thead>
          <tbody id="rd-hist"></tbody>
        </table></div>
      </div>`;

    const fecha = () => $('#rd-fecha').value || today();
    const signed = (m) => (m.tipo === 'gasto' ? -num(m.monto) : num(m.monto));
    let tipo = 'ingreso';

    function setTipo(t) {
      tipo = t;
      $$('#rd-tipo button', el).forEach((b) => b.classList.toggle('on', b.dataset.t === t));
      $$('.solo-ing', el).forEach((x) => (x.hidden = t !== 'ingreso'));
      $('#rd-con-lab').textContent = t === 'ingreso' ? 'Modelo / trabajo' : 'Concepto del gasto';
      $('#rd-con').placeholder = t === 'ingreso' ? 'Ej: Honor 400 Lite – FRP' : 'Ej: Almuerzo, repuesto…';
      $('#rd-monto-lab').textContent = t === 'ingreso' ? 'Total a cobrar' : 'Monto';
      debeHint();
    }
    function debeHint() {
      const total = num($('#rd-monto').value);
      const pago = $('#rd-pago').value === '' ? total : num($('#rd-pago').value);
      const debe = Math.max(0, total - pago);
      $('#rd-debe-hint').innerHTML = tipo === 'ingreso' && debe > 0
        ? `⏳ Queda debiendo <b style="color:#ff7b7c">${money(debe)}</b>: pasa a Cartera al hacer el cierre del día.`
        : '';
    }

    function render() {
      const f = fecha();
      const rows = db.movimientos.filter((m) => m.fecha === f);
      let acc = 0;
      $('#rd-body').innerHTML = rows.length
        ? rows.map((m, i) => {
          acc += signed(m);
          const total = m.total != null ? num(m.total) : num(m.monto);
          const debe = m.total != null ? Math.max(0, num(m.total) - num(m.monto)) : 0;
          return `<tr>
            <td>${i + 1}</td>
            <td>${m.tipo === 'gasto' ? '<span class="tag due">Gasto</span>' : m.origen === 'manual' ? '<span class="tag ok">Trabajo</span>' : '<span class="tag in">Abono</span>'}</td>
            <td>${m.cantidad > 1 ? `<b>${m.cantidad} ×</b> ` : ''}${esc(m.concepto)}</td>
            <td>${esc(clienteNombre(m.clienteId))}</td>
            <td class="num">${m.tipo === 'gasto' ? '' : money(total)}</td>
            <td class="num">${m.tipo === 'gasto' ? '-' : ''}${money(m.monto)}</td>
            <td class="num">${debe > 0 ? `<span class="tag due">${money(debe)}</span>` : ''}</td>
            <td class="actions">${m.origen === 'manual' ? `<button class="btn sm red" data-del="${m.id}">Borrar</button>` : '<small style="color:var(--muted)">auto</small>'}</td>
          </tr>`;
        }).join('')
        : `<tr><td colspan="8" class="empty">Sin movimientos el ${fmtDate(f)}</td></tr>`;
      const ing = rows.filter((m) => m.tipo !== 'gasto').reduce((s, m) => s + num(m.monto), 0);
      const gas = rows.filter((m) => m.tipo === 'gasto').reduce((s, m) => s + num(m.monto), 0);
      $('#rd-total').textContent = money(ing - gas);

      const pend = pendientesDelDia(f);
      const grupos = porCliente(pend);
      const cierre = cierreDe(f);
      $('#rd-mora').innerHTML = grupos.length
        ? grupos.map((g) => {
          const enCart = g.deudas.every(enCartera);
          return `<tr>
            <td><b>${esc(clienteNombre(g.clienteId) || '(sin cliente)')}</b></td>
            <td>${esc(resumenModelos(g.deudas))}</td>
            <td class="num"><span class="tag due">${money(g.debe)}</span></td>
            <td>${enCart ? '<span class="tag ok">✓ En cartera</span>' : '<span class="tag in">⏳ Pendiente del cierre</span>'}</td>
          </tr>`;
        }).join('')
        : `<tr><td colspan="4" class="empty">Nadie quedó debiendo ${f === today() ? 'hoy' : 'ese día'} 🎉</td></tr>`;

      const enMora = pend.reduce((s, d) => s + saldo(d), 0);
      $('#rd-stats').innerHTML = `
        <div class="stat green"><div class="label">Entró a caja</div><div class="value">${money(ing)}</div></div>
        <div class="stat red"><div class="label">Gastos</div><div class="value">${money(gas)}</div></div>
        <div class="stat yellow"><div class="label">Total en caja</div><div class="value">${money(ing - gas)}</div></div>
        <div class="stat blue"><div class="label">Quedaron debiendo</div><div class="value">${money(enMora)}</div></div>`;
      const hist = db.cierres.slice().sort((x, z) => z.fecha.localeCompare(x.fecha));
      $('#rd-hist').innerHTML = hist.length
        ? hist.map((c) => `<tr>
            <td><b>${fmtDate(c.fecha)}</b></td><td>${esc(c.hora)}</td>
            <td class="num">${money(c.total)}</td><td class="num">${money(c.enMora)}</td>
            <td>${c.enviado ? '<span class="tag ok">✓ Enviado</span>' : '<span class="tag gray">No</span>'}</td>
            <td class="actions"><button class="btn sm green" data-cierre="${esc(c.fecha)}">📄 PDF / Enviar</button></td>
          </tr>`).join('')
        : '<tr><td colspan="6" class="empty">Todavía no hay cierres</td></tr>';
      const sinCerrar = pend.filter((d) => !d.cerrado).length;
      $('#rd-cierre-estado').innerHTML = cierre
        ? `<div class="cierre-ok">🔒 Día cerrado a las ${esc(cierre.hora)} · En caja ${money(cierre.total)} · ${cierre.deudores.length} ${cierre.deudores.length === 1 ? 'cliente pasó' : 'clientes pasaron'} a Cartera (${money(cierre.enMora)})${sinCerrar ? ` · <b>Hay ${sinCerrar} pendiente(s) nuevos: vuelva a cerrar</b>` : ''}</div>`
        : '';
    }

    function abrirCierre() {
      const f = fecha();
      const rows = db.movimientos.filter((m) => m.fecha === f);
      const ing = rows.filter((m) => m.tipo !== 'gasto').reduce((s, m) => s + num(m.monto), 0);
      const gas = rows.filter((m) => m.tipo === 'gasto').reduce((s, m) => s + num(m.monto), 0);
      const pend = pendientesDelDia(f);
      const grupos = porCliente(pend);
      const enMora = pend.reduce((s, d) => s + saldo(d), 0);
      const trabajos = rows.filter((m) => m.origen === 'manual' && m.tipo !== 'gasto').reduce((s, m) => s + (num(m.cantidad) || 1), 0) + db.ordenes.filter((o) => o.fecha === f).length;
      const { el: m, close } = openModal(`
        <div class="cierre-box">
          <div class="modal-actions"><button class="btn" data-act="close">Cancelar</button></div>
          <h2 class="scan-title">🔒 CIERRE DEL DÍA ${fmtDate(f)}</h2>
          <div class="stats-row">
            <div class="stat green"><div class="label">Entró a caja</div><div class="value">${money(ing)}</div></div>
            <div class="stat red"><div class="label">Gastos</div><div class="value">${money(gas)}</div></div>
            <div class="stat yellow"><div class="label">Total en caja</div><div class="value">${money(ing - gas)}</div></div>
            <div class="stat blue"><div class="label">Trabajos del día</div><div class="value">${trabajos}</div></div>
          </div>
          <div class="card">
            <h2>Pasan a Cartera (${money(enMora)})</h2>
            ${grupos.length ? `<div class="table-wrap"><table>
              <thead><tr><th>Cliente</th><th>Equipos / modelos</th><th class="num">Debe</th></tr></thead>
              <tbody>${grupos.map((g) => `<tr><td><b>${esc(clienteNombre(g.clienteId) || '(sin cliente)')}</b></td><td>${esc(resumenModelos(g.deudas))}</td><td class="num"><span class="tag due">${money(g.debe)}</span></td></tr>`).join('')}</tbody>
            </table></div>` : '<p class="empty">Nadie quedó debiendo 🎉</p>'}
          </div>
          <p class="modal-hint" id="ci-estado">Preparando los PDF del cierre y la cartera…</p>
          <div class="form-actions" style="justify-content:center">
            <button class="btn yellow big" data-act="confirmar" disabled>🔒 CONFIRMAR CIERRE Y ENVIAR</button>
          </div>
          <p class="modal-hint">Se cierra el día y se abre WhatsApp con los PDF para el encargado <b>${esc(encargado())}</b>. Solo toque Enviar.</p>
        </div>`,
      (e, a) => {
        if (!a || a.dataset.act !== 'confirmar' || !files) return;
        pend.forEach((d) => { if (!d.cerrado) d.cerrado = f; });
        const i = db.cierres.findIndex((c) => c.fecha === f);
        if (i >= 0) db.cierres[i] = registro; else db.cierres.push(registro);
        save();
        close();
        render();
        enviarCierre(registro, files); // en el mismo toque, para que el navegador permita abrir WhatsApp
      });
      // el registro y los PDF se preparan al abrir la ventana, así el toque de confirmar envía de inmediato
      const registro = {
        id: 'cierre-' + f, fecha: f, hora: new Date().toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' }),
        ingresos: ing, gastos: gas, total: ing - gas, trabajos, enMora,
        deudores: grupos.map((g) => ({ clienteId: g.clienteId, cliente: clienteNombre(g.clienteId), modelos: resumenModelos(g.deudas), debe: g.debe })),
        snap: snapshotCierre(f), // queda guardado en la nube para volver a sacar el PDF
      };
      let files = null;
      Promise.all([pdfCierre(registro), pdfCartera(registro)])
        .then((fl) => {
          files = fl;
          $('[data-act=confirmar]', m).disabled = false;
          $('#ci-estado', m).textContent = '✅ PDF listos (Cierre del día y Cartera)';
        })
        .catch((err) => ($('#ci-estado', m).textContent = 'No se pudieron crear los PDF: ' + err.message));
    }

    const toRows = (list) => {
      let acc = 0;
      return list.map((mv) => {
        acc += signed(mv);
        return {
          Fecha: fmtDate(mv.fecha), Tipo: mv.tipo === 'gasto' ? 'Gasto' : mv.origen === 'manual' ? 'Trabajo / venta' : 'Abono',
          Cantidad: mv.cantidad || '', Concepto: mv.concepto, Cliente: clienteNombre(mv.clienteId),
          Total: mv.total != null ? num(mv.total) : signed(mv), 'Entró a caja': signed(mv),
          Debe: mv.total != null ? Math.max(0, num(mv.total) - num(mv.monto)) : 0, Acumulado: acc,
        };
      });
    };
    function excelDia(f) {
      const rows = toRows(db.movimientos.filter((mv) => mv.fecha === f));
      rows.push({ Fecha: '', Tipo: '', Cantidad: '', Concepto: 'TOTAL EN CAJA', Cliente: '', Total: '', 'Entró a caja': rows.length ? rows[rows.length - 1].Acumulado : 0, Debe: '', Acumulado: '' });
      const mora = porCliente(pendientesDelDia(f)).map((g) => ({ Cliente: clienteNombre(g.clienteId), Modelos: resumenModelos(g.deudas), Debe: g.debe }));
      exportXLSX(`Cierre_${f}.xlsx`, { [`Caja ${f}`]: rows, 'Pasan a cartera': mora });
    }

    $$('#rd-tipo button', el).forEach((b) => b.addEventListener('click', () => setTipo(b.dataset.t)));
    ['#rd-monto', '#rd-pago'].forEach((s) => $(s).addEventListener('input', debeHint));
    $('#rd-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const f = fecha();
      const concepto = $('#rd-con').value.trim();
      const total = num($('#rd-monto').value);
      if (tipo === 'gasto') {
        db.movimientos.push({ id: uid(), origen: 'manual', fecha: f, tipo: 'gasto', concepto, clienteId: '', monto: total });
      } else {
        const clienteId = $('#rd-cli').value;
        const cantidad = Math.max(1, Math.round(num($('#rd-cant').value) || 1));
        const pago = $('#rd-pago').value === '' ? total : Math.min(num($('#rd-pago').value), total);
        const debe = Math.max(0, total - pago);
        if (debe > 0 && !clienteId) {
          toast('Para dejar saldo pendiente, elija el cliente que queda debiendo');
          $('#rd-cli').focus();
          return;
        }
        const movId = uid();
        db.movimientos.push({ id: movId, origen: 'manual', fecha: f, tipo: 'ingreso', concepto, clienteId, cantidad, total, monto: pago });
        if (debe > 0) {
          db.cartera.push({
            id: uid(), origen: 'diario', movimientoId: movId, clienteId, fecha: f,
            concepto: (cantidad > 1 ? `${cantidad} × ` : '') + concepto, cantidad, monto: debe, abonos: [],
          });
        }
      }
      save();
      ['#rd-con', '#rd-monto', '#rd-pago'].forEach((s) => ($(s).value = ''));
      $('#rd-cant').value = 1;
      debeHint();
      toast('Guardado');
      render();
    });
    $('#rd-fecha').addEventListener('change', render);
    $('#rd-cierre').addEventListener('click', abrirCierre);
    $('#rd-body').addEventListener('click', (e) => {
      const del = e.target.closest('[data-del]');
      if (del && confirm('¿Borrar este movimiento? (si dejó deuda, también se borra de Cartera)')) {
        db.movimientos = db.movimientos.filter((mv) => mv.id !== del.dataset.del);
        db.cartera = db.cartera.filter((d) => d.movimientoId !== del.dataset.del);
        save();
        render();
      }
    });
    $('#rd-xls').addEventListener('click', () => excelDia(fecha()));
    excelCierre = excelDia;
    refreshReporte = () => { if (document.body.contains(el)) render(); };
    $('#rd-hist').addEventListener('click', (e) => {
      const b = e.target.closest('[data-cierre]');
      if (b) openCierreListo(cierreDe(b.dataset.cierre));
    });
    $('#rd-xls-all').addEventListener('click', () => {
      const all = db.movimientos.slice().sort((a, b) => a.fecha.localeCompare(b.fecha));
      const porDia = {};
      all.forEach((mv) => (porDia[mv.fecha] = (porDia[mv.fecha] || 0) + signed(mv)));
      exportXLSX(`Reporte_Completo_SIMTEC_${today()}.xlsx`, {
        Movimientos: toRows(all),
        'Total por día': Object.entries(porDia).map(([f, t]) => ({ Fecha: fmtDate(f), Total: t })),
        Cierres: db.cierres.slice().sort((a, b) => a.fecha.localeCompare(b.fecha)).map((c) => ({ Fecha: fmtDate(c.fecha), Hora: c.hora, 'En caja': c.total, 'Pasó a cartera': c.enMora, Clientes: c.deudores.map((d) => `${d.cliente} (${d.modelos})`).join('; ') })),
      });
    });
    setTipo('ingreso');
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
  const FALLAS = ['FRP', 'KG', 'PayJoy', 'Software', 'Cuenta Mi'];
  const MARCAS = ['Samsung', 'iPhone', 'Xiaomi', 'Honor', 'Huawei', 'Motorola', 'Oppo', 'Tecno', 'Infinix', 'ZTE'];
  // modelos más comunes por marca (se pueden escribir otros)
  const MODELOS = {
    Samsung: ['A03', 'A03s', 'A04', 'A04s', 'A04e', 'A05', 'A05s', 'A06', 'A10', 'A10s', 'A11', 'A12', 'A13', 'A14', 'A15', 'A16', 'A20', 'A21s', 'A22', 'A23', 'A24', 'A25', 'A30', 'A31', 'A32', 'A33', 'A34', 'A35', 'A50', 'A51', 'A52', 'A53', 'A54', 'A55', 'S20', 'S21', 'S22', 'S23', 'S24', 'Note 10', 'Note 20', 'M14', 'M15'],
    iPhone: ['6s', '7', '7 Plus', '8', '8 Plus', 'X', 'XR', 'XS', 'XS Max', '11', '11 Pro', '11 Pro Max', '12', '12 Pro', '12 Pro Max', '13', '13 Pro', '13 Pro Max', '14', '14 Plus', '14 Pro', '14 Pro Max', '15', '15 Plus', '15 Pro', '15 Pro Max', '16', '16 Pro'],
    Xiaomi: ['Redmi 9A', 'Redmi 9C', 'Redmi 10', 'Redmi 10C', 'Redmi 12', 'Redmi 12C', 'Redmi 13', 'Redmi 13C', 'Redmi A1', 'Redmi A2', 'Redmi A3', 'Redmi Note 9', 'Redmi Note 10', 'Redmi Note 11', 'Redmi Note 12', 'Redmi Note 13', 'Redmi Note 14', 'Poco X3', 'Poco X5', 'Poco X6', 'Poco M5', 'Poco C65'],
    Honor: ['X5', 'X6', 'X6a', 'X7', 'X7a', 'X7b', 'X8', 'X8a', 'X8b', 'X9a', 'X9b', '90', '90 Lite', 'Magic 5 Lite', 'Magic 6 Lite'],
    Huawei: ['Y5 2019', 'Y6 2019', 'Y7 2019', 'Y9 2019', 'Y9 Prime', 'Y6p', 'Y7a', 'Y9a', 'P20 Lite', 'P30 Lite', 'P40 Lite', 'Nova 9', 'Nova 11', 'Nova Y61', 'Nova Y70', 'Nova Y90'],
    Motorola: ['E7', 'E13', 'E14', 'E20', 'E22', 'E32', 'E40', 'G13', 'G14', 'G22', 'G23', 'G24', 'G32', 'G34', 'G54', 'G84', 'One Fusion'],
    Oppo: ['A15', 'A16', 'A17', 'A18', 'A38', 'A54', 'A57', 'A58', 'A78', 'A79', 'Reno 8', 'Reno 10'],
    Tecno: ['Spark 10', 'Spark 20', 'Spark Go 2023', 'Spark Go 2024', 'Camon 20', 'Pop 7', 'Pova 5'],
    Infinix: ['Hot 30', 'Hot 40', 'Smart 7', 'Smart 8', 'Note 30', 'Note 40'],
    ZTE: ['Blade A31', 'Blade A51', 'Blade A52', 'Blade A53', 'Blade A54', 'Blade V40'],
  };

  // abonos hechos después desde Cartera o al entregar
  const abonosOrden = (o) => {
    const d = db.cartera.find((x) => x.ordenId === o.id);
    return d ? abonado(d) : 0;
  };
  const saldoOrden = (o) => Math.max(0, num(o.costo) - num(o.abono) - abonosOrden(o));
  const equipoTxt = (o) => [o.equipo, o.marca, o.modelo].filter(Boolean).join(' ');
  const estadoTag = (e) => `<span class="tag ${e === 'Listo' ? 'ok' : e === 'Entregado' ? 'gray' : e === 'En reparación' ? 'in' : 'due'}">${esc(e)}</span>`;

  function setEstado(o, estado) {
    if (o.estado === estado) return;
    o.estado = estado;
    o.historial = (o.historial || []).concat({ estado, fecha: new Date().toISOString() });
    save();
  }
  const fechaEstado = (o, estado) => {
    const h = (o.historial || []).filter((x) => x.estado === estado).pop();
    return h ? fmtDate(h.fecha.slice(0, 10)) : '';
  };

  // ---- código QR: es un link que abre la orden en SIMTEC (sirve con la cámara normal del celular)
  const orderLink = (o) => `${location.origin}${location.pathname}#scan/${o.numero}`;
  function qrSVG(text) {
    if (!window.qrcode) return '';
    const q = qrcode(0, 'M');
    q.addData(text);
    q.make();
    return q.createSvgTag({ cellSize: 4, margin: 8, scalable: true, alt: text });
  }
  // lee lo escaneado (link, "SIM-0004", "sim 4" o solo "4") y busca la orden
  function findOrder(text) {
    const t = String(text || '').trim();
    const m = t.match(/SIM[-\s]?(\d+)/i) || t.match(/^(\d+)$/);
    if (!m) return null;
    const digits = m[1];
    const same = (numero) => db.ordenes.find((o) => o.numero.toUpperCase() === numero);
    // número aleatorio (SIM-583201) o de las órdenes antiguas en secuencia (SIM-0004, se puede escribir "4")
    return same('SIM-' + digits) || same('SIM-' + String(Number(digits)).padStart(4, '0')) || null;
  }
  // número de factura en secuencia: 00, 01, 02… (sigue después del mayor que ya exista)
  function nuevaFactura() {
    const mayor = db.ordenes.reduce((mx, o) => (o.factura != null ? Math.max(mx, Number(o.factura) + 1) : mx), 0);
    const n = Math.max(db.seq.factura || 0, mayor);
    db.seq.factura = n + 1;
    return String(n).padStart(2, '0');
  }
  // número de orden aleatorio de 6 dígitos, que no se repite
  function nuevoNumeroOrden() {
    const usados = new Set(db.ordenes.map((o) => o.numero));
    const rnd = () => {
      const a = new Uint32Array(1);
      (window.crypto || {}).getRandomValues ? crypto.getRandomValues(a) : (a[0] = Math.floor(Math.random() * 4294967295));
      return 100000 + (a[0] % 900000);
    };
    let n;
    do n = 'SIM-' + rnd(); while (usados.has(n));
    return n;
  }

  // ---- reporte de trabajo LISTO para el cliente por WhatsApp
  // ---- tarjeta en imagen para WhatsApp (logo, saludo y filas de colores)
  const logoImg = new Image();
  logoImg.src = 'assets/logo.jpg';
  const COLORES = {
    azul: ['#1e9bff', '#0b6fd8', '#fff'], rosa: ['#ff2fa8', '#c8137e', '#fff'], amarillo: ['#ffd500', '#f5b700', '#000'],
    verde: ['#22c55e', '#15803d', '#fff'], morado: ['#8b5cf6', '#6d28d9', '#fff'], naranja: ['#ff7a1a', '#ea580c', '#fff'],
  };
  async function tarjetaImagen({ nombre, aviso, filas }) {
    try { await Promise.all(['700 40px "Roboto Condensed"', '40px Anton'].map((f) => document.fonts.load(f))); } catch (e) { /* sin fuentes */ }
    if (!logoImg.complete) await new Promise((r) => { logoImg.onload = r; logoImg.onerror = r; });
    const W = 1080, X = 60, RW = W - 2 * X, LW = 400;
    const cv = document.createElement('canvas');
    const ctx = cv.getContext('2d');
    const BODY = '"Roboto Condensed", Arial, sans-serif';
    // texto del valor en varias líneas si no cabe
    const lineas = (txt, maxW, size) => {
      ctx.font = `700 ${size}px ${BODY}`;
      const out = [];
      let cur = '';
      String(txt).split(' ').forEach((w) => {
        const t = cur ? cur + ' ' + w : w;
        if (ctx.measureText(t).width > maxW && cur) { out.push(cur); cur = w; } else cur = t;
      });
      if (cur) out.push(cur);
      return out;
    };
    const filasMed = filas.map((f) => {
      let size = 54, ls = lineas(f.valor, RW - LW - 50, size);
      while (ls.length > 1 && size > 38) { size -= 4; ls = lineas(f.valor, RW - LW - 50, size); }
      ls = ls.slice(0, 4);
      return { ...f, size, ls, h: Math.max(104, ls.length * size * 1.15 + 40) };
    });
    const top = 520 + (aviso ? 90 : 0);
    const H = top + filasMed.reduce((t, f) => t + f.h + 22, 0) + 230;
    cv.width = W; cv.height = H;
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
    // franjas de las esquinas
    const franja = (x1, y1, x2, y2, c) => { ctx.strokeStyle = c; ctx.lineWidth = 34; ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke(); };
    franja(-40, H - 200, 160, H + 20, '#ff2fa8'); franja(-40, H - 110, 90, H + 20, '#1e9bff');
    franja(W + 40, H - 200, W - 160, H + 20, '#ff2fa8'); franja(W + 40, H - 110, W - 90, H + 20, '#1e9bff');
    // logo redondo con brillo
    ctx.save(); ctx.shadowColor = '#7cc4ff'; ctx.shadowBlur = 40;
    ctx.beginPath(); ctx.arc(W / 2, 200, 170, 0, Math.PI * 2); ctx.fillStyle = '#000'; ctx.fill(); ctx.restore();
    ctx.save(); ctx.beginPath(); ctx.arc(W / 2, 200, 170, 0, Math.PI * 2); ctx.clip();
    try { ctx.drawImage(logoImg, W / 2 - 170, 30, 340, 340); } catch (e) { /* sin logo */ }
    ctx.restore();
    // saludo
    const partes = (y, trozos, size, font) => {
      ctx.font = `${font} ${size}px ${font === '400' ? 'Anton, Impact, sans-serif' : BODY}`;
      let x = X;
      trozos.forEach(([t, c]) => { ctx.fillStyle = c; ctx.fillText(t, x, y); x += ctx.measureText(t).width; });
    };
    ctx.textBaseline = 'alphabetic';
    partes(495 - 40, [['Hola, ', '#fff'], [`${nombre || 'cliente'}`, '#ff2fa8'], ['.', '#fff']], 76, '400');
    partes(495 + 20, [['Le saluda ', '#fff'], ['SIMTEC', '#ff2fa8'], [' Tecnología Informática.', '#fff']], 44, '700');
    if (aviso) {
      ctx.font = `400 54px Anton, Impact, sans-serif`; ctx.fillStyle = '#4ade80'; ctx.textAlign = 'center';
      ctx.shadowColor = '#22c55e'; ctx.shadowBlur = 18; ctx.fillText(aviso, W / 2, 495 + 105); ctx.shadowBlur = 0; ctx.textAlign = 'left';
    }
    // filas
    const redondo = (x, y, w, h, r) => { ctx.beginPath(); ctx.roundRect ? ctx.roundRect(x, y, w, h, r) : ctx.rect(x, y, w, h); };
    let y = top + 10;
    filasMed.forEach((f) => {
      const [c1, c2, tx] = COLORES[f.color] || COLORES.azul;
      // marco con brillo
      ctx.save(); ctx.shadowColor = c1; ctx.shadowBlur = 16; ctx.strokeStyle = c1; ctx.lineWidth = 5;
      redondo(X, y, RW, f.h, 26); ctx.stroke(); ctx.restore();
      ctx.fillStyle = '#050505'; redondo(X + 3, y + 3, RW - 6, f.h - 6, 24); ctx.fill();
      // etiqueta de color
      const g = ctx.createLinearGradient(X, 0, X + LW, 0); g.addColorStop(0, c2); g.addColorStop(1, c1);
      ctx.fillStyle = g; redondo(X, y, LW, f.h, 26); ctx.fill();
      ctx.fillStyle = c2; redondo(X, y, 120, f.h, 26); ctx.fill();
      ctx.font = '58px "Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillStyle = '#fff'; ctx.fillText(f.icono, X + 60, y + f.h / 2 + 3);
      ctx.font = `700 44px ${BODY}`; ctx.fillStyle = tx; ctx.textAlign = 'left';
      ctx.fillText(f.etiqueta, X + 145, y + f.h / 2 + 2);
      // valor
      ctx.fillStyle = '#fff'; ctx.font = `700 ${f.size}px ${BODY}`;
      const lh = f.size * 1.15, y0 = y + f.h / 2 - ((f.ls.length - 1) * lh) / 2;
      f.ls.forEach((l, i) => ctx.fillText(l, X + LW + 35, y0 + i * lh + 2));
      ctx.textBaseline = 'alphabetic';
      y += f.h + 22;
    });
    // pie
    ctx.textAlign = 'center';
    ctx.font = `italic 700 46px ${BODY}`; ctx.fillStyle = '#fff'; ctx.fillText('Gracias por confiar en', W / 2, y + 70);
    ctx.font = `400 50px Anton, Impact, sans-serif`;
    const t1 = 'SIMTEC', t2 = ' Tecnología Informática.';
    const w1 = ctx.measureText(t1).width; ctx.font = `italic 700 46px ${BODY}`; const w2 = ctx.measureText(t2).width;
    let px = W / 2 - (w1 + w2) / 2; ctx.textAlign = 'left';
    ctx.font = `400 50px Anton, Impact, sans-serif`; ctx.fillStyle = '#ff2fa8'; ctx.fillText(t1, px, y + 140);
    ctx.font = `italic 700 46px ${BODY}`; ctx.fillStyle = '#fff'; ctx.fillText(t2, px + w1, y + 140);
    ctx.fillStyle = '#ff2fa8'; ctx.fillRect(px - 90, y + 124, 64, 8); ctx.fillRect(px + w1 + w2 + 26, y + 124, 64, 8);
    return new Promise((r) => cv.toBlob(r, 'image/png'));
  }
  const tarjetaOrden = (o) => {
    const c = clienteById(o.clienteId) || {};
    const pagado = num(o.abono) + abonosOrden(o);
    return tarjetaImagen({
      nombre: c.nombre,
      aviso: o.estado === 'Listo' ? '✅ ¡SU EQUIPO ESTÁ LISTO PARA RETIRAR!' : o.estado === 'Entregado' ? '📦 EQUIPO ENTREGADO' : '',
      filas: [
        { icono: '📄', etiqueta: 'Orden:', valor: `${o.numero}${o.factura != null ? ` · N°${o.factura}` : ''}`, color: 'azul' },
        { icono: '📱', etiqueta: 'Equipo:', valor: equipoTxt(o) || '-', color: 'rosa' },
        { icono: '🔧', etiqueta: 'Falla:', valor: o.falla || '-', color: 'amarillo' },
        { icono: '💵', etiqueta: 'Costo:', valor: num(o.costo) ? money(o.costo) : 'Por definir', color: 'verde' },
        { icono: '💳', etiqueta: 'Abono:', valor: money(pagado), color: 'morado' },
        { icono: '👛', etiqueta: 'Saldo:', valor: money(saldoOrden(o)), color: 'naranja' },
        { icono: '✅', etiqueta: 'Estado:', valor: o.estado, color: 'azul' },
      ],
    });
  };
  // comparte la imagen: en celular / Windows abre el menú de compartir (WhatsApp con la foto);
  // si el equipo no puede, descarga la imagen y abre el chat para adjuntarla
  async function compartirImagen(blob, nombreArchivo, texto, telefono) {
    const file = new File([blob], nombreArchivo, { type: 'image/png' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], text: texto });
        return true;
      } catch (err) {
        if (err.name === 'AbortError') return false;
      }
    }
    descargar(file);
    window.open(waDigits(telefono) ? waLink(telefono, texto) : 'https://wa.me/?text=' + encodeURIComponent(texto), '_blank', 'noopener');
    toast('Imagen descargada: adjúntela en el chat de WhatsApp y toque Enviar');
    return true;
  }
  async function enviarImagenOrden(o) {
    if (!o) return false;
    const c = clienteById(o.clienteId) || {};
    toast('Preparando imagen…');
    const blob = await tarjetaOrden(o);
    const caption = `${o.estado === 'Listo' ? '✅ Su equipo está LISTO. ' : ''}Orden ${o.numero} · ${db.config.negocio}`;
    return compartirImagen(blob, `SIMTEC_${o.numero}.png`, caption, c.whatsapp);
  }

  // abre WhatsApp con el reporte en imagen (debe llamarse desde un toque/clic para que el navegador lo permita)
  function enviarReporteListo(o) {
    if (!o) return false;
    const c = clienteById(o.clienteId);
    if (!c) { toast('Esta orden no tiene cliente'); return false; }
    if (!waDigits(c.whatsapp)) {
      const num = prompt(`${c.nombre} no tiene WhatsApp guardado.\nEscriba su número para enviarle el reporte:`, '');
      if (!num || !num.replace(/\D/g, '')) { toast('Reporte no enviado: falta el WhatsApp del cliente'); return false; }
      c.whatsapp = num.trim();
    }
    const id = o.id;
    enviarImagenOrden(o).then((ok) => {
      if (!ok) return;
      const x = db.ordenes.find((y) => y.id === id); // los datos pudieron cambiar al sincronizar
      if (x) { x.avisadoListo = new Date().toISOString(); save(); }
    });
    return true;
  }

  // comprobante con el formato de la hoja de "orden de servicio" en papel
  function receiptHTML(o) {
    const c = clienteById(o.clienteId) || {};
    const cfg = db.config;
    const [y, m, d] = (o.fecha || today()).split('-');
    const nro = o.numero.replace(/^SIM-/, '');
    const imei = String(o.imei || '').replace(/\D/g, '').padEnd(15, ' ').slice(0, 15).split('');
    const lineas = [
      o.falla && 'Falla: ' + o.falla,
      o.trabajo && 'Nota: ' + o.trabajo,
      o.equipo && o.equipo !== 'Celular' && 'Equipo: ' + o.equipo,
      o.accesorios && 'Accesorios: ' + o.accesorios,
      o.clave && 'Clave / patrón: ' + o.clave,
      'Estado: ' + o.estado,
    ].filter(Boolean);
    while (lineas.length < 6) lineas.push('');
    const entregado = (o.historial || []).filter((x) => x.estado === 'Entregado').pop();
    const [ey, em, ed] = entregado ? entregado.fecha.slice(0, 10).split('-') : ['', '', ''];
    const sino = (t) => `<div class="f-sn"><span>${t}</span><span>SI <i></i></span><span>NO <i></i></span></div>`;
    return `<div class="receipt fact">
      <div class="f-head">
        <div class="f-title">SERVICIO TÉCNICO<br>DE CELULARES</div>
        <img class="f-logo" src="assets/logo.jpg" alt="">
        <div class="f-contact">
          ${cfg.telefono ? `<div><b class="wa">✆</b> ${esc(cfg.telefono)}</div>` : ''}
          ${cfg.direccion ? `<div><b class="pin">⦿</b> ${esc(cfg.direccion)}</div>` : ''}
        </div>
        <div class="f-box">
          <div class="f-brand">SIMTEC</div>
          <div class="f-os"><div class="f-os-t">ORDEN DE SERVICIO</div><div class="f-date">${d} / ${m} / ${y.slice(2)}</div><div class="f-nro">N°${esc(o.factura != null ? o.factura : nro)}</div></div>${o.factura != null ? `<div class="f-cod">Orden ${esc(o.numero)}</div>` : ''}
        </div>
        <div class="f-qr">${qrSVG(orderLink(o))}</div>
      </div>

      <div class="f-row f-round">
        <div style="flex:2.2"><small>CLIENTE:</small> ${esc(c.nombre || '')}${c.tienda ? ' <span class="f-soft">(' + esc(c.tienda) + ')</span>' : ''}</div>
        <div style="flex:1.2"><small>TELF.:</small> ${esc(c.whatsapp || '')}</div>
        <div style="flex:1.2"><small>C.C./NIT:</small></div>
      </div>

      <div class="f-round f-equipo">
        <div class="f-bar"><span style="flex:1">MARCA</span><span style="flex:1.3">MODELO</span><span style="flex:2.2">IMEI</span></div>
        <div class="f-row f-cells">
          <div style="flex:1">${esc(o.marca || o.equipo || '')}</div>
          <div style="flex:1.3">${esc(o.modelo || '')}</div>
          <div class="f-imei" style="flex:2.2">${imei.map((ch) => `<span>${ch.trim() ? esc(ch) : ''}</span>`).join('')}</div>
        </div>
      </div>

      <div class="f-mid">
        <div class="f-round f-diag">
          <div class="f-bar"><span>DIAGNÓSTICO DEL CELULAR</span></div>
          ${lineas.map((l) => `<div class="f-line">${esc(l)}</div>`).join('')}
        </div>
        <div class="f-round f-side">
          ${sino('SIM CARD')}${sino('MEMORIA')}${sino('BATERÍA')}${sino('AUTORIZA REPARACIÓN')}
          <div class="f-money"><span>Abono $</span><b>${num(o.abono) + abonosOrden(o) ? money(num(o.abono) + abonosOrden(o)).replace(cfg.moneda, '').trim() : ''}</b></div>
          <div class="f-money"><span>Debe $</span><b>${money(saldoOrden(o)).replace(cfg.moneda, '').trim()}</b></div>
          <div class="f-money"><span>TOTAL$</span><b>${money(o.costo).replace(cfg.moneda, '').trim()}</b></div>
        </div>
      </div>

      <div class="f-row f-round f-labelrow"><div class="f-lab">RECIBE</div><div style="flex:1">${esc(cfg.negocio)}</div></div>
      <div class="f-row f-round f-labelrow">
        <div class="f-lab">GARANTÍA</div><div style="flex:1.3"></div>
        <div class="f-lab f-small">FECHA<br>DE ENTREGA</div>
        <div class="f-dmy"><small>DÍA</small>${ed}</div><div class="f-dmy"><small>MES</small>${em}</div><div class="f-dmy"><small>AÑO</small>${ey}</div>
      </div>
      <div class="f-row f-round f-firma"><div style="flex:1.6"><small>FIRMA:</small><span class="f-blank"></span></div><div style="flex:1"><small>C.C.:</small><span class="f-blank"></span></div></div>

      <div class="f-foot"><span class="f-sim"></span> Recuerde sacar siempre su <b class="r">SIM CARD</b> y su <b>MEMORIA</b> <b class="r">del celular</b></div>
    </div>`;
  }

  // etiqueta naranja de SIMTEC (60 x 30 mm): QR a la izquierda, cliente / modelo / fecha
  function labelHTML(o) {
    const c = clienteById(o.clienteId) || {};
    const modelo = [o.marca, o.modelo].filter(Boolean).join(' ') || o.equipo || '';
    return `<div class="etq">
      <div class="l-left">
        <div class="l-qr">${qrSVG(orderLink(o))}</div>
        <div class="l-num">${esc(o.numero)}</div>
      </div>
      <div class="l-fields">
        <div class="l-row"><span class="l-lab">CLIENTE:</span><span class="l-box">${esc(c.nombre || '')}</span></div>
        <div class="l-row"><span class="l-lab">MODELO:</span><span class="l-box">${esc(modelo)}</span></div>
        <div class="l-row"><span class="l-lab">FECHA:</span><span class="l-box">${fmtDate(o.fecha)}</span></div>
      </div>
    </div>`;
  }

  // ventana con botones encima de un contenido (comprobante, etiqueta, escáner)
  function openModal(html, onClick, onClose) {
    const m = document.createElement('div');
    m.className = 'modal-back';
    m.innerHTML = `<div class="modal-inner">${html}</div>`;
    const close = () => { m.remove(); if (onClose) onClose(); };
    m.addEventListener('click', (e) => {
      const a = e.target.closest('[data-act]');
      if (e.target === m || (a && a.dataset.act === 'close')) return close();
      if (onClick) onClick(e, a, close);
    });
    document.body.appendChild(m);
    return { el: m, close };
  }

  function printWithPage(pageCss) {
    // tamaño de página solo para esta impresión (p. ej. etiqueta 50 x 30 mm)
    const st = document.createElement('style');
    st.textContent = pageCss;
    document.head.appendChild(st);
    const done = () => { st.remove(); window.removeEventListener('afterprint', done); };
    window.addEventListener('afterprint', done);
    window.print();
    setTimeout(done, 1500);
  }

  function openLabel(o) {
    const render = (n) => Array.from({ length: n }, () => labelHTML(o)).join('');
    const { el } = openModal(`
      <div class="modal-actions">
        <button class="btn primary" data-act="print">🖨 Imprimir etiqueta</button>
        <label class="btn">Copias <select id="lb-copias" style="background:#000;color:#fff;border:0;font:inherit;margin-left:6px"><option>1</option><option selected>2</option><option>3</option></select></label>
        <button class="btn" data-act="close">Cerrar</button>
      </div>
      <p class="modal-hint">Pegue una etiqueta en el equipo (y otra en la bolsa o cargador). Tamaño 60 × 30 mm: sirve impresora de etiquetas a color, térmica o una normal en papel adhesivo.</p>
      <div class="labels" id="lb-list">${render(2)}</div>`,
    (e, a) => { if (a && a.dataset.act === 'print') printWithPage('@page { size: 60mm 30mm; margin: 0; }'); });
    $('#lb-copias', el).addEventListener('change', (e) => ($('#lb-list', el).innerHTML = render(Number(e.target.value))));
  }

  function openReceipt(o) {
    const c = clienteById(o.clienteId) || {};
    const msg = `Hola ${c.nombre || ''}, le saluda ${db.config.negocio}.\nOrden de ingreso: ${o.numero}\nEquipo: ${equipoTxt(o)}\nFalla: ${o.falla}\nCosto: ${money(o.costo)} | Abono: ${money(num(o.abono) + abonosOrden(o))} | Saldo: ${money(saldoOrden(o))}\nEstado: ${o.estado}`;
    openModal(`
      <div class="modal-actions">
        <button class="btn primary" data-act="print">🖨 Imprimir / PDF</button>
        <button class="btn yellow" data-act="label">🏷 Etiqueta QR</button>
        ${c.whatsapp ? `<a class="btn green" target="_blank" rel="noopener" href="${waLink(c.whatsapp, msg)}">💬 Enviar por WhatsApp</a>` : ''}
        <button class="btn" data-act="close">Cerrar</button>
      </div>
      ${receiptHTML(o)}`,
    (e, a) => {
      if (!a) return;
      if (a.dataset.act === 'print') printWithPage('@page { size: auto; margin: 12mm; }');
      if (a.dataset.act === 'label') openLabel(o);
    });
  }

  // ---- escáner: cámara (celular o laptop) o lector de código USB (escribe y da Enter)
  let jsQRPromise;
  const loadJsQR = () =>
    jsQRPromise || (jsQRPromise = new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = 'vendor/jsQR.js';
      s.onload = () => res(window.jsQR);
      s.onerror = rej;
      document.head.appendChild(s);
    }));

  function openScanner(initialCode) {
    let stream = null, timer = null, stopped = false;
    const { el, close } = openModal(`
      <div class="scan-box">
        <div class="modal-actions"><button class="btn" data-act="close">Cerrar</button></div>
        <h2 class="scan-title">📷 ESCANEAR EQUIPO</h2>
        <div class="scan-cam" id="sc-cam"><video id="sc-video" playsinline muted></video><div class="scan-frame"></div><p id="sc-msg">Abriendo cámara…</p></div>
        <form id="sc-form" class="scan-manual">
          <input id="sc-input" placeholder="Lector USB o escriba el número (ej. SIM-583201)" autocomplete="off">
          <button class="btn primary" type="submit">Buscar</button>
        </form>
        <div id="sc-result"></div>
      </div>`,
    (e, a) => a && handleAction(a),
    () => stopCamera());

    const video = $('#sc-video', el);
    const msg = (t) => ($('#sc-msg', el).textContent = t);

    function stopCamera() {
      stopped = true;
      clearTimeout(timer);
      if (stream) stream.getTracks().forEach((t) => t.stop());
      stream = null;
    }

    async function startCamera() {
      stopped = false;
      $('#sc-cam', el).hidden = false;
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        msg('Esta pantalla no tiene cámara disponible: use el lector USB o escriba el número.');
        return;
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
        if (stopped) return stopCamera();
        video.srcObject = stream;
        await video.play();
        msg('Apunte la cámara al código QR de la etiqueta');
        loop();
      } catch (err) {
        msg('No se pudo abrir la cámara (permiso denegado o sin cámara). Use el lector USB o escriba el número.');
      }
    }

    async function loop() {
      let detector = null;
      if ('BarcodeDetector' in window) {
        try { detector = new BarcodeDetector({ formats: ['qr_code', 'code_128'] }); } catch (e) { detector = null; }
      }
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      const tick = async () => {
        if (stopped || !stream) return;
        try {
          let text = null;
          if (video.readyState >= 2) {
            if (detector) {
              const codes = await detector.detect(video);
              if (codes.length) text = codes[0].rawValue;
            } else {
              const jsQR = await loadJsQR();
              const w = Math.min(640, video.videoWidth);
              const h = Math.round((video.videoHeight / video.videoWidth) * w);
              canvas.width = w; canvas.height = h;
              ctx.drawImage(video, 0, 0, w, h);
              const r = jsQR(ctx.getImageData(0, 0, w, h).data, w, h, { inversionAttempts: 'dontInvert' });
              if (r) text = r.data;
            }
          }
          if (text && handleCode(text)) return;
        } catch (e) { /* sigue intentando */ }
        timer = setTimeout(tick, 180);
      };
      tick();
    }

    // se guarda el id (no el objeto): al sincronizar con la nube los datos se reemplazan por copias nuevas
    let currentId = null;
    const currentOrder = () => db.ordenes.find((x) => x.id === currentId);
    function handleCode(text) {
      const o = findOrder(text);
      if (!o) {
        msg('Código no reconocido: ' + String(text).slice(0, 40));
        return false;
      }
      if (navigator.vibrate) navigator.vibrate(80);
      stopCamera();
      $('#sc-cam', el).hidden = true;
      currentId = o.id;
      showResult();
      return true;
    }

    function showResult(note = '') {
      const o = currentOrder();
      if (!o) { $('#sc-result', el).innerHTML = '<p class="empty">Esta orden ya no existe.</p>'; return; }
      const c = clienteById(o.clienteId) || {};
      const s = saldoOrden(o);
      $('#sc-result', el).innerHTML = `
        <div class="scan-card">
          ${note ? `<div class="scan-note">${note}</div>` : ''}
          <div class="scan-num">${esc(o.numero)} ${estadoTag(o.estado)}${o.factura != null ? ` <span class="tag gray">Factura N°${esc(o.factura)}</span>` : ''}</div>
          <div class="scan-cli">${esc(c.nombre || '(cliente borrado)')}${c.tienda ? ' — ' + esc(c.tienda) : ''}</div>
          <div>${esc(equipoTxt(o))}${o.imei ? ' · IMEI ' + esc(o.imei) : ''}</div>
          <div class="scan-falla">Falla: ${esc(o.falla)}</div>
          <div>Ingresó: ${fmtDate(o.fecha)} · Saldo: ${s > 0 ? `<b class="debe">${money(s)}</b>` : !num(o.costo) ? '<b>SIN PRECIO</b>' : '<b class="pagado">PAGADO</b>'}</div>
          <div class="scan-actions">
            ${o.estado !== 'Listo' && o.estado !== 'Entregado' ? '<button class="btn green big" data-act="listo">✅ MARCAR LISTO</button>' : ''}
            ${o.estado === 'Listo' ? `<button class="btn green" data-act="avisar">💬 ${o.avisadoListo ? 'Reenviar reporte por WhatsApp' : 'Enviar reporte por WhatsApp'}</button>` : ''}
            ${o.estado !== 'Entregado' && s > 0 ? `<button class="btn yellow big" data-act="cobrar">📦 COBRAR ${money(s)} Y ENTREGAR</button><button class="btn" data-act="entregar">Entregar sin cobrar (queda en cartera)</button>` : ''}
            ${o.estado !== 'Entregado' && s <= 0 ? '<button class="btn yellow big" data-act="entregar">📦 MARCAR ENTREGADO</button>' : ''}
            ${o.estado === 'Recibido' ? '<button class="btn" data-act="reparacion">🔧 En reparación</button>' : ''}
            <button class="btn" data-act="ver">Ver orden</button>
            <button class="btn primary" data-act="otro">📷 Escanear otro</button>
          </div>
        </div>`;
    }

    function handleAction(a) {
      const o = currentOrder();
      if (!o && a.dataset.act !== 'otro') return;
      switch (a.dataset.act) {
        case 'listo':
          setEstado(o, 'Listo');
          showResult(enviarReporteListo(o) ? '✅ Marcado LISTO y se abrió WhatsApp con el reporte para el cliente' : '✅ Marcado como LISTO');
          break;
        case 'avisar': enviarReporteListo(o); showResult('💬 Reporte abierto en WhatsApp'); break;
        case 'reparacion': setEstado(o, 'En reparación'); showResult('🔧 Pasó a reparación'); break;
        case 'cobrar': {
          const s = saldoOrden(o);
          const d = db.cartera.find((x) => x.ordenId === o.id);
          if (d) d.abonos.push({ fecha: today(), monto: s });
          db.movimientos.push({ id: uid(), origen: 'abono', ordenId: o.id, fecha: today(), tipo: 'ingreso', concepto: `Pago al entregar ${o.numero}`, clienteId: o.clienteId, monto: s });
          setEstado(o, 'Entregado');
          toast(`Cobrado ${money(s)} y entregado`);
          showResult(`📦 Entregado y cobrado ${money(s)} (sumado al reporte diario)`);
          break;
        }
        case 'entregar': setEstado(o, 'Entregado'); toast(`${o.numero} entregado`); showResult('📦 Marcado como ENTREGADO'); break;
        case 'ver': openReceipt(o); break;
        case 'otro': currentId = null; $('#sc-result', el).innerHTML = ''; $('#sc-input', el).value = ''; startCamera(); $('#sc-input', el).focus(); break;
        default:
      }
      if (location.hash.startsWith('#orden')) refreshOrdenList();
    }

    $('#sc-form', el).addEventListener('submit', (e) => {
      e.preventDefault();
      const v = $('#sc-input', el).value;
      if (!handleCode(v)) toast('No se encontró la orden "' + v + '"');
      $('#sc-input', el).select();
    });

    if (initialCode) {
      if (!handleCode(initialCode)) { startCamera(); toast('No se encontró la orden ' + initialCode); }
    } else {
      startCamera();
      $('#sc-input', el).focus();
    }
  }
  let refreshOrdenList = () => {};

  views.orden = (el) => {
    el.innerHTML = `
      ${head('ORDEN DE INGRESO', 'h-blue', `<button class="btn primary big" id="or-scan">📷 ESCANEAR</button><button class="btn green" id="or-xls">⬇ Descargar Excel</button>`)}
      <form class="card" id="or-form">
        <h2>Plantilla de servicio técnico</h2>
        <div class="form-grid">
          <div class="field"><label for="or-cli">Cliente registrado</label><select id="or-cli">${clienteOptions('', '— Cliente nuevo (llenar abajo) —')}</select></div>
          <div class="field nuevo"><label for="or-nom">Nombre (cliente nuevo)</label><input id="or-nom"></div>
          <div class="field nuevo"><label for="or-tie">Tienda</label><input id="or-tie"></div>
          <div class="field nuevo"><label for="or-wa">WhatsApp</label><input id="or-wa" type="tel"></div>
          <div class="field"><label for="or-eq">Equipo</label><select id="or-eq"><option>Celular</option><option>Tablet</option><option>Laptop</option><option>PC</option><option>Otro</option></select></div>
          <div class="field full"><label>Marca</label>
            <div class="chips" id="or-marcas">${MARCAS.map((m) => `<button type="button" class="chip" data-marca="${m}">${m}</button>`).join('')}<button type="button" class="chip" data-marca="">Otra…</button></div>
            <input id="or-marca-otra" placeholder="Escriba la marca" hidden>
          </div>
          <div class="field"><label for="or-modelo">Modelo</label><input id="or-modelo" list="or-modelos" placeholder="Toque para ver la lista o escriba"><datalist id="or-modelos"></datalist></div>
          <div class="field full"><label>Falla (toque una o varias)</label>
            <div class="chips" id="or-fallas">${FALLAS.map((f) => `<button type="button" class="chip big" data-falla="${f}">${f}</button>`).join('')}<button type="button" class="chip big" data-falla="otra">Otra…</button></div>
            <input id="or-falla-otra" placeholder="Describa la falla" hidden>
          </div>
          <div class="field full"><label for="or-trab">Nota (opcional)</label><input id="or-trab" placeholder="Algo que quiera recordar del equipo"></div>
          <div class="field"><label for="or-costo">Costo</label><input id="or-costo" type="number" step="0.01" min="0" value="0"></div>
          <div class="field"><label for="or-abono">Abono</label><input id="or-abono" type="number" step="0.01" min="0" value="0"></div>
        </div>
        <div class="form-actions"><button class="btn primary big" type="submit">GUARDAR E IMPRIMIR</button></div>
      </form>
      <div class="toolbar">
        <div class="search"><input id="or-q" placeholder="Buscar por número, cliente, marca o modelo…"></div>
        <div class="seg" id="or-filtro"><button class="on" data-f="taller">En taller</button><button data-f="Listo">Listos</button><button data-f="Entregado">Entregados</button><button data-f="all">Todas</button></div>
      </div>
      <div class="table-wrap"><table>
        <thead><tr><th>Factura</th><th>Orden</th><th>Fecha</th><th>Cliente</th><th>Equipo</th><th>Estado</th><th class="num">Saldo</th><th></th></tr></thead>
        <tbody id="or-body"></tbody>
      </table></div>`;

    const toggleNuevo = () => $$('.field.nuevo', el).forEach((f) => (f.hidden = !!$('#or-cli').value));
    $('#or-cli').addEventListener('change', toggleNuevo);
    toggleNuevo();

    let filtro = 'taller';
    const pasaFiltro = (o) => filtro === 'all' || (filtro === 'taller' ? o.estado !== 'Listo' && o.estado !== 'Entregado' : o.estado === filtro);
    function render() {
      const q = $('#or-q').value.toLowerCase();
      const rows = db.ordenes
        .filter((o) => (q ? true : pasaFiltro(o)))
        .filter((o) => !q || [o.numero, o.factura != null ? 'N°' + o.factura : '', clienteNombre(o.clienteId), o.marca, o.modelo, o.imei, o.falla].join(' ').toLowerCase().includes(q))
        .slice().reverse();
      const cuenta = (f) => db.ordenes.filter((o) => (f === 'taller' ? o.estado !== 'Listo' && o.estado !== 'Entregado' : f === 'all' || o.estado === f)).length;
      $$('#or-filtro button', el).forEach((b) => (b.textContent = b.textContent.replace(/ \(\d+\)$/, '') + ` (${cuenta(b.dataset.f)})`));
      $('#or-body').innerHTML = rows.length
        ? rows.map((o) => {
          const s = saldoOrden(o);
          return `<tr>
            <td><b class="fact-n">${o.factura != null ? 'N°' + esc(o.factura) : '—'}</b></td>
            <td><b>${esc(o.numero)}</b></td>
            <td>${fmtDate(o.fecha)}</td>
            <td>${esc(clienteNombre(o.clienteId))}</td>
            <td>${esc([o.equipo, o.marca, o.modelo].filter(Boolean).join(' '))}</td>
            <td><select data-estado="${o.id}" class="btn sm" style="background:#000">${ESTADOS.map((e) => `<option ${e === o.estado ? 'selected' : ''}>${e}</option>`).join('')}</select></td>
            <td class="num">${s > 0 ? `<span class="tag due">${money(s)}</span>` : !num(o.costo) ? '<span class="tag gray">SIN PRECIO</span>' : '<span class="tag ok">PAGADO</span>'}</td>
            <td class="actions">${o.estado === 'Listo' ? `<button class="btn sm green" data-avisar="${o.id}" title="Enviar reporte de LISTO por WhatsApp">💬${o.avisadoListo ? ' ✓' : ''}</button>` : ''}<button class="btn sm" data-label="${o.id}" title="Imprimir etiqueta QR">🏷</button><button class="btn sm" data-img="${o.id}" title="Enviar la orden en imagen por WhatsApp">🖼 Enviar</button><button class="btn sm" data-ver="${o.id}">Ver / Imprimir</button><button class="btn sm red" data-del="${o.id}">Borrar</button></td>
          </tr>`;
        }).join('')
        : `<tr><td colspan="8" class="empty">${db.ordenes.length ? 'No hay órdenes en este filtro' : 'Aún no hay órdenes de ingreso'}</td></tr>`;
    }
    refreshOrdenList = render;
    $('#or-scan').addEventListener('click', () => openScanner());
    $$('#or-filtro button', el).forEach((b) => b.addEventListener('click', () => {
      $$('#or-filtro button', el).forEach((x) => x.classList.toggle('on', x === b));
      filtro = b.dataset.f;
      render();
    }));

    // ---- marca y falla con botones
    let marcaSel = null;
    const fallasSel = new Set();
    const fillModelos = () => ($('#or-modelos').innerHTML = (MODELOS[marcaSel] || []).map((m) => `<option value="${esc(m)}">`).join(''));
    $('#or-marcas').addEventListener('click', (e) => {
      const b = e.target.closest('[data-marca]');
      if (!b) return;
      marcaSel = b.dataset.marca;
      $$('#or-marcas .chip', el).forEach((x) => x.classList.toggle('on', x === b));
      $('#or-marca-otra').hidden = marcaSel !== '';
      if (marcaSel === '') $('#or-marca-otra').focus();
      $('#or-modelo').value = '';
      fillModelos();
    });
    $('#or-fallas').addEventListener('click', (e) => {
      const b = e.target.closest('[data-falla]');
      if (!b) return;
      const f = b.dataset.falla;
      fallasSel.has(f) ? fallasSel.delete(f) : fallasSel.add(f);
      b.classList.toggle('on', fallasSel.has(f));
      $('#or-falla-otra').hidden = !fallasSel.has('otra');
      if (fallasSel.has('otra')) $('#or-falla-otra').focus();
    });
    const resetChips = () => {
      marcaSel = null;
      fallasSel.clear();
      $$('#or-form .chip', el).forEach((x) => x.classList.remove('on'));
      $('#or-marca-otra').hidden = true;
      $('#or-falla-otra').hidden = true;
      fillModelos();
    };

    $('#or-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const marca = marcaSel === '' ? $('#or-marca-otra').value.trim() : marcaSel || '';
      const falla = [...fallasSel].map((f) => (f === 'otra' ? $('#or-falla-otra').value.trim() : f)).filter(Boolean).join(', ');
      if (!falla) {
        toast('Seleccione la falla del equipo');
        return;
      }
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
      const o = {
        id: uid(), numero: nuevoNumeroOrden(), factura: nuevaFactura(), fecha: today(), clienteId,
        equipo: $('#or-eq').value, marca, modelo: $('#or-modelo').value.trim(), falla, trabajo: $('#or-trab').value.trim(),
        costo: num($('#or-costo').value), abono: num($('#or-abono').value), estado: 'Recibido',
        historial: [{ estado: 'Recibido', fecha: new Date().toISOString() }],
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
      resetChips();
      $('#or-cli').innerHTML = clienteOptions('', '— Cliente nuevo (llenar abajo) —');
      toggleNuevo();
      render();
      // esperar a que el servidor confirme el número de factura antes de mostrar el comprobante
      const btn = $('#or-form button[type=submit]');
      btn.disabled = true;
      await syncNow();
      btn.disabled = false;
      const final = db.ordenes.find((x) => x.id === o.id) || o;
      render();
      toast(`Orden guardada · Factura N°${final.factura}`);
      openReceipt(final);
    });
    $('#or-q').addEventListener('input', render);
    $('#or-body').addEventListener('change', (e) => {
      const s = e.target.closest('[data-estado]');
      if (s) {
        const o = db.ordenes.find((x) => x.id === s.dataset.estado);
        setEstado(o, s.value);
        if (s.value === 'Listo') enviarReporteListo(o);
        else toast('Estado actualizado');
        render();
      }
    });
    $('#or-body').addEventListener('click', (e) => {
      const av = e.target.closest('[data-avisar]');
      if (av) { enviarReporteListo(db.ordenes.find((o) => o.id === av.dataset.avisar)); render(); }
      const img = e.target.closest('[data-img]');
      if (img) enviarImagenOrden(db.ordenes.find((o) => o.id === img.dataset.img));
      const lab = e.target.closest('[data-label]');
      if (lab) openLabel(db.ordenes.find((o) => o.id === lab.dataset.label));
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
          Factura: o.factura != null ? o.factura : '', Orden: o.numero, Fecha: fmtDate(o.fecha), Cliente: clienteNombre(o.clienteId), Equipo: o.equipo, Marca: o.marca, Modelo: o.modelo,
          Falla: o.falla, Nota: o.trabajo, Estado: o.estado, 'Listo el': fechaEstado(o, 'Listo'), 'Entregado el': fechaEstado(o, 'Entregado'),
          Costo: num(o.costo), Abono: num(o.abono) + abonosOrden(o), Saldo: saldoOrden(o),
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
  // ---- importar datos (archivo o la contabilidad manual de octubre) sin borrar lo que ya hay.
  // Los clientes se juntan por nombre; lo que ya se importó antes no se repite.
  function prepararImport(data) {
    const llave = (n) => String(n || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim();
    const porNombre = new Map(db.clientes.map((c) => [llave(c.nombre), c.id]));
    const mapa = {};
    const nuevosC = [], nuevosM = [], nuevosD = [];
    (data.clientes || []).forEach((c) => {
      const id = porNombre.get(llave(c.nombre)) || (db.clientes.some((x) => x.id === c.id) ? c.id : null);
      if (id) { mapa[c.id] = id; return; }
      nuevosC.push({ id: c.id, nombre: c.nombre, tienda: c.tienda || '', whatsapp: c.whatsapp || '' });
      porNombre.set(llave(c.nombre), c.id);
      mapa[c.id] = c.id;
    });
    const movIds = new Set(db.movimientos.map((x) => x.id));
    (data.movimientos || []).forEach((m) => {
      if (m.id && !movIds.has(m.id)) nuevosM.push({ ...m, clienteId: mapa[m.clienteId] || m.clienteId || '' });
    });
    const carIds = new Set(db.cartera.map((x) => x.id));
    (data.cartera || []).forEach((d) => {
      if (d.id && !carIds.has(d.id)) nuevosD.push({ ...d, clienteId: mapa[d.clienteId] || d.clienteId, abonos: d.abonos || [] });
    });
    return {
      nC: nuevosC.length, nM: nuevosM.length, nD: nuevosD.length,
      total: nuevosC.length + nuevosM.length + nuevosD.length,
      aplicar() { db.clientes.push(...nuevosC); db.movimientos.push(...nuevosM); db.cartera.push(...nuevosD); },
    };
  }

  // La contabilidad que se llevaba a mano se carga sola, una única vez para todos los equipos:
  // clientes, la cartera al día y los equipos de HOY (5 de octubre) como órdenes de ingreso en "Recibido"
  // (entraron al negocio, no están listos y no se han cobrado). Los días 1 al 4 no se cargan.
  // config.importOct2026: '' = falta cargar · '1' = cargado con días 1–4 · '2' = solo hoy en el reporte · '3' = listo
  const IMPORT_OCT = 'importOct2026';
  const VIEJOS_OCT = /^imp-mov-2026-10-0[1-4]-/;
  const HOY_OCT = /^imp-mov-2026-10-05-(\d+)$/;
  function ordenDesdeTrabajo(m, n) {
    // "Honor Magic 6 Lite 5G – FRP", "Redmi Note 10 Pro – FRP", "Samsung A05S (garantía)"
    let txt = m.concepto || '';
    const fallas = [];
    txt = txt.replace(/\s+–\s+(FRP|KG)\b/g, (x, f) => { fallas.push(f); return ''; });
    if (/\(garant[ií]a\)/i.test(txt)) { fallas.push('Garantía'); txt = txt.replace(/\s*\(garant[ií]a\)/i, ''); }
    txt = txt.trim();
    const [primera, ...resto] = txt.split(' ');
    let marca = '', modelo = txt;
    if (MARCAS.includes(primera)) { marca = primera; modelo = resto.join(' '); }
    else if (/^(Redmi|Poco)$/i.test(primera)) { marca = 'Xiaomi'; modelo = txt; }
    else if (/^\S+$/.test(txt)) { marca = txt; modelo = ''; }
    return {
      id: 'imp-ord-2026-10-05-' + n, numero: nuevoNumeroOrden(), factura: nuevaFactura(), fecha: '2026-10-05',
      clienteId: m.clienteId, equipo: 'Celular', marca, modelo, falla: fallas.join(', ') || 'Por revisar', trabajo: '',
      costo: num(m.total), abono: 0, estado: 'Recibido', importado: true,
      historial: [{ estado: 'Recibido', fecha: '2026-10-05T12:00:00.000Z' }],
    };
  }
  let importOctIntentado = false;
  async function importarOctubre() {
    if (importOctIntentado || db.config[IMPORT_OCT] === '3') return;
    importOctIntentado = true;
    try {
      let msg = '';
      if (!['1', '2'].includes(db.config[IMPORT_OCT])) {
        const r = await fetch('data/contabilidad-oct-2026.json', { cache: 'no-store' });
        const data = await r.json();
        if (hasPending() || db.config[IMPORT_OCT] === '3') return;
        const imp = prepararImport(data);
        imp.aplicar();
        if (imp.nC || imp.nD) msg = `Se cargó la contabilidad: ${imp.nC} clientes y ${imp.nD} deudas. `;
      }
      // días 1 al 4: fuera
      db.movimientos = db.movimientos.filter((m) => !VIEJOS_OCT.test(m.id));
      // trabajos de hoy: pasan del reporte diario a Orden de ingreso
      const hoy = db.movimientos.filter((m) => HOY_OCT.test(m.id)).sort((x, y) => Number(x.id.match(HOY_OCT)[1]) - Number(y.id.match(HOY_OCT)[1]));
      let nO = 0;
      hoy.forEach((m) => {
        const n = m.id.match(HOY_OCT)[1];
        if (db.ordenes.some((o) => o.id === 'imp-ord-2026-10-05-' + n)) return;
        const o = ordenDesdeTrabajo(m, n);
        db.ordenes.push(o);
        if (o.costo > 0) {
          db.cartera.push({ id: 'imp-ordcart-2026-10-05-' + n, origen: 'orden', ordenId: o.id, clienteId: o.clienteId, concepto: `Orden ${o.numero} - ${[o.equipo, o.marca, o.modelo].filter(Boolean).join(' ')}`, monto: o.costo, fecha: o.fecha, abonos: [] });
        }
        nO++;
      });
      db.movimientos = db.movimientos.filter((m) => !HOY_OCT.test(m.id));
      if (nO) msg += `${nO} equipos de hoy pasaron a Orden de ingreso (Recibido)`;
      db.config[IMPORT_OCT] = '3';
      save();
      if (msg) { toast(msg.trim()); refreshView(); }
    } catch (e) {
      importOctIntentado = false; // sin conexión: se intenta en la próxima sincronización
    }
  }

  views.ajustes = (el) => {
    const c = db.config;
    el.innerHTML = `
      ${head('AJUSTES', 'h-blue')}
      <div class="card">
        <h2>Colores de la app</h2>
        <div class="chips" id="aj-tema">
          <button type="button" class="chip big" data-tema="clasico">Clásico</button>
          <button type="button" class="chip big" data-tema="rojo">Rojo, blanco y negro</button>
        </div>
        <p style="color:var(--muted);margin:10px 0 0">Se aplica al instante en este equipo. Si no le gusta, toque <b>Clásico</b> para dejarlo como estaba.</p>
      </div>
      <form class="card" id="aj-negocio">
        <h2>Datos del negocio (salen en la orden de ingreso)</h2>
        <div class="form-grid">
          <div class="field"><label for="aj-neg">Nombre</label><input id="aj-neg" value="${esc(c.negocio)}"></div>
          <div class="field"><label for="aj-tel">Teléfono / WhatsApp</label><input id="aj-tel" value="${esc(c.telefono)}"></div>
          <div class="field"><label for="aj-dir">Dirección</label><input id="aj-dir" value="${esc(c.direccion)}"></div>
          <div class="field"><label for="aj-mon">Símbolo de moneda</label><input id="aj-mon" value="${esc(c.moneda)}" maxlength="4"></div>
          <div class="field"><label for="aj-enc">WhatsApp del encargado (recibe el cierre)</label><input id="aj-enc" type="tel" value="${esc(c.encargadoWa || ENCARGADO_WA)}" placeholder="${ENCARGADO_WA}"></div>
          <div class="field"><label for="aj-pais">Código de país para WhatsApp</label><input id="aj-pais" value="${esc(c.paisWa)}" maxlength="4" inputmode="numeric" placeholder="507"></div>
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
          <label class="btn yellow">➕ Agregar datos (importar)<input type="file" id="aj-import" accept="application/json,.json" hidden></label>
        </div>
      </div>
      <div class="card">
        <h2>Empezar de cero</h2>
        <p style="color:var(--muted);margin-top:0">Borra <b>todos</b> los clientes, órdenes / equipos, cartera, reporte diario, cierres e inventario en <b>todas</b> las computadoras. La factura vuelve a empezar en 00. Se mantienen los datos del negocio, el WhatsApp del encargado y la contraseña. Antes de borrar se descarga una copia por si acaso.</p>
        <div class="form-actions"><button class="btn red" id="aj-reset">🧹 Dejar todo en blanco</button></div>
      </div>`;

    const marcarTema = () => $$('#aj-tema [data-tema]').forEach((b) => b.classList.toggle('on', b.dataset.tema === document.documentElement.dataset.tema));
    marcarTema();
    $('#aj-tema').addEventListener('click', (e) => {
      const b = e.target.closest('[data-tema]');
      if (!b) return;
      ls.set(TEMA_KEY, b.dataset.tema);
      aplicarTema(b.dataset.tema);
      marcarTema();
    });

    $('#aj-negocio').addEventListener('submit', (e) => {
      e.preventDefault();
      // db.config (no `c`): al sincronizar con la nube los datos se reemplazan por copias nuevas
      Object.assign(db.config, {
        negocio: $('#aj-neg').value.trim() || 'SIMTEC', telefono: $('#aj-tel').value.trim(), direccion: $('#aj-dir').value.trim(),
        moneda: $('#aj-mon').value.trim() || '$', dgiUrl: $('#aj-dgi').value.trim() || db.config.dgiUrl,
        paisWa: $('#aj-pais').value.replace(/\D/g, ''),
        encargadoWa: $('#aj-enc').value.trim() || ENCARGADO_WA,
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
        Ordenes: db.ordenes.map((o) => ({ Factura: o.factura != null ? o.factura : '', Orden: o.numero, Fecha: fmtDate(o.fecha), Cliente: clienteNombre(o.clienteId), Equipo: [o.equipo, o.marca, o.modelo].join(' '), Falla: o.falla, Estado: o.estado, Costo: num(o.costo), Abono: num(o.abono) })),
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
    $('#aj-reset').addEventListener('click', () => {
      const n = db.clientes.length + db.ordenes.length + db.cartera.length + db.movimientos.length + db.inventario.length + db.cierres.length;
      if (!confirm(`Se van a borrar ${db.clientes.length} clientes, ${db.ordenes.length} órdenes y todo lo demás (${n} registros) en todas las computadoras. ¿Continuar?`)) return;
      if ((prompt('Para confirmar escriba BORRAR') || '').trim().toUpperCase() !== 'BORRAR') { toast('No se borró nada'); return; }
      $('#aj-backup').click(); // copia de seguridad antes de borrar
      const vacio = { ...emptyDB(), config: { ...db.config } };
      api('POST', 'data', { replace: vacio })
        .then((res) => {
          synced = normalize(res.data);
          db = clone(synced);
          version = res.version;
          cacheLocal();
          toast('Listo: todo quedó en blanco');
          route();
        })
        .catch((err) => (err instanceof AuthError ? handleSyncError(err) : toast('No se pudo borrar: ' + err.message)));
    });
    // Agrega clientes, trabajos y deudas de un archivo sin borrar lo que ya hay.
    // Los clientes se juntan por nombre; lo que ya se importó antes no se repite.
    $('#aj-import').addEventListener('change', (e) => {
      const f = e.target.files[0];
      e.target.value = '';
      if (!f) return;
      const r = new FileReader();
      r.onload = () => {
        let data;
        try {
          data = JSON.parse(r.result);
          if (!data || !data.simtecImport || !Array.isArray(data.clientes)) throw new Error('formato');
        } catch (err) {
          toast('El archivo no es un archivo para importar a SIMTEC');
          return;
        }
        const imp = prepararImport(data);
        if (!imp.total) { toast('Esos datos ya estaban en el sistema'); return; }
        if (!confirm(`Se van a agregar ${imp.nC} clientes nuevos, ${imp.nM} trabajos al reporte diario y ${imp.nD} deudas a Cartera. ¿Continuar?`)) return;
        imp.aplicar();
        save();
        toast(`Listo: ${imp.nC} clientes, ${imp.nM} trabajos y ${imp.nD} deudas agregados`);
      };
      r.readAsText(f);
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
