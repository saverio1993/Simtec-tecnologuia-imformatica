// GET  /api/data                         -> { version, data }
// POST /api/data { ops, config, seq }     -> aplica cambios y devuelve { version, data }
// POST /api/data { replace: data }        -> reemplaza todo (restaurar copia / subir datos locales)
import { load, update, verifyToken, applyChanges, cleanData, json, bearer, readBody } from './_lib/core.js';
import { writeBackup } from './_lib/storage.js';

const unauthorized = () => json(401, { error: 'Sesión vencida, vuelva a entrar' });

export async function GET(request) {
  const { doc } = await load();
  if (!verifyToken(doc, bearer(request))) return unauthorized();
  return json(200, { version: doc.version || 0, data: cleanData(doc.data) });
}

export async function POST(request) {
  const body = await readBody(request);
  const token = bearer(request);
  {
    const { doc } = await load();
    if (!verifyToken(doc, token)) return unauthorized();
    // antes de reemplazar todo (restaurar copia / borrar), se guarda una copia de cómo estaba
    if (body.replace) await writeBackup(doc, 'antes-de-borrar-' + new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')).catch(() => {});
  }
  const { doc } = await update((d) => {
    d.data = body.replace ? cleanData(body.replace) : applyChanges(cleanData(d.data), body);
  });
  return json(200, { version: doc.version, data: cleanData(doc.data) });
}
