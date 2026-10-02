// POST /api/login  { user, pass }  ->  { token, user }
import { load, checkLogin, makeToken, json, readBody } from './_lib/core.js';

export async function POST(request) {
  const { user = '', pass = '' } = await readBody(request);
  const { doc } = await load();
  const ok = checkLogin(doc, String(user).trim(), String(pass));
  if (!ok) {
    await new Promise((r) => setTimeout(r, 600)); // frena intentos de adivinar la contraseña
    return json(401, { error: 'Usuario o contraseña incorrectos' });
  }
  return json(200, { token: makeToken(doc, ok), user: ok });
}
