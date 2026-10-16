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
      negocio: '212 V.I.P Servicio Técnico de Celulares',
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

  // Colores de la app (se guarda en este equipo): 'clasico', 'rojo' (rojo, blanco y negro) o 'fucsia' (fucsia, blanco y negro)
  const TEMA_KEY = 'simtec_tema';
  const aplicarTema = (t) => { document.documentElement.dataset.tema = ['rojo', 'fucsia'].includes(t) ? t : 'clasico'; };
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
      // el negocio ahora se llama 212 V.I.P (una sola vez si aún tenía el nombre anterior)
      if (/^SIMTEC/i.test(db.config.negocio || '')) { db.config.negocio = '212 V.I.P Servicio Técnico de Celulares'; save(); }
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
  let ultimaTecla = 0;
  window.addEventListener('keydown', () => { ultimaTecla = Date.now(); }, { passive: true });
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
    toast('212 V.I.P quedó instalado ✅ Búsquelo en el escritorio o en sus aplicaciones');
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
      // solo espera si alguien está tecleando ahora mismo, hay algo escrito en un formulario o una ventana abierta
      const typing = Date.now() - ultimaTecla < 20000;
      const filled = $$('#view form input, #view form textarea').some((i) => i.type !== 'date' && i.type !== 'number' && i.value);
      if (typing || filled || document.querySelector('.modal-back')) return;
      actualizando = true;
      if (hasPending()) await push();
      if (hasPending()) { actualizando = false; return; } // sin internet: no perder lo anotado
      toast('Actualizando 212 V.I.P…');
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
  // hora normal (12 h): "19:34" → "7:34 PM"
  const hora12 = (h) => {
    const m = /^(\d{1,2}):(\d{2})/.exec(String(h || ''));
    if (!m) return h || '';
    const H = +m[1];
    return `${H % 12 || 12}:${m[2]} ${H < 12 ? 'AM' : 'PM'}`;
  };
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

  // ---- buscadores: el texto de ejemplo se va escribiendo solo, como animación
  const EJEMPLOS = {
    'or-q': ['Buscar por factura, cliente, marca o modelo…', 'Ej: 004', 'Ej: Katia', 'Ej: Samsung A15', 'Ej: Honor'],
    'cl-q': ['Buscar cliente, tienda o número…', 'Ej: Jesica', 'Ej: Cel Plaza', 'Ej: 6000'],
    'ca-q': ['Buscar cliente o modelo…', 'Ej: Ramon', 'Ej: Honor 400 Lite'],
    'in-q': ['Buscar producto…', 'Ej: Pantalla', 'Ej: Batería'],
  };
  function escribirEjemplos(input) {
    const frases = EJEMPLOS[input.id] || [input.placeholder];
    let f = 0, i = 0, borrando = false;
    const paso = () => {
      if (!document.body.contains(input)) return; // se cambió de sección
      if (document.activeElement === input || input.value) { input.placeholder = frases[0]; setTimeout(paso, 600); return; }
      const t = frases[f];
      if (!borrando) {
        i++;
        input.placeholder = t.slice(0, i) + (i < t.length ? '▌' : '');
        if (i >= t.length) { borrando = true; return setTimeout(paso, 1600); }
        return setTimeout(paso, 55);
      }
      i--;
      input.placeholder = t.slice(0, i) + '▌';
      if (i <= 0) { borrando = false; f = (f + 1) % frases.length; return setTimeout(paso, 300); }
      setTimeout(paso, 25);
    };
    input.placeholder = '';
    setTimeout(paso, 400);
  }

  // ------------------------------------------------------------------ router
  const views = {};
  let excelSeccion = null; // descarga en Excel de la sección abierta (botón de arriba, al lado de Ajustes)
  document.getElementById('top-xls').addEventListener('click', () => excelSeccion && excelSeccion());
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
    excelSeccion = null;
    view(main);
    $('#top-xls').hidden = !excelSeccion; // botón de Excel arriba, solo en las secciones que lo tienen
    $$('.search input', main).forEach(escribirEjemplos);
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
      ['reporte', 'Cierre diario', 'cierre-diario'],
      ['factura', 'Factura DGI'],
      ['orden', 'Ingreso y orden de servicio', 'ingreso-orden'],
      ['inventario', 'Inventario'],
    ];
    el.innerHTML = `
      <div class="menu-grid">
        <img class="menu-logo" src="assets/logo-212.jpg" alt="212 V.I.P Servicio Técnico de Celulares">
        ${tiles.map(([k, label, img]) => `<button class="tile t-${k}" data-go="${k}" aria-label="${label}"><img src="assets/${img || k}.jpg" alt="${label}"></button>`).join('')}
      </div>`;
  };


  // ================================================================== LEER EQUIPO (cable USB)
  // Lee marca, modelo y (en Samsung) el bit del binario para llenar la orden sin escribir.
  // Solo lectura. Basado en el lector de equipos de la academia:
  //  · Samsung: puerto COM (Web Serial). Detecta solo el modo: descarga ("DVIF") o encendido (AT+DEVCONINFO)
  //  · Fastboot: WebUSB, getvar product / oem get-product-model (Huawei, Honor)
  // No se guarda ni se muestra IMEI, número de serie ni cuentas: solo marca, modelo y bit.
  const SAMSUNG_VID = 0x04e8;
  const bitDe = (ver) => { const v = String(ver || '').trim(); return v.length >= 5 ? v.charAt(v.length - 5) : ''; };
  const MARCA_DE = [[/samsung/i, 'Samsung'], [/apple|iphone/i, 'iPhone'], [/xiaomi|redmi|poco/i, 'Xiaomi'], [/honor/i, 'Honor'], [/huawei/i, 'Huawei'],
    [/motorola|moto/i, 'Motorola'], [/oppo/i, 'Oppo'], [/tecno/i, 'Tecno'], [/infinix/i, 'Infinix'], [/zte/i, 'ZTE']];
  const marcaNormal = (t) => { const m = MARCA_DE.find(([re]) => re.test(String(t || ''))); return m ? m[1] : String(t || '').replace(/^./, (c) => c.toUpperCase()); };
  // código Samsung → nombre comercial (SM-G990E → S21 FE). Se busca por la letra y los 3 números del código.
  const SAMSUNG_NOMBRES = {
    A013: 'A01 Core', A015: 'A01', A022: 'A02', A025: 'A02s', A032: 'A03 Core', A035: 'A03', A037: 'A03s', A042: 'A04e', A045: 'A04', A047: 'A04s',
    A055: 'A05', A057: 'A05s', A065: 'A06', A066: 'A06 5G', A102: 'A10e', A105: 'A10', A107: 'A10s', A115: 'A11', A125: 'A12', A127: 'A12',
    A135: 'A13', A137: 'A13', A136: 'A13 5G', A145: 'A14', A146: 'A14 5G', A155: 'A15', A156: 'A15 5G', A165: 'A16', A166: 'A16 5G', A202: 'A20e',
    A205: 'A20', A207: 'A20s', A215: 'A21', A217: 'A21s', A225: 'A22', A226: 'A22 5G', A235: 'A23', A236: 'A23 5G', A245: 'A24', A256: 'A25 5G',
    A260: 'A2 Core', A305: 'A30', A307: 'A30s', A315: 'A31', A325: 'A32', A326: 'A32 5G', A336: 'A33 5G', A346: 'A34 5G', A356: 'A35 5G',
    A366: 'A36 5G', A405: 'A40', A415: 'A41', A505: 'A50', A507: 'A50s', A515: 'A51', A516: 'A51 5G', A525: 'A52', A526: 'A52 5G', A528: 'A52s 5G',
    A536: 'A53 5G', A546: 'A54 5G', A556: 'A55 5G', A566: 'A56 5G', A705: 'A70', A715: 'A71', A716: 'A71 5G', A725: 'A72', A736: 'A73 5G',
    A530: 'A8 (2018)', A600: 'A6 (2018)', A605: 'A6+ (2018)', A750: 'A7 (2018)', A920: 'A9 (2018)', J250: 'J2 Pro', J260: 'J2 Core', J400: 'J4',
    J410: 'J4 Core', J415: 'J4+', J600: 'J6', J610: 'J6+', J701: 'J7 Neo', J730: 'J7 Pro', J737: 'J7 (2018)', G532: 'J2 Prime', G570: 'J5 Prime',
    G610: 'J7 Prime', M015: 'M01', M115: 'M11', M127: 'M12', M135: 'M13', M145: 'M14', M156: 'M15 5G', M215: 'M21', M225: 'M22', M236: 'M23 5G',
    M315: 'M31', M325: 'M32', M336: 'M33 5G', M346: 'M34 5G', M515: 'M51', M526: 'M52 5G', M536: 'M53 5G', M546: 'M54 5G', G930: 'S7', G935: 'S7 Edge',
    G950: 'S8', G955: 'S8+', G960: 'S9', G965: 'S9+', G970: 'S10e', G973: 'S10', G975: 'S10+', G977: 'S10 5G', G770: 'S10 Lite', G980: 'S20',
    G981: 'S20 5G', G985: 'S20+', G986: 'S20+ 5G', G988: 'S20 Ultra', G780: 'S20 FE', G781: 'S20 FE 5G', G990: 'S21 FE', G991: 'S21', G996: 'S21+',
    G998: 'S21 Ultra', S901: 'S22', S906: 'S22+', S908: 'S22 Ultra', S711: 'S23 FE', S911: 'S23', S916: 'S23+', S918: 'S23 Ultra', S721: 'S24 FE',
    S921: 'S24', S926: 'S24+', S928: 'S24 Ultra', S931: 'S25', S936: 'S25+', S938: 'S25 Ultra', S937: 'S25 Edge', N950: 'Note 8', N960: 'Note 9',
    N970: 'Note 10', N975: 'Note 10+', N770: 'Note 10 Lite', N980: 'Note 20', N981: 'Note 20 5G', N985: 'Note 20 Ultra', N986: 'Note 20 Ultra 5G',
    F700: 'Z Flip', F707: 'Z Flip 5G', F711: 'Z Flip3', F721: 'Z Flip4', F731: 'Z Flip5', F741: 'Z Flip6', F916: 'Z Fold2', F926: 'Z Fold3',
    F936: 'Z Fold4', F946: 'Z Fold5', F956: 'Z Fold6', T290: 'Tab A 8.0 (2019)', T295: 'Tab A 8.0 (2019)', T500: 'Tab A7', T505: 'Tab A7',
    T220: 'Tab A7 Lite', T225: 'Tab A7 Lite', X200: 'Tab A8', X205: 'Tab A8', X110: 'Tab A9', X115: 'Tab A9', X210: 'Tab A9+', X216: 'Tab A9+'
  };
  const nombreSamsung = (codigo) => {
    const m = /^(?:SM-)?([A-Z])(\d{3})/i.exec(String(codigo || '').trim());
    return m ? SAMSUNG_NOMBRES[(m[1] + m[2]).toUpperCase()] || '' : '';
  };
  const modeloConNombre = (codigo) => { const n = nombreSamsung(codigo); return n ? `${codigo} (${n})` : codigo; };
  // para mostrar: si el modelo guardado es solo el código Samsung, se le agrega el nombre comercial
  const modeloVer = (o) => {
    if (!o.modelo || /\(/.test(o.modelo)) return o.modelo || '';
    if (!o.marca || /samsung/i.test(o.marca)) return modeloConNombre(o.modelo);
    const h = /huawei|honor/i.test(o.marca) && nombreHuawei(o.modelo);
    return h ? `${o.modelo} (${h[1]})` : o.modelo;
  };
  // código Huawei / Honor (lo da Fastboot con «oem get-product-model») → marca y nombre comercial. Se busca por las 3 letras
  // del código y el tipo (LX = 4G, NX/N = 5G). Ej.: RKY-LX3 → Honor X7a
  const HUAWEI_NOMBRES = {
    'RKY-L': ['Honor', 'X7a'], 'CMA-L': ['Honor', 'X7'], 'CLK-L': ['Honor', 'X7b'], 'ALT-L': ['Honor', 'X7c'], 'TFY-L': ['Honor', 'X8'], 'CRT-L': ['Honor', 'X8a'],
    'LLY-L': ['Honor', 'X8b'], 'VNE-L': ['Honor', 'X6'], 'VNE-N': ['Honor', 'X8 5G'], 'WDY-L': ['Honor', 'X6a'], 'JDY-L': ['Honor', 'X6b'], 'VNA-L': ['Honor', 'X5'],
    'WOD-L': ['Honor', 'X5 Plus'], 'CRT-N': ['Honor', '90 Lite'], 'RMO-N': ['Honor', 'Magic5 Lite / X9a'], 'ALI-N': ['Honor', 'Magic6 Lite / X9b'],
    'BRP-N': ['Honor', 'Magic7 Lite / X9c'], 'NTN-L': ['Honor', '50 Lite'],
    'POT-L': ['Huawei', 'P Smart 2019'], 'FIG-L': ['Huawei', 'P Smart 2018'], 'PPA-L': ['Huawei', 'P Smart 2020'], 'STK-L': ['Huawei', 'Y9 Prime 2019'],
    'JKM-L': ['Huawei', 'Y9 2019'], 'FLA-L': ['Huawei', 'Y9 2018'], 'MAR-L': ['Huawei', 'P30 Lite'], 'ELE-L': ['Huawei', 'P30'], 'VOG-L': ['Huawei', 'P30 Pro'],
    'ANE-L': ['Huawei', 'P20 Lite'], 'JNY-L': ['Huawei', 'P40 Lite'], 'ART-L': ['Huawei', 'Y7p / P40 Lite E'], 'DUB-L': ['Huawei', 'Y7 2019'], 'LDN-L': ['Huawei', 'Y7 2018'],
    'MRD-L': ['Huawei', 'Y6 2019'], 'ATU-L': ['Huawei', 'Y6 2018'], 'MED-L': ['Huawei', 'Y6p'], 'AMN-L': ['Huawei', 'Y5 2019'], 'DRA-L': ['Huawei', 'Y5 2018'],
    'YAL-L': ['Huawei', 'Nova 5T'], 'MGA-L': ['Huawei', 'Nova Y70'],
  };
  const nombreHuawei = (codigo) => {
    const m = /^([A-Z]{3})-([A-Z])/i.exec(String(codigo || '').trim());
    return m ? HUAWEI_NOMBRES[`${m[1]}-${m[2]}`.toUpperCase()] || null : null;
  };
  // tipo de memoria que da el modo descarga: PRODUCT (chip) y VENDOR (fabricante) → "UFS Samsung", "eMMC Micron"…
  const FABRICANTES = { SAMSUNG: 'Samsung', MICRON: 'Micron', SKHYNIX: 'SK Hynix', HYNIX: 'SK Hynix', 'SK HYNIX': 'SK Hynix', TOSHIBA: 'Kioxia', KIOXIA: 'Kioxia', SANDISK: 'SanDisk', WDC: 'SanDisk', YMTC: 'YMTC' };
  const tipoMemoria = (producto, fabricante) => {
    const v = String(fabricante || '').trim().toUpperCase();
    const fab = FABRICANTES[v] || (v ? v.charAt(0) + v.slice(1).toLowerCase() : '');
    const pr = String(producto || '').trim().toUpperCase();
    if (!pr) return fab;
    const tipo = /^KLM/.test(pr) ? 'eMMC' : /^KLU/.test(pr) ? 'UFS' : pr.length <= 6 ? 'eMMC' : 'UFS';
    return [tipo, fab].filter(Boolean).join(' ');
  };
  const conTiempo = (p, ms, msg) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(msg)), ms))]);
  const sinSerial = () => { if (!('serial' in navigator)) throw new Error('Este navegador no puede leer el puerto COM. Use Chrome o Edge en una computadora.'); };
  const sinUsb = () => { if (!('usb' in navigator)) throw new Error('Este navegador no puede leer por USB. Use Chrome o Edge en una computadora.'); };

  async function puertoSamsung(log) {
    sinSerial();
    log('Elija el puerto «SAMSUNG Mobile USB Modem» en la ventana de Chrome…');
    try {
      return await navigator.serial.requestPort({ filters: [{ usbVendorId: SAMSUNG_VID }] });
    } catch (e) {
      throw new Error('No eligió el puerto del Samsung. Si no aparece, instale los drivers USB de Samsung y conecte otra vez el cable.');
    }
  }
  async function abrirPuerto(port) {
    try {
      await conTiempo(port.open({ baudRate: 115200 }), 6000, 'No se pudo abrir el puerto');
    } catch (e) {
      throw new Error('El puerto del Samsung está ocupado. Cierre Odin, la box o Smart Switch y vuelva a intentar.');
    }
    try { await port.setSignals({ dataTerminalReady: true }); } catch (e) { /* no todos lo permiten */ }
  }
  // lee del puerto hasta que `listo(texto)` sea verdadero o se acabe el tiempo
  async function leerHasta(port, listo, ms) {
    const reader = port.readable.getReader();
    const dec = new TextDecoder();
    let txt = '';
    const fin = Date.now() + ms;
    try {
      while (Date.now() < fin && !listo(txt)) {
        const r = await Promise.race([reader.read(), new Promise((res) => setTimeout(() => res({ done: true, tiempo: true }), Math.max(50, fin - Date.now())))]);
        if (r.value) txt += dec.decode(r.value, { stream: true });
        if (r.done) break;
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    return txt;
  }
  async function escribir(port, texto) {
    const w = port.writable.getWriter();
    try { await w.write(new TextEncoder().encode(texto)); } finally { w.releaseLock(); }
  }

  // Samsung: detecta solo si está en modo descarga o encendido, por el mismo puerto COM.
  //  · modo descarga: "DVIF\n" → "@#MODEL=SM-A125M;VER=A125MUBS3BVA1;…@#" (no abre sesión ni toca nada)
  //  · encendido (sin depuración USB): AT+DEVCONINFO por el puerto módem
  async function leerSamsung(log) {
    const port = await puertoSamsung(log);
    await abrirPuerto(port);
    try {
      log('> DVIF (modo descarga)');
      await escribir(port, 'DVIF\n');
      const txt = await leerHasta(port, (t) => /@#[\s\S]*@#/.test(t), 2500);
      const cuerpo = (txt.match(/@#([\s\S]*?)@#/) || [])[1];
      if (cuerpo) {
        const info = {};
        cuerpo.split(';').forEach((kv) => { const i = kv.indexOf('='); if (i > 0) info[kv.slice(0, i).trim()] = kv.slice(i + 1).trim(); });
        if (info.MODEL) return { modo: 'Samsung modo descarga', marca: 'Samsung', modelo: modeloConNombre(info.MODEL), version: info.VER || '', bit: bitDe(info.VER), memoria: tipoMemoria(info.PRODUCT, info.VENDOR), huella: info.UN || '' };
      }
      log('No está en modo descarga: se prueba encendido…');
      const at = async (cmd) => {
        log('> ' + cmd);
        await escribir(port, cmd + '\r\n');
        return leerHasta(port, (t) => /\r?\n(OK|ERROR)\r?\n?$/.test(t) || /\+CME ERROR/.test(t), 4000);
      };
      await at('AT');
      const r = await at('AT+DEVCONINFO');
      const info = {};
      const c2 = (r.match(/\+DEVCONINFO:\s*([\s\S]*?)(?:\r?\n(?:OK|ERROR)|$)/) || [])[1] || '';
      for (const m of c2.matchAll(/([A-Z]+)\(([^)]*)\)/g)) info[m[1]] = m[2];
      let modelo = info.MN;
      if (!modelo) {
        const g = await at('AT+GMM');
        modelo = g.split(/\r?\n/).map((l) => l.trim()).find((l) => l && l !== 'OK' && !/^AT/.test(l));
      }
      if (!modelo) throw new Error('El equipo no respondió. Póngalo en modo descarga (pantalla azul «Downloading») y pruebe otro cable o puerto USB.');
      const ver = (info.VER || '').split('/')[0] || info.BASE || '';
      return { modo: 'Samsung encendido', marca: 'Samsung', modelo: modeloConNombre(modelo), version: ver, bit: bitDe(ver), huella: info.UN || info.SN || '' };
    } finally {
      await port.close().catch(() => {});
    }
  }

  // Fastboot: getvar / oem (solo lectura)
  async function leerFastboot(log) {
    sinUsb();
    const FB = { classCode: 0xff, subclassCode: 0x42, protocolCode: 0x03 };
    log('Elija el equipo en modo Fastboot en la ventana de Chrome…');
    let device;
    try { device = await navigator.usb.requestDevice({ filters: [FB] }); } catch (e) { throw new Error('No eligió ningún equipo en modo Fastboot.'); }
    await device.open();
    if (!device.configuration) await device.selectConfiguration(1);
    let c = null;
    for (const iface of device.configuration.interfaces) {
      for (const alt of iface.alternates) {
        if (alt.interfaceClass !== FB.classCode || alt.interfaceSubclass !== FB.subclassCode || alt.interfaceProtocol !== FB.protocolCode) continue;
        const epIn = alt.endpoints.find((x) => x.direction === 'in' && x.type === 'bulk');
        const epOut = alt.endpoints.find((x) => x.direction === 'out' && x.type === 'bulk');
        if (!epIn || !epOut) continue;
        try { await device.claimInterface(iface.interfaceNumber); } catch (e) {
          await device.close().catch(() => {});
          throw new Error('El puerto Fastboot está ocupado. Cierre fastboot.exe, la box o Mi Flash y vuelva a intentar.');
        }
        c = { epIn: epIn.endpointNumber, epOut: epOut.endpointNumber };
        break;
      }
      if (c) break;
    }
    if (!c) { await device.close().catch(() => {}); throw new Error('El equipo no está en modo Fastboot.'); }
    const dec = new TextDecoder();
    const cmd = async (t) => {
      log('> fastboot ' + t.replace(':', ' '));
      await device.transferOut(c.epOut, new TextEncoder().encode(t));
      const info = [];
      for (let i = 0; i < 200; i++) {
        const r = await conTiempo(device.transferIn(c.epIn, 512), 5000, 'sin respuesta');
        const pkt = r.data ? dec.decode(r.data) : '';
        const head = pkt.slice(0, 4);
        const body = pkt.slice(4).trim();
        if (head === 'INFO' || head === 'TEXT') info.push(body);
        else if (head === 'OKAY') return [body, ...info].filter(Boolean).join(' ').trim();
        else throw new Error(body || 'FAIL');
      }
      return '';
    };
    const prueba = (t) => cmd(t).catch(() => '');
    try {
      const huawei = await prueba('oem get-product-model'); // Huawei / Honor dan el modelo completo
      const producto = huawei || (await prueba('getvar:product'));
      if (!producto) throw new Error('El equipo no respondió en Fastboot.');
      const fab = (device.manufacturerName || '') + ' ' + producto;
      const huella = (await prueba('getvar:serialno')) || device.serialNumber || '';
      const h = nombreHuawei(producto); // Honor y Huawei: el código dice la marca real y el nombre (RKY-LX3 → Honor X7a)
      if (h) return { modo: 'Fastboot', marca: h[0], modelo: `${producto} (${h[1]})`, version: '', bit: '', huella };
      return { modo: 'Fastboot', marca: marcaNormal(huawei ? 'huawei ' + fab : fab), modelo: producto, version: '', bit: '', huella };
    } finally {
      await device.close().catch(() => {});
    }
  }

  // código único del equipo (UN de Samsung o número de serie): sirve para saber si el mismo teléfono ya vino antes
  const llaveHuella = (h) => String(h || '').trim().toUpperCase();
  const visitasDe = (huella, salvoId) => {
    const k = llaveHuella(huella);
    if (!k) return [];
    return db.ordenes.filter((o) => o.id !== salvoId && llaveHuella(o.huella) === k).sort((a, b) => String(b.fecha).localeCompare(String(a.fecha)));
  };
  const avisoVisitas = (vs) => (vs.length ? `<div class="ya-vino">🔁 <b>Este equipo ya estuvo aquí ${vs.length === 1 ? '1 vez' : vs.length + ' veces'}</b>${vs.slice(0, 3).map((o) =>
    `<div>N°${esc(o.factura != null ? o.factura : o.numero)} · ${fmtDate(o.fecha)} · ${esc(clienteNombre(o.clienteId) || '')} · ${esc(o.falla || '')} · ${esc(o.estado || '')}</div>`).join('')}</div>` : '');

  // ventana "Leer equipo": se elige cómo está conectado y se devuelve { marca, modelo, bit } a quien la abrió
  function abrirLectorEquipo(alListo) {
    const MODOS = [
      { k: 'samsung', ic: '📥', t: 'Samsung', fn: leerSamsung },
      { k: 'fastboot', ic: '⚡', t: 'Fastboot', fn: leerFastboot },
    ];
    let ocupado = false;
    const { el: m, close } = openModal(`
      <div class="card lector-box">
        <div class="modal-actions"><button class="btn" data-act="close">Cerrar</button></div>
        <h2 class="scan-title">🔌 LEER EQUIPO</h2>
        <div class="lector-modos">${MODOS.map((x) => `<button type="button" class="lector-modo" data-modo="${x.k}"><span class="lm-ic">${x.ic}</span><b>${x.t}</b></button>`).join('')}</div>
        <div class="lector-log" id="le-log" hidden></div>
        <div class="lector-res" id="le-res" hidden></div>
      </div>`, async (e, a) => {
      const b = e.target.closest('[data-modo]');
      if (!b || ocupado) return;
      const modo = MODOS.find((x) => x.k === b.dataset.modo);
      const logEl = m.querySelector('#le-log');
      const resEl = m.querySelector('#le-res');
      const log = (t) => { logEl.hidden = false; logEl.insertAdjacentHTML('beforeend', `<div>${esc(t)}</div>`); logEl.scrollTop = logEl.scrollHeight; };
      logEl.innerHTML = '';
      resEl.hidden = true;
      ocupado = true;
      $$('.lector-modo', m).forEach((x) => { x.disabled = true; x.classList.toggle('on', x === b); });
      try {
        const r = await modo.fn(log);
        log('✅ Equipo leído');
        resEl.hidden = false;
        resEl.innerHTML = `
          <div class="lr-fila"><span>Marca</span><b>${esc(r.marca || '—')}</b></div>
          <div class="lr-fila"><span>Modelo</span><b>${esc(r.modelo)}</b></div>
          ${r.bit ? `<div class="lr-fila"><span>Binario (bit)</span><b>${esc(r.bit)}</b></div>` : ''}
          ${r.memoria ? `<div class="lr-fila"><span>Memoria</span><b>${esc(r.memoria)}</b></div>` : ''}
          ${avisoVisitas(visitasDe(r.huella))}`;
        // quien abrió la ventana puede seguir aquí mismo (cliente, falla y precio); si no, se cierra
        const sigue = alListo(r, { cont: resEl, close, modal: m });
        if (sigue) { m.querySelector('.lector-modos').hidden = true; logEl.hidden = true; } else setTimeout(close, 900);
      } catch (err) {
        log('❌ ' + (err && err.message ? err.message : String(err)));
      } finally {
        ocupado = false;
        $$('.lector-modo', m).forEach((x) => { x.disabled = false; });
      }
    });
    return close;
  }

  // ================================================================== CLIENTES
  views.clientes = (el) => {
    let editId = null;
    el.innerHTML = `
      ${head('CLIENTES', 'h-blue')}
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
    excelSeccion = (() =>
      exportXLSX(`Clientes_212VIP_${today()}.xlsx`, {
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
  // pasa a cartera al cerrar el día (o si ese día ya tiene cierre guardado, o ya pasó)
  const enCartera = (d) => !esperaCierre(d) || !!d.cerrado || d.fecha < today() || !!db.cierres.find((c) => c.fecha === d.fecha);
  const ordenById = (id) => db.ordenes.find((o) => o.id === id);
  const modeloDe = (d) => {
    const o = d.ordenId && ordenById(d.ordenId);
    return o ? [o.marca, o.modelo].filter(Boolean).join(' ') || o.equipo || 'Equipo' : d.concepto;
  };
    // lo que vale el trabajo: el precio de la orden, o el monto de la deuda si no viene de una orden
  const valorTrabajo = (d) => {
    const o = d.ordenId && ordenById(d.ordenId);
    return o && num(o.costo) ? num(o.costo) : num(d.monto);
  };
  // modelo con lo que vale el trabajo: "Samsung A36 ($ 15,00)"
  const modeloFact = (d) => `${modeloDe(d)} (${money(valorTrabajo(d)).replace(' ', '\u00a0')})`; // sin cortar "$" del número
  // "4 × Honor 400 Lite, 1 × Samsung A15"
  const resumenModelos = (deudas) => {
    const m = new Map();
    deudas.forEach((d) => m.set(modeloFact(d), (m.get(modeloFact(d)) || 0) + 1));
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
    const deudaFechas = [];
    deudas.filter((d) => saldo(d) > 0).sort((a, b) => a.fecha.localeCompare(b.fecha)).forEach((d) => {
      if (resto <= 0) return;
      const m = Math.min(resto, saldo(d));
      d.abonos.push({ fecha: today(), monto: m });
      deudaFechas.push(d.fecha);
      resto -= m;
    });
    // deudaFechas: de qué días eran las deudas que se pagaron (para separar lo de hoy de lo de días anteriores)
    db.movimientos.push({ id: uid(), origen: 'abono', fecha: today(), tipo: 'ingreso', concepto, clienteId, monto: monto - resto, deudaFechas });
    save();
  }

  views.cartera = (el) => {
    el.innerHTML = `
      ${head('CARTERA', 'h-yellow')}
      <div class="stats-row" id="ca-stats"></div>
      <div class="toolbar">
        <div class="search"><input id="ca-q" placeholder="Buscar cliente o modelo…"></div>
      </div>
      <div class="table-wrap"><table>
        <thead id="ca-head"></thead>
        <tbody id="ca-body"></tbody>
        <tfoot><tr><td id="ca-total-lab">TOTAL QUE ME DEBEN</td><td class="num" id="ca-total"></td><td></td></tr></tfoot>
      </table></div>
      <p id="ca-pend" class="hint-line"></p>
      `;

    // una sola tabla: cada deuda pendiente con su cliente, y los botones en cada fila
    const filtro = 'pend';
    let vista = 'cliente'; // una fila por cliente; al tocarla se abre su cuenta con todos los botones
    // ---- cuenta de un cliente: lista completa de lo que debe y resumen para WhatsApp
    const deudasDe = (id) => db.cartera.filter((d) => enCartera(d) && d.clienteId === id && saldo(d) > 0).sort((a, b) => a.fecha.localeCompare(b.fecha));
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
          // cada equipo con lo que vale el trabajo: "Honor X7D 5G ($ 15,00)"
          { icono: '📱', etiqueta: 'Equipos:', valor: ds.map((d) => modeloFact(d).replace(/ /g, '\u00a0')).join('\n') || '-', color: 'rosa' },
          { icono: '🧾', etiqueta: 'Deudas:', valor: `${ds.length} ${ds.length === 1 ? 'pendiente' : 'pendientes'}`, color: 'amarillo' },
          { icono: '💵', etiqueta: 'Total:', valor: money(total), color: 'verde' },
          { icono: '💳', etiqueta: 'Abonado:', valor: money(total - debe), color: 'morado' },
          { icono: '👛', etiqueta: 'A pagar:', valor: money(debe), color: 'naranja' },
        ],
      });
      compartirImagen(blob, `212VIP_cuenta_${(c.nombre || 'cliente').replace(/\W+/g, '_')}.png`, `Estado de cuenta · ${db.config.negocio}`, c.whatsapp);
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
            <thead><tr><th>Fecha</th><th>Equipo / modelo</th><th class="num">Valor del trabajo</th><th class="num">Abonado</th><th class="num">Debe</th><th></th></tr></thead>
            <tbody>${todas.map((d) => {
              const s = saldo(d);
              return `<tr><td>${fmtDate(d.fecha)}</td><td>${esc(modeloDe(d))}</td>
                <td class="num">${money(valorTrabajo(d))}</td><td class="num">${money(abonado(d))}</td>
                <td class="num">${s > 0 ? `<span class="tag due">${money(s)}</span>` : '<span class="tag ok">PAGADO</span>'}</td>
                <td class="actions">${s > 0 ? `<button class="btn sm green" data-act="abonar-d" data-id="${d.id}">Abonar</button>` : ''}<button class="btn sm red" data-act="borrar-d" data-id="${d.id}">Borrar</button></td></tr>`;
            }).join('') || '<tr><td colspan="6" class="empty">Sin deudas</td></tr>'}</tbody>
            <tfoot><tr><td colspan="4">TOTAL A PAGAR</td><td class="num">${money(debe)}</td><td></td></tr></tfoot>
          </table></div>
          ${abonos.length ? `<p class="hint-line"><b>Abonos:</b> ${abonos.map((a) => `${fmtDate(a.fecha)} ${money(a.monto)} (${esc(a.modelo)})`).join(' · ')}</p>` : ''}
          <div class="modal-actions">
            ${debe > 0 ? `<button class="btn green" data-act="wa">🖼 Enviar reporte por WhatsApp</button><button class="btn yellow" data-act="abonar">Abonar a la cuenta</button>` : ''}
            <button class="btn" data-act="close">Cerrar</button>
          </div>
        </div>`, (e, a, close) => {
        if (!a) return;
        if (a.dataset.act === 'wa') enviarResumen(id);
        const volver = () => { close(); render(); verCuenta(id); }; // se vuelve a abrir con los datos al día
        if (a.dataset.act === 'abonar') {
          close();
          abonarDe(id);
          verCuenta(id);
        }
        if (a.dataset.act === 'abonar-d') {
          const d = db.cartera.find((x) => x.id === a.dataset.id);
          if (!d) return;
          const v = prompt(`Abono para "${modeloDe(d)}" (debe ${money(saldo(d))}):`, saldo(d).toFixed(2));
          if (v === null) return;
          const m = Math.min(num(v), saldo(d));
          if (m <= 0) return;
          abonarCliente(d.clienteId, [d], m, `Abono cartera: ${modeloDe(d)}`);
          toast('Abono registrado y sumado al cierre diario');
          volver();
        }
        if (a.dataset.act === 'borrar-d') {
          const d = db.cartera.find((x) => x.id === a.dataset.id);
          if (!d || !confirm(`¿Borrar la deuda de "${modeloDe(d)}" (${money(saldo(d))})?`)) return;
          db.cartera = db.cartera.filter((x) => x.id !== d.id);
          save();
          toast('Deuda borrada');
          volver();
        }
      });
    }

    function render() {
      const q = $('#ca-q').value.toLowerCase();
      const visibles = db.cartera.filter(enCartera);
      const deudas = visibles.filter((d) => filtro === 'all' || saldo(d) > 0);
      const match = (d) => !q || [clienteNombre(d.clienteId), d.concepto, modeloDe(d)].join(' ').toLowerCase().includes(q);

      if (vista === 'cliente') {
        // cada cliente es una barra: al tocarla se abre su cuenta (los equipos se ven ahí)
        $('#ca-head').innerHTML = '<tr><th>Cliente</th><th class="num">Total</th><th class="num">Abonado</th><th class="num">Debe</th><th></th></tr>';
        $('#ca-total-lab').colSpan = 3;
        const grupos = porCliente(deudas.filter(match));
        $('#ca-body').innerHTML = grupos.length
          ? grupos.map((g) => {
            const c = clienteById(g.clienteId) || {};
            return `<tr class="fila-cli" data-cuenta="${g.clienteId}" title="Ver la cuenta de ${esc(c.nombre || '')}">
              <td class="cli-barra"><b>${esc(c.nombre || '(cliente borrado)')}</b>${c.tienda ? `<small>${esc(c.tienda)}</small>` : ''}<span class="cli-flecha">›</span></td>
              <td class="num">${money(g.monto)}</td>
              <td class="num">${money(g.abonado)}</td>
              <td class="num">${g.debe > 0 ? `<span class="tag due">${money(g.debe)}</span>` : '<span class="tag ok">PAGADO</span>'}</td>
              <td></td></tr>`;
          }).join('')
          : `<tr><td colspan="5" class="empty">Nadie le debe 🎉</td></tr>`;
      } else {
        $('#ca-head').innerHTML = '<tr><th>Fecha</th><th>Cliente</th><th>Equipo / modelo</th><th class="num">Monto</th><th class="num">Abonado</th><th class="num">Debe</th><th></th></tr>';
        $('#ca-total-lab').colSpan = 5;
        // agrupado por cliente (el que más debe primero) y dentro por fecha
        const debeCli = new Map();
        deudas.forEach((d) => debeCli.set(d.clienteId, (debeCli.get(d.clienteId) || 0) + saldo(d)));
        const rows = deudas.filter(match).sort((a, b) => (debeCli.get(b.clienteId) - debeCli.get(a.clienteId)) || String(a.clienteId).localeCompare(String(b.clienteId)) || a.fecha.localeCompare(b.fecha));
        $('#ca-body').innerHTML = rows.length
          ? rows.map((d) => {
            const c = clienteById(d.clienteId) || {};
            const s = saldo(d);
            return `<tr>
              <td>${fmtDate(d.fecha)}</td>
              <td><b>${esc(c.nombre || '(cliente borrado)')}</b></td>
              <td>${esc(modeloFact(d))}</td>
              <td class="num">${money(d.monto)}</td>
              <td class="num">${money(abonado(d))}</td>
              <td class="num">${s > 0 ? `<span class="tag due">${money(s)}</span>` : '<span class="tag ok">PAGADO</span>'}</td>
              <td class="actions">
                ${s > 0 ? `<button class="btn sm green" data-abono="${d.id}">Abonar</button>` : ''}
                <button class="btn sm" data-cuenta="${d.clienteId}" title="Ver la cuenta completa del cliente">📋 Cuenta</button>
                <button class="btn sm green" data-wa-cli="${d.clienteId}" title="Enviar el estado de cuenta en imagen por WhatsApp">🖼 WhatsApp</button>
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
        <div class="stat red"><div class="label">Clientes que deben</div><div class="value">${deudores}</div></div>`;
      const pendHoy = db.cartera.filter((d) => !enCartera(d) && saldo(d) > 0);
      $('#ca-pend').innerHTML = pendHoy.length
        ? `⏳ Hay ${pendHoy.length} ${pendHoy.length === 1 ? 'trabajo' : 'trabajos'} de hoy con saldo (${money(pendHoy.reduce((s, d) => s + saldo(d), 0))}) que pasan a Cartera con el <a href="#reporte">cierre del día</a>.`
        : '';
    }

    $('#ca-q').addEventListener('input', render);
    const setVista = (v) => {
      vista = v;
      render();
    };
    function abonarDe(id) {
      const deudas = deudasDe(id);
      const debe = deudas.reduce((t, d) => t + saldo(d), 0);
      const v = prompt(`Abono de ${clienteNombre(id)} (debe ${money(debe)} por ${resumenModelos(deudas)}):`, debe.toFixed(2));
      if (v === null) return;
      const m = Math.min(num(v), debe);
      if (m <= 0) return;
      abonarCliente(id, deudas, m, `Abono cartera: ${resumenModelos(deudas)}`);
      toast('Abono registrado y sumado al cierre diario');
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
        toast('Abono registrado y sumado al cierre diario');
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
    excelSeccion = (() => {
      const visibles = db.cartera.filter(enCartera);
      exportXLSX(`Cartera_212VIP_${today()}.xlsx`, {
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
      <div class="card"><h2>🏆 Ranking de clientes</h2><p class="es-sub">Del que más ganancia deja al que menos · en cada barra: ganancia y trabajos</p><div class="rank" id="es-rank"></div></div>`;

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
      // por utilidad: el que más ganancia deja va de primero
      const data = compute().sort((a, b) => b.dinero - a.dinero || b.trabajos - a.trabajos);
      const max = Math.max(1, ...data.map((r) => r.dinero));
      $('#es-rank').innerHTML = data.length
        ? data.map((r, i) => {
          const c = clienteById(r.id);
          return `<div class="rank-row" style="animation-delay:${i * 0.06}s">
            <div class="rank-pos">${i + 1}</div>
            <div class="rank-name">${esc(c.nombre)}<small>${esc(c.tienda || '')}</small></div>
            <div class="bar-track"><div class="bar c${i % 5}" data-w="${Math.max(6, (r.dinero / max) * 100)}">${money(r.dinero)} · ${r.trabajos} ${r.trabajos === 1 ? 'trabajo' : 'trabajos'}</div></div>
          </div>`;
        }).join('')
        : `<p class="empty">Todavía no hay trabajos registrados. Cree órdenes de ingreso o ventas en el cierre diario.</p>`;
      requestAnimationFrame(() => requestAnimationFrame(() => $$('.bar', el).forEach((b) => (b.style.width = b.dataset.w + '%'))));
      const totalT = data.reduce((s, r) => s + r.trabajos, 0);
      const totalD = data.reduce((s, r) => s + r.dinero, 0);
      $('#es-stats').innerHTML = `
        <div class="stat blue"><div class="label">Clientes registrados</div><div class="value" data-count="${db.clientes.length}">0</div></div>
        <div class="stat green"><div class="label">Trabajos totales</div><div class="value" data-count="${totalT}">0</div></div>
        <div class="stat yellow"><div class="label">Ganancia total</div><div class="value" data-count="${totalD}" data-money="1">0</div></div>
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
  // deja la deuda de cada orden de ese día igual a lo que dice la orden (precio − abono inicial):
  // una sola deuda por orden, con la fecha de la orden; así "Quedaron debiendo" cuadra con la lista de órdenes
  function repararDeudasDelDia(f) {
    let cambio = false;
    db.ordenes.filter((o) => o.fecha === f && num(o.costo) > 0).forEach((o) => {
      const ds = db.cartera.filter((x) => x.ordenId === o.id);
      const base = Math.max(0, num(o.costo) - num(o.abono));
      let d = ds[0];
      if (ds.length > 1) { // deudas repetidas de la misma orden: se juntan en una
        ds.slice(1).forEach((x) => { d.abonos = (d.abonos || []).concat(x.abonos || []); if (x.cerrado) d.cerrado = d.cerrado || x.cerrado; });
        const quitar = new Set(ds.slice(1).map((x) => x.id));
        db.cartera = db.cartera.filter((x) => !quitar.has(x.id));
        cambio = true;
      }
      if (!d) {
        if (base > 0) { db.cartera.push({ id: uid(), origen: 'orden', ordenId: o.id, clienteId: o.clienteId, concepto: `Orden ${o.numero} - ${[o.equipo, o.marca, o.modelo].filter(Boolean).join(' ')}`, monto: base, fecha: o.fecha, abonos: [] }); cambio = true; }
        return;
      }
      if (num(d.monto) !== base) { d.monto = base; cambio = true; }
      if (d.fecha !== o.fecha && !d.cerrado) { d.fecha = o.fecha; cambio = true; }
      if (d.clienteId !== o.clienteId) { d.clienteId = o.clienteId; cambio = true; }
    });
    return cambio;
  }
  // números del día, sacados de las órdenes de ese día (lo mismo que se ve en la lista de órdenes)
  // números del día f tal como quedaron AL FINAL de ese día (lo que se pagó después cuenta en el día que se pagó):
  //  Pagaron = lo pagado ese día por los trabajos de ese día · Quedaron debiendo = lo que quedó pendiente de esos trabajos
  //  Total del día = Pagaron + Quedaron debiendo. Es lo mismo para los cuadros, el historial, los PDF y el mensaje.
  const pagadoAl = (d, f) => (d.abonos || []).filter((a) => String(a.fecha || '') <= f).reduce((t, a) => t + num(a.monto), 0);
  const saldoAl = (d, f) => Math.max(0, num(d.monto) - pagadoAl(d, f));
  function numerosDelDia(f) {
    const ords = db.ordenes.filter((o) => o.fecha === f);
    const movs = db.movimientos.filter((m) => m.fecha === f);
    const pagos = new Map();
    const sumarPago = (id, txt, m) => {
      if (m <= 0) return;
      const r = pagos.get(id || '') || { clienteId: id, eq: [], total: 0 };
      r.eq.push(`${txt} (${money(m)})`); r.total += m; pagos.set(id || '', r);
    };
    ords.filter((o) => num(o.costo) > 0).forEach((o) => {
      const d = db.cartera.find((x) => x.ordenId === o.id);
      const pag = Math.min(num(o.costo), num(o.abono) + (d ? pagadoAl(d, f) : 0));
      sumarPago(o.clienteId, [o.marca, o.modelo].filter(Boolean).join(' ') || o.equipo || o.numero, pag);
    });
    movs.filter((m) => m.origen === 'manual' && m.tipo !== 'gasto').forEach((m) => sumarPago(m.clienteId, m.concepto || 'Venta', num(m.monto)));
    const gas = movs.filter((m) => m.tipo === 'gasto').reduce((t, m) => t + num(m.monto), 0);
    // quedaron debiendo: deudas de los trabajos de ese día con lo pendiente al final de ese día
    const g = new Map();
    db.cartera.filter((d) => esperaCierre(d) && d.fecha === f && saldoAl(d, f) > 0).forEach((d) => {
      const r = g.get(d.clienteId) || { clienteId: d.clienteId, deudas: [], debe: 0 };
      r.deudas.push(d); r.debe += saldoAl(d, f); g.set(d.clienteId, r);
    });
    const deudores = [...g.values()].sort((a, b) => b.debe - a.debe);
    const listaPagos = [...pagos.values()].sort((a, b) => b.total - a.total);
    const pagaron = listaPagos.reduce((t, r) => t + r.total, 0) - gas;
    const debiendo = deudores.reduce((t, r) => t + r.debe, 0);
    return { pagaron, debiendo, total: pagaron + debiendo, gastos: gas, pagos: listaPagos, deudores, sinPrecio: ords.filter((o) => !num(o.costo)).length, trabajos: ords.length };
  }
  // ¿este cobro es de un trabajo de ese mismo día? (los pagos de deudas de días anteriores no cuentan como "Pagaron" del día)
  const cobroDelDia = (m, f) => {
    if (m.ordenId) { const o = db.ordenes.find((x) => x.id === m.ordenId); return !o || o.fecha === f; }
    if (Array.isArray(m.deudaFechas) && m.deudaFechas.length) return m.deudaFechas.every((x) => x === f);
    if (m.origen !== 'abono') return true;
    // abonos anteriores sin ese dato: es del día si ese cliente tenía una deuda de ese día que recibió abono esa fecha
    return db.cartera.some((d) => d.clienteId === m.clienteId && d.fecha === f && (d.abonos || []).some((x) => x.fecha === m.fecha));
  };

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
    logoData || (logoData = fetch('assets/logo-212.jpg').then((r) => r.blob()).then((b) => new Promise((res) => {
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
    doc.setFont('helvetica', 'bold').setFontSize(16).text(cfg.negocio || '212 V.I.P', 42, 18);
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
      doc.setFontSize(8).setTextColor(120).text(`Generado por 212 V.I.P · ${fmtDate(today())} ${hora12(new Date().toTimeString().slice(0, 5))} · Página ${i} de ${n}`, 105, h - 8, { align: 'center' });
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
    let y = await pdfHeader(doc, 'CIERRE DEL DÍA', `${fmtDate(c.fecha)} · ${hora12(c.hora)}`);
    const nd = numerosDelDia(c.fecha); // los mismos números del Cierre diario y del historial
    y = tabla(doc, y, ['Pagaron', 'Quedaron debiendo', 'Total del día', 'Trabajos del día'],
      [[money(nd.pagaron), money(nd.debiendo), money(nd.total), String(nd.trabajos)]],
      { styles: { fontSize: 11, halign: 'center', fontStyle: 'bold' } });
    y = subtitulo(doc, y, `Pagaron (${money(nd.pagaron)})`);
    y = tabla(doc, y, ['Cliente', 'Equipos / modelos', 'Pagó'],
      nd.pagos.length ? nd.pagos.map((r) => [clienteNombre(r.clienteId) || '(sin cliente)', r.eq.join(', '), money(r.total)]) : [['Nadie pagó', '', '']],
      { columnStyles: { 2: { halign: 'right', fontStyle: 'bold' } },
        foot: nd.gastos ? [['', 'Gastos del día', '-' + money(nd.gastos)]] : undefined, footStyles: { fillColor: [235, 235, 235], textColor: 0, halign: 'right' } });
    const ords = db.ordenes.filter((o) => o.fecha === c.fecha).sort((a, b) => (Number(a.factura) || 0) - (Number(b.factura) || 0));
    if (ords.length) {
      y = subtitulo(doc, y, 'Órdenes de ingreso del día');
      y = tabla(doc, y, ['Factura', 'Cliente', 'Equipo', 'Falla', 'Precio', 'Debe'],
        ords.map((o) => {
          const d = db.cartera.find((x) => x.ordenId === o.id);
          const debe = num(o.costo) ? Math.max(0, num(o.costo) - num(o.abono) - (d ? pagadoAl(d, c.fecha) : 0)) : 0;
          return [o.factura != null ? 'N°' + o.factura : o.numero, clienteNombre(o.clienteId), [o.marca, o.modelo].filter(Boolean).join(' ') || o.equipo, o.falla || '', num(o.costo) ? money(o.costo) : 'Sin precio', debe ? money(debe) : ''];
        }),
        { columnStyles: { 4: { halign: 'right' }, 5: { halign: 'right', textColor: [200, 0, 0] } } });
    }
    y = subtitulo(doc, y, `Quedaron debiendo (${money(nd.debiendo)})`);
    tabla(doc, y, ['Cliente', 'Equipos / modelos', 'Debe'],
      nd.deudores.length ? nd.deudores.map((g) => [clienteNombre(g.clienteId) || '(sin cliente)', resumenModelos(g.deudas), money(g.debe)]) : [['Nadie quedó debiendo', '', '']],
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
    const nd = numerosDelDia(c.fecha);
    return [
      `🔒 *Cierre del día ${fmtDate(c.fecha)}* (${hora12(c.hora)}) — ${db.config.negocio}`,
      `💵 Pagaron: ${money(nd.pagaron)}`,
      `⏳ Quedaron debiendo: ${money(nd.debiendo)}${nd.deudores.length ? ' — ' + nd.deudores.map((g) => `${clienteNombre(g.clienteId)} (${resumenModelos(g.deudas)})`).join('; ') : ''}`,
      `🧾 *Total del día: ${money(nd.total)}*`,
      `📱 Trabajos del día: ${nd.trabajos}`,
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
    // solo se envían los 2 PDF, sin mensaje de texto
    if (navigator.canShare && navigator.canShare({ files })) {
      // Android / Windows: menú de compartir con los PDF adjuntos → WhatsApp → encargado
      try {
        await navigator.share({ files });
        marcarEnviado(c.fecha);
        toast('Cierre enviado ✅');
      } catch (err) {
        if (err.name !== 'AbortError') toast('No se pudo compartir: ' + err.message);
      }
    } else {
      // sin compartir archivos: se abre directo el chat del encargado con el resumen y se descargan los PDF
      window.open(waDigits(encargado()) ? 'https://wa.me/' + waDigits(encargado()) : 'https://wa.me/', '_blank', 'noopener');
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
      ${head('CIERRE DIARIO', 'h-red', `<input type="date" id="rd-fecha" class="btn ghost" value="${today()}"><button class="btn yellow big" id="rd-cierre">🔒 CIERRE DEL DÍA</button><button class="btn green" id="rd-xls">⬇ Excel del día</button><button class="btn" id="rd-xls-all">⬇ Excel completo</button>`)}
      <div id="rd-cierre-estado"></div>
      <div class="stats-row" id="rd-stats"></div>
      <p class="rd-antes" id="rd-antes" hidden></p>
      <div class="card" id="rd-card-pago" hidden>
        <h2 class="neon-tit">Pagaron <small style="font-family:var(--font-body);font-size:15px;color:var(--muted)">(lo que pagaron por los trabajos del día)</small></h2>
        <div class="table-wrap"><table>
          <thead><tr><th>Cliente</th><th>Equipos / modelos</th><th class="num">Pagó</th></tr></thead>
          <tbody id="rd-pago"></tbody>
        </table></div>
      </div>
      <div class="card" id="rd-card-mora">
        <h2 class="neon-tit">Quedaron debiendo <small style="font-family:var(--font-body);font-size:15px;color:var(--muted)">(pasan a Cartera con el cierre)</small></h2>
        <div class="table-wrap"><table>
          <thead><tr><th>Cliente</th><th>Equipos / modelos</th><th class="num">Debe</th><th>Estado</th></tr></thead>
          <tbody id="rd-mora"></tbody>
        </table></div>
      </div>
      <div class="card">
        <h2>Historial de cierres <small style="font-family:var(--font-body);font-size:15px;color:var(--muted)">(PDF guardados en la plataforma)</small></h2>
        <div class="table-wrap"><table>
          <thead><tr><th>Fecha</th><th>Hora</th><th class="num">Pagaron</th><th class="num">Quedaron debiendo</th><th class="num">Total del día</th><th>Enviado</th><th></th></tr></thead>
          <tbody id="rd-hist"></tbody>
        </table></div>
        <div class="acum-cierres" id="rd-acum" hidden></div>
      </div>`;

    const fecha = () => $('#rd-fecha').value || today();
    let lista = 'mora'; // qué lista se ve abajo: 'mora' (quedaron debiendo, por defecto) o 'pago' (pagaron)
    const signed = (m) => (m.tipo === 'gasto' ? -num(m.monto) : num(m.monto));
    function render() {
      const f = fecha();
      if (repararDeudasDelDia(f)) save();
      const nd = numerosDelDia(f);

      const pend = pendientesDelDia(f);
      const cierre = cierreDe(f);
      $('#rd-mora').innerHTML = nd.deudores.length
        ? nd.deudores.map((g) => {
          const enCart = g.deudas.every(enCartera);
          return `<tr>
            <td><b>${esc(clienteNombre(g.clienteId) || '(sin cliente)')}</b></td>
            <td>${esc(resumenModelos(g.deudas))}</td>
            <td class="num"><span class="tag due">${money(g.debe)}</span></td>
            <td>${enCart ? '<span class="tag ok">✓ En cartera</span>' : '<span class="tag in">⏳ Pendiente del cierre</span>'}</td>
          </tr>`;
        }).join('')
        : `<tr><td colspan="4" class="empty">Nadie quedó debiendo ${f === today() ? 'hoy' : 'ese día'} 🎉</td></tr>`;

      // pagaron: por cliente, cada equipo del día con lo que pagó
      $('#rd-pago').innerHTML = nd.pagos.length
        ? nd.pagos.map((r) => `<tr>
            <td><b>${esc(clienteNombre(r.clienteId) || '(sin cliente)')}</b></td>
            <td>${esc(r.eq.join(', '))}</td>
            <td class="num"><span class="tag ok">${money(r.total)}</span></td>
          </tr>`).join('')
        : `<tr><td colspan="3" class="empty">Nadie ha pagado ${f === today() ? 'hoy' : 'ese día'} todavía</td></tr>`;
      $('#rd-card-pago').hidden = lista !== 'pago';
      $('#rd-card-mora').hidden = lista !== 'mora';

      $('#rd-stats').innerHTML = `
        <div class="stat yellow stat-lista ${lista === 'pago' ? 'activo' : ''}" data-lista="pago" title="Ver la lista de los que pagaron"><div class="label">💵 Pagaron</div><div class="value">${money(nd.pagaron)}</div></div>
        <div class="stat blue stat-lista ${lista === 'mora' ? 'activo' : ''}" data-lista="mora" title="Ver la lista de los que quedaron debiendo"><div class="label">⏳ Quedaron debiendo</div><div class="value">${money(nd.debiendo)}</div></div>
        <div class="stat red"><div class="label">🧾 Total del día</div><div class="value">${money(nd.total)}</div></div>`;
      // aviso de órdenes sin precio
      const avisos = [
        nd.sinPrecio ? `⚠ <b>${nd.sinPrecio}</b> ${nd.sinPrecio === 1 ? 'orden' : 'órdenes'} de ${f === today() ? 'hoy' : 'ese día'} sin precio: no se ${nd.sinPrecio === 1 ? 'suma' : 'suman'} hasta ponerle${nd.sinPrecio === 1 ? '' : 's'} precio` : '',
      ].filter(Boolean);
      $('#rd-antes').innerHTML = avisos.join('<br>');
      $('#rd-antes').hidden = !avisos.length;
      const hist = db.cierres.slice().sort((x, z) => z.fecha.localeCompare(x.fecha));
      // marcador: la suma de todos los cierres hechos (lo que se ha hecho en total)
      const acum = hist.reduce((t, c) => { const x = numerosDelDia(c.fecha); t.pag += x.pagaron; t.deb += x.debiendo; t.tot += x.total; return t; }, { pag: 0, deb: 0, tot: 0 });
      $('#rd-acum').hidden = !hist.length;
      $('#rd-acum').innerHTML = hist.length ? `
        <div class="acum-tit">🏆 TOTAL DE LOS CIERRES <small>${hist.length} ${hist.length === 1 ? 'día' : 'días'} · desde ${fmtDate(hist[hist.length - 1].fecha)}</small></div>
        <div class="acum-fila">
          <div><span>💵 Pagaron</span><b>${money(acum.pag)}</b></div>
          <div><span>⏳ Quedaron debiendo</span><b>${money(acum.deb)}</b></div>
        </div>
        <div class="acum-total"><span>TOTAL DE GANANCIAS</span><b>${money(acum.tot)}</b></div>` : '';
      $('#rd-hist').innerHTML = hist.length
        ? hist.map((c) => `<tr>
            <td><b>${fmtDate(c.fecha)}</b></td><td>${esc(hora12(c.hora))}</td>
            ${(() => { const x = numerosDelDia(c.fecha); return `<td class="num">${money(x.pagaron)}</td><td class="num">${money(x.debiendo)}</td><td class="num"><b>${money(x.total)}</b></td>`; })()}
            <td>${c.enviado ? '<span class="tag ok">✓ Enviado</span>' : '<span class="tag gray">No</span>'}</td>
            <td class="actions"><button class="btn sm green" data-cierre="${esc(c.fecha)}">📄 PDF / Enviar</button></td>
          </tr>`).join('')
        : '<tr><td colspan="7" class="empty">Todavía no hay cierres</td></tr>';
      // deudas de clientes que ya salieron en el cierre pero quedaron sin marcar (falla de sincronización ya corregida)
      if (cierre) {
        const yaCerrados = new Set(cierre.deudores.map((x) => x.clienteId));
        const sueltas = pend.filter((d) => !d.cerrado && yaCerrados.has(d.clienteId));
        if (sueltas.length) { sueltas.forEach((d) => { d.cerrado = f; }); save(); }
      }
      $('#rd-cierre-estado').innerHTML = ''; // el aviso "Día cerrado… En caja…" se quitó: mostraba otros valores
    }

    function abrirCierre() {
      const f = fecha();
      const rows = db.movimientos.filter((m) => m.fecha === f);
      const ing = rows.filter((m) => m.tipo !== 'gasto').reduce((s, m) => s + num(m.monto), 0);
      const gas = rows.filter((m) => m.tipo === 'gasto').reduce((s, m) => s + num(m.monto), 0);
      if (repararDeudasDelDia(f)) save();
      const nd = numerosDelDia(f); // los mismos números de los cuadros del Cierre diario
      const grupos = nd.deudores;
      const enMora = nd.debiendo;
      const trabajos = rows.filter((m) => m.origen === 'manual' && m.tipo !== 'gasto').reduce((s, m) => s + (num(m.cantidad) || 1), 0) + db.ordenes.filter((o) => o.fecha === f).length;
      const { el: m, close } = openModal(`
        <div class="cierre-box">
          <div class="modal-actions"><button class="btn" data-act="close">Cancelar</button></div>
          <h2 class="scan-title">🔒 CIERRE DEL DÍA ${fmtDate(f)}</h2>
          <div class="stats-row">
            <div class="stat yellow"><div class="label">💵 Pagaron</div><div class="value">${money(nd.pagaron)}</div></div>
            <div class="stat blue"><div class="label">⏳ Quedaron debiendo</div><div class="value">${money(nd.debiendo)}</div></div>
            <div class="stat red"><div class="label">🧾 Total del día</div><div class="value">${money(nd.total)}</div></div>
            <div class="stat green"><div class="label">Trabajos del día</div><div class="value">${trabajos}</div></div>
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
        // se buscan de nuevo: la sincronización cada 10 s pudo cambiar los datos mientras la ventana estaba abierta
        pendientesDelDia(f).forEach((d) => { if (!d.cerrado) d.cerrado = f; });
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
        pagaron: nd.pagaron, debiendo: nd.debiendo, totalDia: nd.total,
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

    $('#rd-fecha').addEventListener('change', render);
    // tocar "Pagaron" o "Quedaron debiendo" cambia la lista de abajo
    $('#rd-stats').addEventListener('click', (e) => {
      const st = e.target.closest('[data-lista]');
      if (!st || st.dataset.lista === lista) return;
      lista = st.dataset.lista;
      render();
    });
    $('#rd-cierre').addEventListener('click', abrirCierre);
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
      exportXLSX(`Reporte_Completo_212VIP_${today()}.xlsx`, {
        Movimientos: toRows(all),
        'Total por día': Object.entries(porDia).map(([f, t]) => ({ Fecha: fmtDate(f), Total: t })),
        Cierres: db.cierres.slice().sort((a, b) => a.fecha.localeCompare(b.fecha)).map((c) => { const x = numerosDelDia(c.fecha); return { Fecha: fmtDate(c.fecha), Hora: hora12(c.hora), Pagaron: x.pagaron, 'Quedaron debiendo': x.debiendo, 'Total del día': x.total, Clientes: x.deudores.map((g) => `${clienteNombre(g.clienteId)} (${resumenModelos(g.deudas)})`).join('; ') }; }),
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
  const ESTADOS = ['Recibido', 'Entregado']; // Recibido = en el taller · Entregado = ya se lo llevó
  const FALLAS = ['FRP', 'KG', 'PAY', 'Software', 'Cuenta Mi'];
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
    const n = Math.max(db.seq.factura || 0, mayor, 1); // la primera es 001
    db.seq.factura = n + 1;
    return String(n).padStart(3, '0');
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
  logoImg.src = 'assets/logo-212.jpg';
  const COLORES = {
    azul: ['#1e9bff', '#0b6fd8', '#fff'], rosa: ['#ff2fa8', '#c8137e', '#fff'], amarillo: ['#ffd500', '#f5b700', '#000'],
    verde: ['#22c55e', '#15803d', '#fff'], morado: ['#8b5cf6', '#6d28d9', '#fff'], naranja: ['#ff7a1a', '#ea580c', '#fff'],
    cian: ['#22d3ee', '#0891b2', '#000'], turquesa: ['#2dd4bf', '#0f766e', '#000'], lima: ['#a3e635', '#65a30d', '#000'], ambar: ['#fbbf24', '#d97706', '#000'],
  };
  async function tarjetaImagen({ nombre, aviso, filas, acento = '#ff2fa8', acento2 = '#1e9bff', avisoColor = ['#4ade80', '#22c55e'] }) {
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
      const cabe = (t) => ctx.measureText(t).width <= maxW;
      // "\n" fuerza un renglón nuevo (un equipo por renglón)
      String(txt).split('\n').forEach((parr) => {
        let cur = '';
        // un equipo que no cabe solo en la línea se corta antes del precio "(…)" y, si aún no cabe, en sus espacios
        const trozos = parr.split(' ').flatMap((w) => (cabe(w) ? [w] : w.split(/\u00a0(?=\()/).flatMap((x) => (cabe(x) ? [x] : x.split('\u00a0')))));
        trozos.forEach((w) => {
          const t = cur ? cur + ' ' + w : w;
          if (!cabe(t) && cur) { out.push(cur); cur = w; } else cur = t;
        });
        if (cur) out.push(cur);
      });
      return out;
    };
    const filasMed = filas.map((f) => {
      // se muestran todos los renglones (antes se cortaba en 4 y se perdían equipos)
      const parrafos = String(f.valor).split('\n').length;
      let size = 54, ls = lineas(f.valor, RW - LW - 80, size);
      while (ls.length > parrafos && size > 38) { size -= 4; ls = lineas(f.valor, RW - LW - 80, size); }
      return { ...f, size, ls, h: Math.max(104, ls.length * size * 1.15 + 40) };
    });
    const top = 520 + (aviso ? 90 : 0);
    const H = top + filasMed.reduce((t, f) => t + f.h + 22, 0) + 230;
    cv.width = W; cv.height = H;
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
    // franjas de las esquinas
    const franja = (x1, y1, x2, y2, c) => { ctx.strokeStyle = c; ctx.lineWidth = 34; ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke(); };
    franja(-40, H - 200, 160, H + 20, acento); franja(-40, H - 110, 90, H + 20, acento2);
    franja(W + 40, H - 200, W - 160, H + 20, acento); franja(W + 40, H - 110, W - 90, H + 20, acento2);
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
    partes(495 - 40, [['Hola, ', '#fff'], [`${nombre || 'cliente'}`, acento], ['.', '#fff']], 76, '400');
    partes(495 + 20, [['Le saluda ', '#fff'], ['212 V.I.P', acento], [' Servicio Técnico.', '#fff']], 44, '700');
    if (aviso) {
      ctx.font = `400 54px Anton, Impact, sans-serif`; ctx.fillStyle = avisoColor[0]; ctx.textAlign = 'center';
      ctx.shadowColor = avisoColor[1]; ctx.shadowBlur = 18; ctx.fillText(aviso, W / 2, 495 + 105); ctx.shadowBlur = 0; ctx.textAlign = 'left';
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
    const t1 = '212 V.I.P', t2 = ' Servicio Técnico.';
    const w1 = ctx.measureText(t1).width; ctx.font = `italic 700 46px ${BODY}`; const w2 = ctx.measureText(t2).width;
    let px = W / 2 - (w1 + w2) / 2; ctx.textAlign = 'left';
    ctx.font = `400 50px Anton, Impact, sans-serif`; ctx.fillStyle = acento; ctx.fillText(t1, px, y + 140);
    ctx.font = `italic 700 46px ${BODY}`; ctx.fillStyle = '#fff'; ctx.fillText(t2, px + w1, y + 140);
    ctx.fillStyle = acento; ctx.fillRect(px - 90, y + 124, 64, 8); ctx.fillRect(px + w1 + w2 + 26, y + 124, 64, 8);
    return new Promise((r) => cv.toBlob(r, 'image/png'));
  }
  // aviso al cliente de su orden: sencillo, en tonos celeste / verde, solo lo necesario
  const tarjetaOrden = (o) => {
    const c = clienteById(o.clienteId) || {};
    const s = saldoOrden(o);
    const avisos = {
      Recibido: ['📥 RECIBIMOS SU EQUIPO', ['#22d3ee', '#0891b2']],
      'En reparación': ['🔧 SU EQUIPO ESTÁ EN REPARACIÓN', ['#fbbf24', '#d97706']],
      Listo: ['✅ ¡SU EQUIPO ESTÁ LISTO!', ['#a3e635', '#65a30d']],
      Entregado: ['📦 EQUIPO ENTREGADO', ['#2dd4bf', '#0f766e']],
    };
    const [aviso, avisoColor] = avisos[o.estado] || avisos.Recibido;
    const filas = [
      { icono: '📄', etiqueta: 'Factura:', valor: o.factura != null ? `N°${o.factura}` : o.numero, color: 'cian' },
      { icono: '📱', etiqueta: 'Equipo:', valor: ([o.marca, o.modelo].filter(Boolean).join(' ') || o.equipo || '-') + (o.binario ? ` · Bit ${o.binario}` : ''), color: 'turquesa' },
      { icono: '🔧', etiqueta: 'Falla:', valor: o.falla || '-', color: 'cian' },
      { icono: '💵', etiqueta: 'Precio:', valor: num(o.costo) ? money(o.costo) : 'Por definir', color: 'turquesa' },
    ];
    if (o.estado === 'Listo' || o.estado === 'Entregado') {
      filas.push(s > 0 ? { icono: '👛', etiqueta: 'A pagar:', valor: money(s), color: 'ambar' } : { icono: '✅', etiqueta: 'Pago:', valor: 'Completo', color: 'lima' });
    }
    return tarjetaImagen({ nombre: c.nombre, aviso, avisoColor, acento: '#22d3ee', acento2: '#a3e635', filas });
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
    const fact = o.factura != null ? `N°${o.factura}` : o.numero;
    const caption = `Factura ${fact} · ${db.config.negocio}`;
    return compartirImagen(blob, `212VIP_factura_${o.factura != null ? o.factura : o.numero}.png`, caption, c.whatsapp);
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
      o.binario && 'Binario: ' + o.binario, // el bit que se leyó del equipo
      o.memoria && 'Tipo de memoria: ' + o.memoria,
    ].filter(Boolean);
    while (lineas.length < 6) lineas.push('');
    const entregado = (o.historial || []).filter((x) => x.estado === 'Entregado').pop();
    const [ey, em, ed] = entregado ? entregado.fecha.slice(0, 10).split('-') : ['', '', ''];
    const sino = (t) => `<div class="f-sn"><span>${t}</span><span>SI <i></i></span><span>NO <i></i></span></div>`;
    return `<div class="receipt fact">
      <div class="f-head">
        <div class="f-title">SERVICIO TÉCNICO<br>DE CELULARES</div>
        <img class="f-logo" src="assets/logo-212.jpg" alt="">
        <div class="f-contact">
          ${cfg.telefono ? `<div><b class="wa">✆</b> ${esc(cfg.telefono)}</div>` : ''}
          ${cfg.direccion ? `<div><b class="pin">⦿</b> ${esc(cfg.direccion)}</div>` : ''}
        </div>
        <div class="f-box">
          <div class="f-brand">212 V.I.P</div>
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
          <div style="flex:1.3">${esc(modeloVer(o))}</div>
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
    const { el: m } = openModal(`
      <div class="modal-actions">
        <button class="btn primary" data-act="print">🖨 Imprimir / PDF</button>
        <button class="btn yellow" data-act="label">🏷 Etiqueta QR</button>
        <button class="btn green" data-act="wa" disabled>⏳ Preparando…</button>
        <button class="btn" data-act="close">Cerrar</button>
      </div>
      ${receiptHTML(o)}`,
    (e, a) => {
      if (!a) return;
      if (a.dataset.act === 'wa') {
        if (!blob) return;
        const fact = o.factura != null ? `N°${o.factura}` : o.numero;
        compartirImagen(blob, `212VIP_orden_${o.factura != null ? o.factura : o.numero}.png`, `Orden de servicio ${fact} · ${db.config.negocio}`, c.whatsapp);
      }
      if (a.dataset.act === 'print') printWithPage('@page { size: auto; margin: 12mm; }');
      if (a.dataset.act === 'label') openLabel(o);
    });
    // la imagen se prepara al abrir, así el toque de enviar abre WhatsApp de inmediato
    let blob = null;
    imagenComprobante(o)
      .then((b) => {
        blob = b;
        const btn = $('[data-act=wa]', m);
        if (btn) { btn.disabled = false; btn.textContent = '💬 Enviar por WhatsApp'; }
      })
      .catch(() => { const btn = $('[data-act=wa]', m); if (btn) btn.textContent = 'No se pudo preparar la imagen'; });
  }

  // la orden de servicio tal cual se ve (estilo factura) convertida en imagen
  let h2cPromise;
  const loadH2C = () =>
    h2cPromise || (h2cPromise = new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = 'vendor/html2canvas.min.js';
      s.onload = () => res(window.html2canvas);
      s.onerror = () => { h2cPromise = null; rej(new Error('html2canvas')); };
      document.head.appendChild(s);
    }));
  async function imagenComprobante(o) {
    const h2c = await loadH2C();
    const box = document.createElement('div');
    box.style.cssText = 'position:fixed;left:-12000px;top:0;width:860px;background:#fff;padding:18px';
    box.innerHTML = receiptHTML(o);
    document.body.appendChild(box);
    try {
      await Promise.all(Array.from(box.querySelectorAll('img')).map((i) => (i.complete ? 0 : new Promise((r) => { i.onload = i.onerror = r; }))));
      // windowWidth grande: se dibuja con el diseño de PC aunque sea desde el celular
      const cv = await h2c(box, { scale: 2, backgroundColor: '#ffffff', windowWidth: 1300, logging: false });
      return await new Promise((r) => cv.toBlob(r, 'image/png'));
    } finally {
      box.remove();
    }
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
            ${o.estado !== 'Entregado' && s > 0 ? `<button class="btn yellow big" data-act="cobrar">📦 COBRAR ${money(s)} Y ENTREGAR</button><button class="btn" data-act="entregar">Entregar sin cobrar (queda en cartera)</button>` : ''}
            ${o.estado !== 'Entregado' && s <= 0 ? '<button class="btn yellow big" data-act="entregar">📦 MARCAR ENTREGADO</button>' : ''}
            <button class="btn green" data-act="avisar">🖼 Enviar por WhatsApp</button>
            <button class="btn" data-act="ver">Ver orden</button>
            <button class="btn primary" data-act="otro">📷 Escanear otro</button>
          </div>
        </div>`;
    }

    function handleAction(a) {
      const o = currentOrder();
      if (!o && a.dataset.act !== 'otro') return;
      switch (a.dataset.act) {
        case 'avisar': enviarImagenOrden(o); break;
        case 'cobrar': {
          const s = saldoOrden(o);
          const d = db.cartera.find((x) => x.ordenId === o.id);
          if (d) d.abonos.push({ fecha: today(), monto: s });
          db.movimientos.push({ id: uid(), origen: 'abono', ordenId: o.id, fecha: today(), tipo: 'ingreso', concepto: `Pago al entregar ${o.numero}`, clienteId: o.clienteId, monto: s });
          setEstado(o, 'Entregado');
          toast(`Cobrado ${money(s)} y entregado`);
          showResult(`📦 Entregado y cobrado ${money(s)} (sumado al cierre diario)`);
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
      ${head('INGRESO Y ORDEN DE SERVICIO', 'h-blue', `<button class="btn primary big" id="or-scan">📷 ESCANEAR</button>`)}
      <form class="card" id="or-form" novalidate>
        <div class="paso-top">
          <h2>Plantilla de servicio técnico</h2>
          <div class="paso-dots" id="or-dots">${[1, 2, 3, 4].map((n) => `<span data-dot="${n}">${n}</span>`).join('')}</div>
        </div>
        <div class="paso-resumen" id="or-resumen" hidden></div>

        <div class="paso" data-paso="1">
          <h3 class="paso-t">👤 ¿De quién es el equipo?</h3>
          <div class="form-grid">
            <div class="field full"><label for="or-buscar">Cliente</label>
              <input id="or-buscar" placeholder="🔎 Escriba el nombre para buscar…" autocomplete="off">
              <div class="cli-sug" id="or-sug"></div>
              <select id="or-cli" hidden>${clienteOptions('', '— Cliente nuevo —')}</select>
            </div>
            <div class="field nuevo full"><label for="or-nom">Nombre del cliente nuevo</label><input id="or-nom" placeholder="Nombre"></div>
            <div class="field nuevo"><label for="or-tie">Tienda</label><input id="or-tie" placeholder="Opcional"></div>
            <div class="field nuevo"><label for="or-wa">WhatsApp</label><input id="or-wa" type="tel" placeholder="Opcional"></div>
          </div>
        </div>

        <div class="paso" data-paso="2" hidden>
          <h3 class="paso-t">📱 ¿Qué equipo es?</h3>
          <div class="form-grid">
            <div class="field"><label for="or-eq">Equipo</label><select id="or-eq"><option>Celular</option><option>Tablet</option><option>Laptop</option><option>PC</option><option>Otro</option></select></div>
            <div class="field full"><label>Marca (toque una)</label>
              <div class="chips" id="or-marcas">${MARCAS.map((m) => `<button type="button" class="chip big" data-marca="${m}">${m}</button>`).join('')}<button type="button" class="chip big" data-marca="">Otra…</button></div>
              <input id="or-marca-otra" placeholder="Escriba la marca" hidden>
            </div>
          </div>
        </div>

        <div class="paso" data-paso="3" hidden>
          <h3 class="paso-t">🔧 Modelo y falla</h3>
          <div class="form-grid">
            <div class="field full"><label for="or-modelo">Modelo</label><input id="or-modelo" list="or-modelos" placeholder="Toque para ver la lista o escriba"><datalist id="or-modelos"></datalist></div>
            <div class="field full"><label>Falla (toque una o varias)</label>
              <div class="chips" id="or-fallas">${FALLAS.map((f) => `<button type="button" class="chip big" data-falla="${f}">${f}</button>`).join('')}<button type="button" class="chip big" data-falla="otra">Otra…</button></div>
              <input id="or-falla-otra" placeholder="Describa la falla" hidden>
            </div>
          </div>
        </div>

        <div class="paso" data-paso="4" hidden>
          <h3 class="paso-t">💵 Precio</h3>
          <div class="form-grid">
            <div class="field"><label for="or-costo">Costo</label><input id="or-costo" type="number" step="0.01" min="0" value="0"></div>
            <div class="field"><label for="or-abono">Abono</label><input id="or-abono" type="number" step="0.01" min="0" value="0"></div>
            <div class="field full"><label for="or-trab">Nota (opcional)</label><input id="or-trab" placeholder="Algo que quiera recordar del equipo"></div>
          </div>
        </div>

        <div class="form-actions paso-nav">
          <button class="btn" type="button" id="or-atras" hidden>← Atrás</button>
          <button class="btn primary big" type="button" id="or-sig">SIGUIENTE →</button>
          <button class="btn big btn-rgb" type="button" id="or-leer" title="Leer marca, modelo y binario del teléfono por cable USB">🔌 LEER EQUIPO</button>
          <span class="or-leido" id="or-leido" hidden></span>
          <input type="hidden" id="or-bin"><input type="hidden" id="or-mem"><input type="hidden" id="or-huella">
          <button class="btn primary big" type="submit" id="or-guardar" hidden>GUARDAR E IMPRIMIR</button>
        </div>
      </form>
      <div class="toolbar">
        <label class="or-dia" title="Día que se muestra en la lista">📅 <input type="date" id="or-fecha" value="${today()}"><button type="button" class="btn sm" id="or-hoy">Hoy</button></label>
        <div class="search"><input id="or-q" placeholder="Buscar por número, cliente, marca o modelo…"></div>
        <div class="seg" id="or-filtro"><button class="on" data-f="taller">En taller</button><button data-f="Entregado">Entregados</button></div>
      </div>
      <div class="table-wrap"><table>
        <thead><tr><th>Orden</th><th>Fecha</th><th>Cliente</th><th>Equipo</th><th>Falla</th><th>Estado</th><th class="num">Saldo</th><th></th></tr></thead>
        <tbody id="or-body"></tbody>
      </table></div>
      <button type="button" class="tot-dia" id="or-totbox"></button>`;

    let modoNuevo = false; // los datos del cliente nuevo solo aparecen al elegir "Cliente nuevo"
    const toggleNuevo = () => $$('.field.nuevo', el).forEach((f) => (f.hidden = !modoNuevo || !!$('#or-cli').value));
    $('#or-cli').addEventListener('change', toggleNuevo);
    toggleNuevo();

    let filtro = 'taller';
    // En taller = todo lo que no se ha entregado (recibido, en reparación o listo)
    const pasaFiltro = (o) => (filtro === 'taller' ? o.estado !== 'Entregado' : o.estado === filtro);
    // la lista muestra solo el día que se está operando (o el que se elija arriba):
    // las órdenes recibidas ese día y las que se entregaron ese día
    const diaSel = () => $('#or-fecha').value || today();
    const delDia = (o, f) => o.fecha === f || (o.historial || []).some((x) => x.estado === 'Entregado' && fechaLocal(x.fecha) === f);
    const fechaLocal = (iso) => { const d = new Date(iso); return isNaN(d) ? String(iso || '').slice(0, 10) : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
    function render() {
      $('#or-totbox').innerHTML = `
        <span class="td-tit">📊 RESUMEN DEL DÍA</span>
        <span class="td-ver">Ver detalles ›</span>`;
      const q = $('#or-q').value.toLowerCase();
      const f = diaSel();
      $('#or-hoy').hidden = f === today();
      const rows = db.ordenes
        .filter((o) => (q ? true : pasaFiltro(o) && delDia(o, f)))
        .filter((o) => !q || [o.numero, o.factura != null ? 'N°' + o.factura : '', clienteNombre(o.clienteId), o.marca, o.modelo, o.imei, o.falla].join(' ').toLowerCase().includes(q))
        .slice().sort((a, b) => (Number(a.factura) || 0) - (Number(b.factura) || 0));
      const cuenta = (t) => db.ordenes.filter((o) => delDia(o, f) && (t === 'taller' ? o.estado !== 'Entregado' : o.estado === t)).length;
      $$('#or-filtro button', el).forEach((b) => (b.textContent = b.textContent.replace(/ \(\d+\)$/, '') + ` (${cuenta(b.dataset.f)})`));
      $('#or-body').innerHTML = rows.length
        ? rows.map((o) => {
          const s = saldoOrden(o);
          return `<tr>
            <td><b class="fact-n">${o.factura != null ? 'N°' + esc(o.factura) : '—'}</b></td>
            <td>${fmtDate(o.fecha)}</td>
            <td>${esc(clienteNombre(o.clienteId))}</td>
            <td>${esc([o.equipo, o.marca, modeloVer(o)].filter(Boolean).join(' '))}${o.binario ? ` <small class="bit-tag">Bit ${esc(o.binario)}</small>` : ''}${o.huella && visitasDe(o.huella, o.id).some((x) => x.fecha < o.fecha || (x.fecha === o.fecha && (Number(x.factura) || 0) < (Number(o.factura) || 0))) ? ` <small class="bit-tag ya" title="Este mismo equipo ya había venido antes">🔁 Ya vino</small>` : ''}</td>
            <td>${selFalla(o)}</td>
            <td><select data-estado="${o.id}" class="btn sm" style="background:#000">${ESTADOS.map((e) => `<option ${e === (o.estado === 'Entregado' ? 'Entregado' : 'Recibido') ? 'selected' : ''}>${e}</option>`).join('')}</select></td>
            <td class="num">${s > 0 ? `<span class="tag due">${money(s)}</span>` : !num(o.costo) ? '<span class="tag gray">SIN PRECIO</span>' : '<span class="tag ok">PAGADO</span>'}</td>
            <td class="actions">${s > 0 || !num(o.costo) ? `<button class="btn sm green" data-pagar="${o.id}" title="Registrar un pago (entra al cierre diario)">💵 Pagar</button>` : ''}<button class="btn sm" data-editar="${o.id}" title="Corregir datos o poner el precio">✏ Editar</button><button class="btn sm" data-img="${o.id}" title="Enviar la orden en imagen por WhatsApp">🖼 Enviar</button><button class="btn sm" data-ver="${o.id}">Ver / Imprimir</button><button class="btn sm red" data-del="${o.id}">Borrar</button></td>
          </tr>`;
        }).join('')
        : `<tr><td colspan="8" class="empty">${db.ordenes.length ? `No hay órdenes ${filtro === 'taller' ? 'en taller' : 'entregadas'} del ${fmtDate(f)}` : 'Aún no hay órdenes de ingreso'}</td></tr>`;
    }
    refreshOrdenList = render;

    // falla de cada orden: se elige con un clic (FRP, KG o PAY)
    const FALLAS_RAPIDAS = ['FRP', 'KG', 'PAY'];
    function selFalla(o) {
      const actual = (o.falla || '').trim();
      const igual = FALLAS_RAPIDAS.find((f) => f.toLowerCase() === actual.replace(/^pay\s*joy$/i, 'PAY').toLowerCase());
      const ops = [`<option value="" ${actual ? '' : 'selected'}>— Elegir —</option>`]
        .concat(actual && !igual ? [`<option selected>${esc(actual)}</option>`] : [])
        .concat(FALLAS_RAPIDAS.map((f) => `<option ${f === igual ? 'selected' : ''}>${f}</option>`));
      return `<select data-falla="${o.id}" class="btn sm sel-falla">${ops.join('')}</select>`;
    }

    // total del día: lo que entró a caja ese día (pagos y abonos) y los equipos recibidos
    function totalDelDia(f = today()) {
      const pintar = (m, f) => {
        const ords = db.ordenes.filter((o) => o.fecha === f).sort((a, b) => (Number(a.factura) || 0) - (Number(b.factura) || 0));
        if (repararDeudasDelDia(f)) save();
        const nd = numerosDelDia(f); // los mismos números del Cierre diario
        const cobrado = nd.pagaron;
        const facturado = ords.reduce((t, o) => t + num(o.costo), 0);
        const debe = nd.debiendo;
        const cuenta = (re) => ords.filter((o) => re.test(o.falla || '')).length;
        m.querySelector('#td-cuerpo').innerHTML = `
          <div class="stats-row">
            <div class="stat green"><div class="label">Total cobrado del día</div><div class="value">${money(cobrado)}</div></div>
            <div class="stat yellow"><div class="label">Total de trabajos</div><div class="value">${money(facturado)}</div></div>
            <div class="stat red"><div class="label">Quedaron debiendo</div><div class="value">${money(debe)}</div></div>
            <div class="stat blue"><div class="label">Equipos recibidos</div><div class="value">${ords.length}</div></div>
          </div>
          <div class="fallas-row td-fallas">
            ${[['FRP', /\bFRP\b/i], ['KG', /\bKG\b/i], ['PAY', /\bPAY\s*JOY\b|\bPAY\b/i]].map(([k, re]) => `<div class="falla-box"><div class="falla-k">${k}</div><div class="falla-n">${cuenta(re)}</div></div>`).join('')}
          </div>
          <div class="table-wrap"><table>
            <thead><tr><th>Orden</th><th>Cliente</th><th>Equipo</th><th>Falla</th><th class="num">Precio</th><th class="num">Debe</th></tr></thead>
            <tbody>${ords.length ? ords.map((o) => `<tr>
              <td><b class="fact-n">N°${esc(o.factura)}</b></td><td>${esc(clienteNombre(o.clienteId))}</td>
              <td>${esc([o.marca, o.modelo].filter(Boolean).join(' ') || o.equipo)}</td><td>${esc(o.falla || '—')}</td>
              <td class="num">${num(o.costo) ? money(o.costo) : '<span class="tag gray">SIN PRECIO</span>'}</td>
              <td class="num">${saldoOrden(o) > 0 ? `<span class="tag due">${money(saldoOrden(o))}</span>` : num(o.costo) ? '<span class="tag ok">PAGADO</span>' : ''}</td>
            </tr>`).join('') : `<tr><td colspan="6" class="empty">No se recibieron equipos el ${fmtDate(f)}</td></tr>`}</tbody>
          </table></div>
          <p class="modal-hint">"Total cobrado" es lo que pagaron ese día por los trabajos de ese día (lo mismo que "Pagaron" en el Cierre diario).</p>`;
      };
      const { el: m } = openModal(`
        <div class="card cierre-box">
          <div class="modal-actions"><input type="date" id="td-fecha" class="btn ghost" value="${f}"><button class="btn" data-act="close">Cerrar</button></div>
          <h2 class="scan-title neon-tit">📊 RESUMEN DEL DÍA</h2>
          <div id="td-cuerpo"></div>
        </div>`);
      m.querySelector('#td-fecha').addEventListener('change', (e) => pintar(m, e.target.value || today()));
      pintar(m, f);
    }

    // editar una orden ya ingresada (por ejemplo, ponerle el precio cuando se sepa)
    function editarOrden(id) {
      const o = db.ordenes.find((x) => x.id === id);
      if (!o) return;
      const pagado = num(o.abono) + abonosOrden(o);
      const { el: m, close } = openModal(`
        <form class="card cierre-box" id="ed-form">
          <h2>✏ Editar factura N°${esc(o.factura)}</h2>
          <div class="form-grid">
            <div class="field full"><label for="ed-cli">Cliente</label><select id="ed-cli">${clienteOptions(o.clienteId)}</select></div>
            <div class="field"><label for="ed-eq">Equipo</label><select id="ed-eq">${['Celular', 'Tablet', 'Laptop', 'PC', 'Otro'].map((e) => `<option ${e === o.equipo ? 'selected' : ''}>${e}</option>`).join('')}</select></div>
            <div class="field"><label for="ed-marca">Marca</label><input id="ed-marca" list="ed-marcas" value="${esc(o.marca || '')}"><datalist id="ed-marcas">${MARCAS.map((x) => `<option value="${x}">`).join('')}</datalist></div>
            <div class="field full"><label for="ed-modelo">Modelo</label><input id="ed-modelo" value="${esc(o.modelo || '')}"></div>
            <div class="field"><label for="ed-bin">Binario (bit)</label><input id="ed-bin" value="${esc(o.binario || '')}" placeholder="Solo Samsung"></div>
            <div class="field"><label for="ed-mem">Tipo de memoria</label><input id="ed-mem" value="${esc(o.memoria || '')}" placeholder="Ej: UFS Samsung"></div>
            <div class="field full"><label for="ed-falla">Falla</label><input id="ed-falla" value="${esc(o.falla || '')}" placeholder="FRP, KG, PAY…"></div>
            <div class="field full"><label for="ed-nota">Nota</label><input id="ed-nota" value="${esc(o.trabajo || '')}"></div>
            <div class="field"><label for="ed-costo">Precio / costo</label><input id="ed-costo" type="number" step="0.01" min="0" value="${num(o.costo) || ''}" placeholder="Sin precio"></div>
          </div>
          ${pagado > 0 ? `<p class="hint-line">Ya pagó ${money(pagado)}. Los pagos se anotan con el botón 💵 Pagar.</p>` : ''}
          <div class="modal-actions" style="margin-top:14px">
            <button type="submit" class="btn primary big">GUARDAR CAMBIOS</button>
            <button type="button" class="btn" data-act="close">Cancelar</button>
          </div>
        </form>`);
      setTimeout(() => (num(o.costo) ? m.querySelector('#ed-modelo') : m.querySelector('#ed-costo')).focus(), 50);
      m.querySelector('#ed-form').addEventListener('submit', (e) => {
        e.preventDefault();
        const x = db.ordenes.find((y) => y.id === id); // los datos pudieron cambiar al sincronizar
        if (!x) return close();
        const q = (sel) => m.querySelector(sel).value.trim();
        if (!q('#ed-falla')) { toast('Escriba la falla'); return; }
        Object.assign(x, {
          clienteId: q('#ed-cli') || x.clienteId, equipo: q('#ed-eq'), marca: q('#ed-marca'), modelo: q('#ed-modelo'), binario: q('#ed-bin'), memoria: q('#ed-mem'),
          falla: q('#ed-falla'), trabajo: q('#ed-nota'), costo: num(q('#ed-costo')),
        });
        // la deuda de esta orden en cartera queda igual al nuevo precio
        const base = Math.max(0, num(x.costo) - num(x.abono));
        const concepto = `Orden ${x.numero} - ${equipoTxt(x)}`;
        let d = db.cartera.find((y) => y.ordenId === x.id);
        if (d) Object.assign(d, { monto: base, clienteId: x.clienteId, concepto });
        else if (base > 0) db.cartera.push({ id: uid(), origen: 'orden', ordenId: x.id, clienteId: x.clienteId, concepto, monto: base, fecha: x.fecha, abonos: [] });
        db.movimientos.filter((y) => y.ordenId === x.id).forEach((y) => { y.clienteId = x.clienteId; });
        save();
        close();
        toast(`Factura N°${x.factura} actualizada`);
        render();
      });
    }

    // pago de una orden: baja su saldo, se anota en el reporte diario (entra a caja) y sale en el cierre del día
    function pagarOrden(id) {
      const o = db.ordenes.find((x) => x.id === id);
      if (!o) return;
      const modelo = [o.marca, o.modelo].filter(Boolean).join(' ') || o.equipo;
      const titulo = `${clienteNombre(o.clienteId)} · N°${o.factura} ${modelo}`;
      if (!num(o.costo)) {
        const p = prompt(`${titulo}\nEsta orden no tiene precio. ¿Cuánto cuesta el trabajo?`, '');
        if (p === null) return;
        const c = num(p);
        if (c <= 0) return;
        o.costo = c;
      }
      let d = db.cartera.find((x) => x.ordenId === o.id);
      const pendiente = Math.max(0, num(o.costo) - num(o.abono) - (d ? abonado(d) : 0));
      if (!d && pendiente > 0) {
        d = { id: uid(), origen: 'orden', ordenId: o.id, clienteId: o.clienteId, concepto: `Orden ${o.numero} - ${equipoTxt(o)}`, monto: num(o.costo) - num(o.abono), fecha: o.fecha || today(), abonos: [] };
        db.cartera.push(d);
      } else if (d) {
        d.monto = num(o.costo) - num(o.abono); // por si se le acaba de poner precio
      }
      const saldoAct = saldoOrden(o);
      if (saldoAct <= 0) { save(); toast('Esta orden ya está pagada'); render(); return; }
      const v = prompt(`${titulo}\nSaldo: ${money(saldoAct)}\n¿Cuánto pagó?`, saldoAct.toFixed(2));
      if (v === null) { save(); render(); return; }
      const m = Math.min(num(v), saldoAct);
      if (m <= 0) { save(); render(); return; }
      d.abonos.push({ fecha: today(), monto: m });
      db.movimientos.push({ id: uid(), origen: 'abono', ordenId: o.id, fecha: today(), tipo: 'ingreso', concepto: `Pago factura N°${o.factura} - ${modelo}`, clienteId: o.clienteId, monto: m });
      save();
      toast(m >= saldoAct ? `✅ Pagado completo ${money(m)} · sumado al reporte del día` : `Abono de ${money(m)} · queda ${money(saldoAct - m)}`);
      render();
    }
    $('#or-scan').addEventListener('click', () => openScanner());
    $('#or-totbox').addEventListener('click', () => totalDelDia(diaSel()));
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

    // ---- la plantilla va por pasos: cliente → equipo y marca → modelo y falla → precio
    let paso = 1;
    const marcaTxt = () => (marcaSel === '' ? $('#or-marca-otra').value.trim() : marcaSel || '');
    const fallaTxt = () => [...fallasSel].map((f) => (f === 'otra' ? $('#or-falla-otra').value.trim() : f)).filter(Boolean).join(', ');
    const clienteTxt = () => ($('#or-cli').value ? clienteNombre($('#or-cli').value) : modoNuevo ? $('#or-nom').value.trim() : '');
    // buscador de clientes: se escribe y salen los que coinciden; si no está, se crea nuevo
    const llaveCli = (t) => String(t || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    function sugerir() {
      const q = llaveCli($('#or-buscar').value.trim());
      if (!q) { $('#or-sug').innerHTML = ''; return; }
      const lista = db.clientes
        .filter((c) => llaveCli(`${c.nombre} ${c.tienda || ''} ${c.whatsapp || ''}`).includes(q))
        .sort((a, b) => (llaveCli(a.nombre).startsWith(q) ? 0 : 1) - (llaveCli(b.nombre).startsWith(q) ? 0 : 1) || a.nombre.localeCompare(b.nombre))
        .slice(0, 6);
      $('#or-sug').innerHTML = lista.map((c) => `<button type="button" class="cli-op" data-cli="${c.id}"><b>${esc(c.nombre)}</b>${c.tienda ? `<small>${esc(c.tienda)}</small>` : ''}</button>`).join('')
        + `<button type="button" class="cli-op nuevo-op" data-cli-nuevo>➕ Cliente nuevo: <b>${esc($('#or-buscar').value.trim())}</b></button>`;
    }
    function elegirCliente(id) {
      if (![...$('#or-cli').options].some((op) => op.value === id)) $('#or-cli').innerHTML = clienteOptions('', '— Cliente nuevo —');
      $('#or-cli').value = id;
      modoNuevo = false;
      $('#or-buscar').value = clienteNombre(id);
      $('#or-sug').innerHTML = '';
      toggleNuevo();
      irPaso(leido && marcaSel !== null ? 3 : 2);
    }
    function clienteNuevo() {
      $('#or-cli').value = '';
      modoNuevo = true;
      $('#or-nom').value = $('#or-buscar').value.trim();
      $('#or-sug').innerHTML = '';
      toggleNuevo();
      $('#or-tie').focus();
    }
    $('#or-buscar').addEventListener('input', () => {
      $('#or-cli').value = '';
      modoNuevo = false;
      toggleNuevo();
      sugerir();
    });
    $('#or-sug').addEventListener('click', (e) => {
      const c = e.target.closest('[data-cli]');
      if (c) elegirCliente(c.dataset.cli);
      if (e.target.closest('[data-cli-nuevo]')) clienteNuevo();
    });
    $('#or-buscar').addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      e.stopPropagation();
      const ops = $$('#or-sug [data-cli]', el);
      if (ops.length) elegirCliente(ops[0].dataset.cli); // Enter elige el primero de la lista
      else if ($('#or-buscar').value.trim()) clienteNuevo();
    });
    function validarPaso(n) {
      if (n === 1 && !clienteTxt()) { toast('Busque y toque el cliente, o elija "Cliente nuevo"'); $('#or-buscar').focus(); return false; }
      if (n === 2 && marcaSel === null) { toast('Toque la marca del equipo'); return false; }
      if (n === 2 && marcaSel === '' && !marcaTxt()) { toast('Escriba la marca'); $('#or-marca-otra').focus(); return false; }
      if (n === 3 && !fallaTxt()) { toast('Toque la falla del equipo'); return false; }
      return true;
    }
    function irPaso(n) {
      paso = n;
      $$('.paso', el).forEach((d) => (d.hidden = Number(d.dataset.paso) !== n));
      $$('#or-dots [data-dot]', el).forEach((d) => {
        d.classList.toggle('on', Number(d.dataset.dot) === n);
        d.classList.toggle('ok', Number(d.dataset.dot) < n);
      });
      $('#or-atras').hidden = n === 1;
      $('#or-sig').hidden = n === 4;
      $('#or-guardar').hidden = n !== 4;
      $('#or-leer').hidden = n === 4;
      const partes = [
        n > 1 && `👤 ${esc(clienteTxt())}`,
        n > 2 && `📱 ${esc([$('#or-eq').value !== 'Celular' ? $('#or-eq').value : '', marcaTxt()].filter(Boolean).join(' '))}`,
        n > 3 && `${esc($('#or-modelo').value.trim())}${$('#or-bin').value ? ' · Bit ' + esc($('#or-bin').value) : ''} · 🔧 ${esc(fallaTxt())}`,
      ].filter(Boolean);
      $('#or-resumen').hidden = !partes.length;
      $('#or-resumen').innerHTML = partes.map((p, i) => `<button type="button" class="chip" data-volver="${i + 1}" title="Cambiar">${p} ✎</button>`).join('');
      const foco = { 1: $('#or-cli').value ? null : modoNuevo ? '#or-nom' : '#or-buscar', 3: '#or-modelo', 4: '#or-costo' }[n];
      if (foco) setTimeout(() => $(foco).focus(), 50);
    }
    let leido = null; // datos leídos del teléfono con 🔌 LEER EQUIPO
    const siguiente = () => {
      if (!validarPaso(paso)) return;
      const n = paso === 1 && leido && marcaSel !== null ? 3 : paso + 1; // con el equipo leído, la marca ya está puesta
      irPaso(Math.min(4, n));
    };
    function aplicarLectura(r) {
      leido = r;
      $('#or-eq').value = 'Celular';
      const chip = $$('#or-marcas [data-marca]', el).find((b) => b.dataset.marca && b.dataset.marca === r.marca);
      marcaSel = chip ? r.marca : '';
      $$('#or-marcas .chip', el).forEach((x) => x.classList.toggle('on', chip ? x === chip : x.dataset.marca === ''));
      $('#or-marca-otra').hidden = !!chip;
      if (!chip) $('#or-marca-otra').value = r.marca || '';
      fillModelos();
      $('#or-modelo').value = r.modelo;
      $('#or-bin').value = r.bit || '';
      $('#or-mem').value = r.memoria || '';
      $('#or-huella').value = r.huella || '';
      $('#or-leido').hidden = false;
      const vs = visitasDe(r.huella);
      $('#or-leido').textContent = `✅ ${[r.marca, r.modelo].filter(Boolean).join(' ')}${r.bit ? ' · Bit ' + r.bit : ''}${vs.length ? ` · 🔁 ya vino ${vs.length === 1 ? '1 vez' : vs.length + ' veces'}` : ''}`;
      toast('Equipo leído: ' + [r.marca, r.modelo].filter(Boolean).join(' ') + (r.bit ? ' · Bit ' + r.bit : ''));
      if (clienteTxt()) irPaso(3); else irPaso(paso); // sin cliente todavía: se queda en el paso 1
    }
    // después de leer, en la misma ventana: cliente, falla y precio, y se guarda sin pasar por los pasos
    function seguirEnVentana(r, { cont, close }) {
      aplicarLectura(r);
      let cliSel = $('#or-cli').value || '';
      let cliNuevo = '';
      const fq = new Set();
      cont.innerHTML = `
        <div class="lq-eq">📱 ${esc([r.marca, r.modelo].filter(Boolean).join(' '))}${r.bit ? ` <span class="bit-tag">Bit ${esc(r.bit)}</span>` : ''}${r.memoria ? ` <span class="bit-tag">${esc(r.memoria)}</span>` : ''}</div>
        ${avisoVisitas(visitasDe(r.huella))}
        <label class="lq-lab">👤 Cliente</label>
        <input id="lq-cli" placeholder="🔎 Escriba el nombre…" autocomplete="off" value="${esc(cliSel ? clienteNombre(cliSel) : '')}">
        <div class="cli-sug" id="lq-sug"></div>
        <label class="lq-lab">🔧 Falla</label>
        <div class="chips" id="lq-fallas">${FALLAS.map((f) => `<button type="button" class="chip" data-f="${esc(f)}">${esc(f)}</button>`).join('')}<button type="button" class="chip" data-f="otra">Otra…</button></div>
        <input id="lq-otra" placeholder="Describa la falla" hidden>
        <div class="lq-precios">
          <label class="lq-lab">💵 Precio<input id="lq-costo" type="number" step="0.01" min="0" placeholder="0,00"></label>
          <label class="lq-lab">Abono<input id="lq-abono" type="number" step="0.01" min="0" placeholder="0,00"></label>
        </div>
        <button type="button" class="btn primary big lq-guardar" id="lq-guardar">GUARDAR E IMPRIMIR</button>`;
      cont.classList.add('lq');
      const q = (sel) => cont.querySelector(sel);
      const pintarSug = () => {
        const t = llaveCli(q('#lq-cli').value.trim());
        if (!t || cliSel) { q('#lq-sug').innerHTML = ''; return; }
        const lista = db.clientes.filter((c) => llaveCli(`${c.nombre} ${c.tienda || ''}`).includes(t))
          .sort((a, b) => (llaveCli(a.nombre).startsWith(t) ? 0 : 1) - (llaveCli(b.nombre).startsWith(t) ? 0 : 1) || a.nombre.localeCompare(b.nombre)).slice(0, 5);
        q('#lq-sug').innerHTML = lista.map((c) => `<button type="button" class="cli-op" data-cli="${c.id}"><b>${esc(c.nombre)}</b>${c.tienda ? `<small>${esc(c.tienda)}</small>` : ''}</button>`).join('')
          + `<button type="button" class="cli-op nuevo-op" data-cli-nuevo>➕ Cliente nuevo: <b>${esc(q('#lq-cli').value.trim())}</b></button>`;
      };
      q('#lq-cli').addEventListener('input', () => { cliSel = ''; cliNuevo = ''; q('#lq-cli').classList.remove('ok'); pintarSug(); });
      q('#lq-sug').addEventListener('click', (e) => {
        const c = e.target.closest('[data-cli]');
        if (c) { cliSel = c.dataset.cli; q('#lq-cli').value = clienteNombre(cliSel); }
        else if (e.target.closest('[data-cli-nuevo]')) cliNuevo = q('#lq-cli').value.trim();
        else return;
        q('#lq-cli').classList.add('ok');
        q('#lq-sug').innerHTML = '';
      });
      q('#lq-cli').addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        const op = q('#lq-sug [data-cli]');
        if (op) op.click(); else if (q('#lq-cli').value.trim()) q('#lq-sug [data-cli-nuevo]')?.click();
      });
      q('#lq-fallas').addEventListener('click', (e) => {
        const b = e.target.closest('[data-f]');
        if (!b) return;
        const f = b.dataset.f;
        fq.has(f) ? fq.delete(f) : fq.add(f);
        b.classList.toggle('on', fq.has(f));
        q('#lq-otra').hidden = !fq.has('otra');
        if (fq.has('otra')) q('#lq-otra').focus();
      });
      q('#lq-guardar').addEventListener('click', () => {
        if (!cliSel && !cliNuevo) {
          if (q('#lq-cli').value.trim() && !q('#lq-sug [data-cli]')) cliNuevo = q('#lq-cli').value.trim();
          else { toast('Busque y toque el cliente'); q('#lq-cli').focus(); return; }
        }
        if (!fq.size || (fq.has('otra') && fq.size === 1 && !q('#lq-otra').value.trim())) { toast('Toque la falla del equipo'); return; }
        // se pasa todo a la plantilla y se guarda con el mismo proceso de siempre
        if (cliSel) {
          if (![...$('#or-cli').options].some((op) => op.value === cliSel)) $('#or-cli').innerHTML = clienteOptions('', '— Cliente nuevo —');
          $('#or-cli').value = cliSel;
          modoNuevo = false;
          $('#or-buscar').value = clienteNombre(cliSel);
        } else {
          $('#or-cli').value = '';
          modoNuevo = true;
          $('#or-nom').value = cliNuevo;
          $('#or-buscar').value = cliNuevo;
        }
        toggleNuevo();
        fallasSel.clear();
        fq.forEach((f) => fallasSel.add(f));
        $$('#or-fallas .chip', el).forEach((x) => x.classList.toggle('on', fallasSel.has(x.dataset.falla)));
        $('#or-falla-otra').hidden = !fallasSel.has('otra');
        $('#or-falla-otra').value = q('#lq-otra').value.trim();
        $('#or-costo').value = q('#lq-costo').value || '0';
        $('#or-abono').value = q('#lq-abono').value || '0';
        close();
        irPaso(4);
        $('#or-form').requestSubmit();
      });
      setTimeout(() => (cliSel ? q('#lq-costo') : q('#lq-cli')).focus(), 50);
      return true;
    }
    $('#or-leer').addEventListener('click', () => abrirLectorEquipo(seguirEnVentana));
    $('#or-sig').addEventListener('click', siguiente);
    $('#or-atras').addEventListener('click', () => irPaso(Math.max(1, paso - 1)));
    $('#or-resumen').addEventListener('click', (e) => { const b = e.target.closest('[data-volver]'); if (b) irPaso(Number(b.dataset.volver)); });
    // elegir un cliente de la lista o una marca pasa solo al siguiente paso
    $('#or-cli').addEventListener('change', () => { if ($('#or-cli').value) irPaso(2); });
    $('#or-marcas').addEventListener('click', (e) => { const b = e.target.closest('[data-marca]'); if (b && b.dataset.marca) setTimeout(() => irPaso(3), 150); });
    // Enter en los pasos 1 a 3 avanza en vez de guardar
    $('#or-form').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && paso < 4 && e.target.tagName === 'INPUT') { e.preventDefault(); siguiente(); }
    });
    irPaso(1);

    $('#or-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      if (paso < 4) { siguiente(); return; }
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
        equipo: $('#or-eq').value, marca, modelo: $('#or-modelo').value.trim(), binario: $('#or-bin').value.trim(), memoria: $('#or-mem').value.trim(), huella: $('#or-huella').value.trim(), falla, trabajo: $('#or-trab').value.trim(),
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
      leido = null;
      $('#or-bin').value = '';
      $('#or-mem').value = '';
      $('#or-huella').value = '';
      $('#or-leido').hidden = true;
      $('#or-cli').innerHTML = clienteOptions('', '— Cliente nuevo —');
      $('#or-buscar').value = '';
      $('#or-sug').innerHTML = '';
      modoNuevo = false;
      toggleNuevo();
      irPaso(1);
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
    $('#or-fecha').addEventListener('change', render);
    $('#or-hoy').addEventListener('click', () => { $('#or-fecha').value = today(); render(); });
    $('#or-body').addEventListener('change', (e) => {
      const fa = e.target.closest('[data-falla]');
      if (fa) {
        const o = db.ordenes.find((x) => x.id === fa.dataset.falla);
        if (o && fa.value) { o.falla = fa.value; save(); toast(`Falla: ${fa.value}`); }
        render();
        return;
      }
      const s = e.target.closest('[data-estado]');
      if (s) {
        const o = db.ordenes.find((x) => x.id === s.dataset.estado);
        setEstado(o, s.value);
        toast(s.value === 'Entregado' ? '📦 Entregado' : 'Volvió al taller');
        render();
      }
    });
    $('#or-body').addEventListener('click', (e) => {
      const ed = e.target.closest('[data-editar]');
      if (ed) editarOrden(ed.dataset.editar);
      const pag = e.target.closest('[data-pagar]');
      if (pag) pagarOrden(pag.dataset.pagar);
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
    excelSeccion = (() =>
      exportXLSX(`Ordenes_Ingreso_212VIP_${today()}.xlsx`, {
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
      ${head('INVENTARIO', 'h-yellow')}
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
    excelSeccion = (() =>
      exportXLSX(`Inventario_212VIP_${today()}.xlsx`, {
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
    // órdenes (con su número de factura: si ya está usado, el servidor le da el siguiente libre) y cierres
    const ordIds = new Set(db.ordenes.map((x) => x.id));
    const nuevosO = (data.ordenes || []).filter((o) => o.id && !ordIds.has(o.id)).map((o) => ({ ...o, clienteId: mapa[o.clienteId] || o.clienteId }));
    const ciIds = new Set(db.cierres.map((x) => x.id));
    const nuevosCi = (data.cierres || []).filter((c) => c.id && !ciIds.has(c.id) && !db.cierres.some((x) => x.fecha === c.fecha));
    return {
      nC: nuevosC.length, nM: nuevosM.length, nD: nuevosD.length, nO: nuevosO.length, nCi: nuevosCi.length,
      total: nuevosC.length + nuevosM.length + nuevosD.length + nuevosO.length + nuevosCi.length,
      aplicar() {
        db.clientes.push(...nuevosC); db.movimientos.push(...nuevosM); db.cartera.push(...nuevosD);
        nuevosO.forEach((o) => {
          if (db.ordenes.some((x) => x.factura === o.factura)) o.factura = nuevaFactura();
          db.ordenes.push(o);
        });
        db.cierres.push(...nuevosCi);
      },
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
    if (importOctIntentado || db.config[IMPORT_OCT] === '6') return;
    if (db.config[IMPORT_OCT] === '5') { // pedido del 5/10: borrar todos los trabajos y dejar solo los clientes (una única vez)
      if (hasPending()) return;
      importOctIntentado = true;
      return borrarTrabajos('6').then(() => toast('Listo: se borraron los trabajos y quedaron solo los clientes'), () => { importOctIntentado = false; });
    }
    if (db.config[IMPORT_OCT] === '3') return importarCopia();
    if (db.config[IMPORT_OCT] === '4') return renumerarFacturas();
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
      importOctIntentado = false;
      setTimeout(importarOctubre, 1500); // sigue con la copia del 5/10
    } catch (e) {
      importOctIntentado = false; // sin conexión: se intenta en la próxima sincronización
    }
  }
  // '3' → '4': la copia de seguridad del 5/10 (órdenes del 4/10, deudas y el cierre del 4/10), una única vez.
  // La deuda "Cliente final $25" del Excel son esas mismas 2 órdenes (Redmi 15C $20 + Samsung A23 $5): se quita para no cobrarla doble.
  async function importarCopia() {
    try {
      const r = await fetch('data/copia-2026-10-05.json', { cache: 'no-store' });
      const data = await r.json();
      if (hasPending() || db.config[IMPORT_OCT] !== '3') { importOctIntentado = false; return; }
      const imp = prepararImport(data);
      imp.aplicar();
      const cf = db.cartera.find((d) => d.id === 'imp-cart-12' && !(d.abonos || []).length);
      if (cf && imp.nO) db.cartera = db.cartera.filter((d) => d !== cf);
      db.config[IMPORT_OCT] = '4';
      save();
      if (imp.total) { toast(`Se cargó la copia: ${imp.nO} órdenes, ${imp.nD} deudas, ${imp.nC} clientes y ${imp.nCi} cierre`); refreshView(); }
      importOctIntentado = false;
      setTimeout(importarOctubre, 1500);
    } catch (e) {
      importOctIntentado = false;
    }
  }
  // deja SOLO los clientes: borra órdenes, cartera, reporte diario, cierres e inventario y la factura vuelve a 001
  async function borrarTrabajos(marca) {
    const limpio = { ...emptyDB(), config: { ...db.config, ...(marca ? { [IMPORT_OCT]: marca } : {}) }, clientes: clone(db.clientes) };
    const res = await api('POST', 'data', { replace: limpio });
    synced = normalize(res.data);
    db = clone(synced);
    version = res.version;
    cacheLocal();
    route({ keepScroll: true });
  }
  // '4' → '5': las facturas quedan 001, 002, 003… en orden de fecha (una única vez)
  function renumerarFacturas() {
    if (hasPending()) { importOctIntentado = false; return; }
    const lista = db.ordenes.slice().sort((a, b) => a.fecha.localeCompare(b.fecha) || (Number(a.factura) || 0) - (Number(b.factura) || 0));
    lista.forEach((o, i) => { o.factura = String(i + 1).padStart(3, '0'); });
    db.seq.factura = lista.length + 1;
    db.config[IMPORT_OCT] = '5';
    save();
    if (lista.length) { toast(`Facturas ordenadas: N°001 a N°${String(lista.length).padStart(3, '0')}`); refreshView(); }
    importOctIntentado = false;
    setTimeout(importarOctubre, 1500);
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
          <button type="button" class="chip big" data-tema="fucsia">Fucsia, blanco y negro</button>
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
        <p style="color:var(--muted);margin-top:0">Borra <b>todos</b> los clientes, órdenes / equipos, cartera, cierre diario, cierres e inventario en <b>todas</b> las computadoras. La factura vuelve a empezar en 00. Se mantienen los datos del negocio, el WhatsApp del encargado y la contraseña. Antes de borrar se descarga una copia por si acaso.</p>
        <div class="form-actions"><button class="btn yellow" id="aj-trabajos">🧽 Borrar trabajos (dejar clientes)</button><button class="btn red" id="aj-reset">🧹 Dejar todo en blanco</button></div>
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
        negocio: $('#aj-neg').value.trim() || '212 V.I.P', telefono: $('#aj-tel').value.trim(), direccion: $('#aj-dir').value.trim(),
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
      exportXLSX(`212VIP_Completo_${today()}.xlsx`, {
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
      a.download = `212VIP_copia_${today()}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    });
    $('#aj-trabajos').addEventListener('click', () => {
      if (!confirm(`Se borran ${db.ordenes.length} órdenes, la cartera, el cierre diario, los cierres y el inventario en todas las computadoras. Quedan los ${db.clientes.length} clientes y la factura vuelve a N°001. ¿Continuar?`)) return;
      if ((prompt('Para confirmar escriba BORRAR') || '').trim().toUpperCase() !== 'BORRAR') { toast('No se borró nada'); return; }
      $('#aj-backup').click(); // copia de seguridad antes de borrar
      borrarTrabajos().then(() => toast('Listo: quedaron solo los clientes'), (err) => (err instanceof AuthError ? handleSyncError(err) : toast('No se pudo borrar: ' + err.message)));
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
          toast('El archivo no es un archivo para importar a 212 V.I.P');
          return;
        }
        const imp = prepararImport(data);
        if (!imp.total) { toast('Esos datos ya estaban en el sistema'); return; }
        if (!confirm(`Se van a agregar ${imp.nC} clientes nuevos, ${imp.nM} trabajos al cierre diario y ${imp.nD} deudas a Cartera. ¿Continuar?`)) return;
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
          toast('El archivo no es una copia válida de 212 V.I.P');
        }
      };
      r.readAsText(f);
    });
  };

  // ------------------------------------------------------------------ deslizar hacia abajo para actualizar (como Instagram)
  (function deslizarParaActualizar() {
    const ind = document.createElement('div');
    ind.id = 'ptr';
    ind.innerHTML = '<b>↓</b><span>Deslice para actualizar</span>';
    document.body.appendChild(ind);
    const UMBRAL = 70;
    let y0 = null, h = 0, ocupado = false;
    const mover = (alto) => {
      ind.style.transform = `translate(-50%, ${alto - 60}px)`;
      ind.style.opacity = Math.min(1, alto / 50);
    };
    const reset = () => { ind.classList.remove('listo', 'cargando'); ind.lastChild.textContent = 'Deslice para actualizar'; mover(0); h = 0; };
    window.addEventListener('touchstart', (e) => {
      y0 = !ocupado && window.scrollY <= 0 && !$('#app').hidden && !document.querySelector('.modal-back') ? e.touches[0].clientY : null;
    }, { passive: true });
    window.addEventListener('touchmove', (e) => {
      if (y0 === null) return;
      const dy = e.touches[0].clientY - y0;
      if (dy <= 0 || window.scrollY > 0) { h = 0; mover(0); return; }
      h = Math.min(dy * 0.5, 110);
      mover(h);
      ind.classList.toggle('listo', h >= UMBRAL);
      ind.lastChild.textContent = h >= UMBRAL ? 'Suelte para actualizar' : 'Deslice para actualizar';
    }, { passive: true });
    window.addEventListener('touchend', async () => {
      if (y0 === null) return;
      y0 = null;
      if (h < UMBRAL) return reset();
      ocupado = true;
      ind.classList.add('cargando');
      ind.lastChild.textContent = 'Actualizando…';
      mover(UMBRAL);
      try {
        checkVersion(); // si hay versión nueva de la app, se actualiza sola
        if (hasPending()) await push();
        await pull();
        const filled = $$('#view form input, #view form textarea').some((i) => i.type !== 'date' && i.type !== 'number' && i.value);
        if (!document.querySelector('.modal-back')) {
          if (filled) refreshOrdenList(); // no se borra lo que está escribiendo: solo se actualiza la lista
          else route({ keepScroll: true });
        }
        toast(document.querySelector('#sync-status.bad') ? 'Sin conexión: no se pudo actualizar' : '✅ Actualizado');
      } finally {
        ocupado = false;
        reset();
      }
    });
  })();

  // ------------------------------------------------------------------ inicio
  if (isLogged()) {
    showApp();
    if (hasPending()) push();
    else pull({ rerender: true });
  } else showLogin();
})();
