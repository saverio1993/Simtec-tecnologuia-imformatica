// Lógica compartida de la API: usuarios, sesiones y cambios a los datos.
import crypto from 'node:crypto';
import { readDoc, writeDoc, writeBackup, ConflictError } from './storage.js';

export const COLLECTIONS = ['clientes', 'cartera', 'movimientos', 'ordenes', 'inventario'];
const DEFAULT_USER = 'admin';
const DEFAULT_PASS = 'simtec';
const SESSION_DAYS = 30;

export const emptyData = () => ({
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

// ------------------------------------------------------------ contraseñas
function hashPass(pass, salt) {
  return crypto.scryptSync(String(pass), salt, 32).toString('hex');
}
export function makeAuth(user, pass) {
  const salt = crypto.randomBytes(16).toString('hex');
  return { user, salt, hash: hashPass(pass, salt) };
}
function authOf(doc) {
  return (doc && doc.auth) || null;
}
export function checkLogin(doc, user, pass) {
  const auth = authOf(doc);
  if (!auth) return String(user).toLowerCase() === DEFAULT_USER && pass === DEFAULT_PASS ? DEFAULT_USER : null;
  if (String(user).toLowerCase() !== auth.user.toLowerCase()) return null;
  const a = Buffer.from(hashPass(pass, auth.salt), 'hex');
  const b = Buffer.from(auth.hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b) ? auth.user : null;
}

// ------------------------------------------------------------ sesiones
const secret = () =>
  crypto.createHash('sha256').update('simtec-session:' + (process.env.SESSION_SECRET || process.env.BLOB_READ_WRITE_TOKEN || 'local-dev')).digest();
// Al cambiar la contraseña cambia la huella y todas las sesiones anteriores dejan de servir.
const fingerprint = (doc) => (authOf(doc) ? authOf(doc).hash.slice(0, 16) : 'default');
const sign = (payload) => crypto.createHmac('sha256', secret()).update(payload).digest('base64url');

export function makeToken(doc, user) {
  const payload = Buffer.from(JSON.stringify({ u: user, f: fingerprint(doc), exp: Date.now() + SESSION_DAYS * 864e5 })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}
export function verifyToken(doc, token) {
  if (!token || !token.includes('.')) return null;
  const [payload, sig] = token.split('.');
  const good = Buffer.from(sign(payload));
  const given = Buffer.from(sig || '');
  if (good.length !== given.length || !crypto.timingSafeEqual(good, given)) return null;
  try {
    const p = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (p.exp < Date.now() || p.f !== fingerprint(doc)) return null;
    return p.u;
  } catch (e) {
    return null;
  }
}

// ------------------------------------------------------------ datos
export async function load() {
  const { doc, etag } = await readDoc();
  return { doc: doc || { version: 0, data: emptyData() }, etag };
}

// Lee, aplica el cambio y guarda; si otra computadora guardó en medio, reintenta.
export async function update(mutate) {
  for (let i = 0; i < 6; i++) {
    const { doc, etag } = await load();
    const now = new Date().toISOString();
    const day = now.slice(0, 10);
    // primer guardado del día: se guarda una copia de cómo estaba todo antes
    const previous = doc.version && doc.lastBackup !== day ? JSON.parse(JSON.stringify(doc)) : null;
    const result = mutate(doc);
    doc.version = (doc.version || 0) + 1;
    doc.updatedAt = now;
    doc.lastBackup = day;
    try {
      await writeDoc(doc, etag);
    } catch (e) {
      if (e instanceof ConflictError) continue;
      throw e;
    }
    if (previous) await writeBackup(previous, day).catch(() => {});
    return { doc, result };
  }
  throw new Error('Demasiados guardados al mismo tiempo, intente de nuevo');
}

// Aplica los cambios enviados por una computadora sobre la versión más reciente.
export function applyChanges(data, changes) {
  for (const op of changes.ops || []) {
    if (!COLLECTIONS.includes(op.c) || !op.id) continue;
    const list = data[op.c] || (data[op.c] = []);
    const i = list.findIndex((x) => x.id === op.id);
    if (op.del) {
      if (i >= 0) list.splice(i, 1);
    } else if (op.item && op.item.id === op.id) {
      if (i >= 0) list[i] = op.item;
      else list.push(op.item);
    }
  }
  if (changes.config && typeof changes.config === 'object') {
    for (const [k, v] of Object.entries(changes.config)) {
      if (k in emptyData().config) data.config[k] = String(v ?? '');
    }
  }
  if (changes.seq && Number.isFinite(changes.seq.orden)) {
    data.seq.orden = Math.max(data.seq.orden || 0, changes.seq.orden);
  }
  return data;
}

export function cleanData(input) {
  const base = emptyData();
  const out = { ...base, config: { ...base.config }, seq: { ...base.seq } };
  if (!input || typeof input !== 'object') return out;
  for (const c of COLLECTIONS) out[c] = Array.isArray(input[c]) ? input[c].filter((x) => x && x.id) : [];
  if (input.config) for (const k of Object.keys(base.config)) if (input.config[k] != null) out.config[k] = String(input.config[k]);
  if (input.seq && Number.isFinite(input.seq.orden)) out.seq.orden = input.seq.orden;
  return out;
}

// ------------------------------------------------------------ HTTP
export const json = (status, body) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });

export const bearer = (request) => (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');

export async function readBody(request) {
  try {
    return await request.json();
  } catch (e) {
    return {};
  }
}
