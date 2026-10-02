// Dónde se guarda la base de datos de SIMTEC.
// En Vercel: un archivo JSON privado en Vercel Blob (necesita BLOB_READ_WRITE_TOKEN).
// En local (pruebas): un archivo en disco indicado por SIMTEC_DATA_FILE.
import { promises as fs } from 'node:fs';
import { get, put } from '@vercel/blob';

const DB_PATH = 'simtec/db.json';

export class ConflictError extends Error {}

const useBlob = () => !!process.env.BLOB_READ_WRITE_TOKEN;

// Devuelve { doc, etag } (doc = null si todavía no existe).
export async function readDoc() {
  if (useBlob()) {
    const res = await get(DB_PATH, { access: 'private', useCache: false });
    if (!res || res.statusCode !== 200) return { doc: null, etag: null };
    const text = await new Response(res.stream).text();
    return { doc: JSON.parse(text), etag: res.blob.etag };
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

// Escribe solo si nadie más escribió desde que se leyó (etag). Si no, lanza ConflictError.
export async function writeDoc(doc, etag) {
  const body = JSON.stringify(doc);
  if (useBlob()) {
    try {
      await put(DB_PATH, body, {
        access: 'private',
        addRandomSuffix: false,
        contentType: 'application/json',
        ...(etag ? { ifMatch: etag } : { allowOverwrite: false }),
      });
    } catch (e) {
      if (/precondition|already exists/i.test(`${e.name} ${e.message}`)) throw new ConflictError(e.message);
      throw e;
    }
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
