// Diagnóstico y recuperación (temporal): cuántos registros hay y qué copias existen, sin datos personales.
// ?copia=<ruta> muestra cuántos registros tiene una copia. ?restaurar=<ruta>&clave=…&version=N la vuelve a poner (una sola vez:
// solo funciona si la versión guardada sigue siendo N).
import { list, head, get } from '@vercel/blob';
import { load, update, cleanData, COLLECTIONS, json } from './_lib/core.js';

const CLAVE = '6f46e74c9970258bea6a5573';
const contar = (d) => Object.fromEntries(COLLECTIONS.map((c) => [c, Array.isArray(d && d[c]) ? d[c].length : null]));
async function leerCopia(ruta) {
  if (!/^simtec\/copias\/[\w-]+\.json$/.test(ruta)) throw new Error('ruta no válida');
  const meta = await head(ruta);
  const res = await get(meta.url, { access: 'private', useCache: false });
  return JSON.parse(await new Response(res.stream).text());
}

export async function GET(request) {
  const q = new URL(request.url).searchParams;
  const { doc, etag } = await load();
  if (q.get('copia')) {
    const c = await leerCopia(q.get('copia'));
    return json(200, { version: c.version, updatedAt: c.updatedAt, importOct: c.data && c.data.config && c.data.config.importOct2026, cuenta: contar(c.data) });
  }
  if (q.get('restaurar')) {
    if (q.get('clave') !== CLAVE) return json(403, { error: 'clave' });
    if (String(doc.version) !== q.get('version')) return json(409, { error: 'la versión ya cambió', version: doc.version });
    const c = await leerCopia(q.get('restaurar'));
    const datos = cleanData(c.data);
    datos.config.importOct2026 = '6'; // que nunca se vuelva a disparar el borrado automático
    const r = await update((d) => { d.data = datos; });
    return json(200, { ok: true, version: r.doc.version, cuenta: contar(r.doc.data) });
  }
  let copias = [];
  try {
    const r = await list({ prefix: 'simtec/' });
    copias = r.blobs.map((b) => ({ ruta: b.pathname, kb: Math.round(b.size / 1024), fecha: b.uploadedAt }));
  } catch (e) { copias = ['error: ' + e.message]; }
  return json(200, { version: doc.version || 0, updatedAt: doc.updatedAt || null, importOct: doc.data && doc.data.config && doc.data.config.importOct2026, hayEtag: !!etag, cuenta: contar(doc.data), copias });
}
