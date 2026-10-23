// Diagnóstico: cuántos registros hay guardados y qué copias de seguridad existen (sin datos personales).
import { list } from '@vercel/blob';
import { load, COLLECTIONS, json } from './_lib/core.js';

export async function GET() {
  const { doc, etag } = await load();
  const d = doc.data || {};
  const cuenta = Object.fromEntries(COLLECTIONS.map((c) => [c, Array.isArray(d[c]) ? d[c].length : null]));
  let copias = [];
  try {
    const r = await list({ prefix: 'simtec/' });
    copias = r.blobs.map((b) => ({ ruta: b.pathname, kb: Math.round(b.size / 1024), fecha: b.uploadedAt }));
  } catch (e) { copias = ['error: ' + e.message]; }
  return json(200, { version: doc.version || 0, updatedAt: doc.updatedAt || null, lastBackup: doc.lastBackup || null, hayEtag: !!etag, cuenta, copias });
}
