// Dónde se guarda la base de datos de SIMTEC.
// En Vercel: un archivo JSON privado en Vercel Blob (necesita BLOB_READ_WRITE_TOKEN).
// En local (pruebas): un archivo en disco indicado por SIMTEC_DATA_FILE.
import { promises as fs } from 'node:fs';
import { get, head, put } from '@vercel/blob';

const DB_PATH = 'simtec/db.json';

export class ConflictError extends Error {}

const useBlob = () => !!process.env.BLOB_READ_WRITE_TOKEN;
const isNotFound = (e) => /not ?found|404/i.test(`${e && e.name} ${e && e.message}`);

// Devuelve { doc, etag } (doc = null si todavía no existe).
export async function readDoc() {
  if (useBlob()) {
    // El etag se toma de head() (el mismo que usa put con ifMatch). El de get() viene de la
    // cabecera HTTP de descarga y tiene otro formato, por eso nunca coincidía.
    let meta;
    try {
      meta = await head(DB_PATH);
    } catch (e) {
      if (isNotFound(e)) return { doc: null, etag: null };
      throw e;
    }
    const res = await get(meta.url, { access: 'private', useCache: false });
    if (!res || res.statusCode !== 200) return { doc: null, etag: null };
    const text = await new Response(res.stream).text();
    return { doc: JSON.parse(text), etag: meta.etag };
  }
  const file = localFile();
  try {
    const text = await fs.readFile(file, 'utf8');
    const doc = JSON.parse(text);
    return { doc, etag: String(doc.version) };
  } catch (e) {
    if (e.code === 'ENOENT') return { doc: null, etag: null };
    throw e;
  }
}

// Escribe solo si nadie más escribió desde que se leyó. Si no, lanza ConflictError.
// expectedVersion = versión que tenía el documento al leerlo.
export async function writeDoc(doc, etag, expectedVersion) {
  const body = JSON.stringify(doc);
  if (useBlob()) {
    const opts = { access: 'private', addRandomSuffix: false, contentType: 'application/json' };
    try {
      await put(DB_PATH, body, etag ? { ...opts, ifMatch: etag } : { ...opts, allowOverwrite: false });
      return;
    } catch (e) {
      if (!/precondition|already exists|etag|412|409/i.test(`${e.name} ${e.message}`)) throw e;
      console.warn('[simtec] escritura condicional rechazada:', e.name, e.message);
    }
    // Respaldo: si la versión guardada sigue siendo la que se leyó, nadie más escribió
    // (el rechazo fue por el etag), así que se guarda igual en vez de quedar bloqueado.
    const { doc: now } = await readDoc();
    if ((now ? now.version || 0 : 0) !== (expectedVersion || 0)) throw new ConflictError('otra computadora guardó primero');
    await put(DB_PATH, body, { ...opts, allowOverwrite: true });
    return;
  }
  // en local, comparar y escribir sin que otro guardado se meta en medio (igual que ifMatch en Blob)
  const run = localLock.then(async () => {
    const { etag: current } = await readDoc();
    if (current !== etag) throw new ConflictError('versión cambiada');
    await fs.writeFile(localFile(), body);
  });
  localLock = run.catch(() => {});
  return run;
}
let localLock = Promise.resolve();

// Copia de seguridad diaria (una por día, la última del día gana).
export async function writeBackup(doc, day) {
  const body = JSON.stringify(doc);
  if (useBlob()) {
    await put(`simtec/copias/${day}.json`, body, {
      access: 'private', addRandomSuffix: false, allowOverwrite: true, contentType: 'application/json',
    });
    return;
  }
  await fs.writeFile(`${localFile()}.${day}.bak`, body);
}

function localFile() {
  const f = process.env.SIMTEC_DATA_FILE;
  if (!f) throw new Error('Falta BLOB_READ_WRITE_TOKEN (Vercel Blob) o SIMTEC_DATA_FILE (modo local)');
  return f;
}
