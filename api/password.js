// POST /api/password { user, pass }  ->  { token, user }   (cambia el acceso; cierra las demás sesiones)
import { load, update, verifyToken, makeAuth, makeToken, json, bearer, readBody } from './_lib/core.js';

export async function POST(request) {
  const { user = '', pass = '' } = await readBody(request);
  const { doc: current } = await load();
  if (!verifyToken(current, bearer(request))) return json(401, { error: 'Sesión vencida, vuelva a entrar' });
  const u = String(user).trim();
  if (!u || String(pass).length < 4) return json(400, { error: 'Usuario requerido y contraseña de al menos 4 caracteres' });
  const { doc } = await update((d) => {
    d.auth = makeAuth(u, String(pass));
  });
  return json(200, { token: makeToken(doc, u), user: u });
}
