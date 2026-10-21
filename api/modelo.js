// POST /api/modelo { codigo, fabricante, marca, extra }  ->  { marca, modelo, deBase, fuente }
// Cuando "Leer equipo" da un código que la app no conoce (ej. el nombre clave "arctic" de un Xiaomi en Fastboot):
//  1) lo que el técnico corrigió a mano o lo que ya se encontró en las bases (guardado en doc.modelosIA)
//  2) las bases públicas de modelos (lista oficial de Google Play y MobileModels): son exactas
//  3) lo que respondió la IA otra vez guardado, y si no hay nada, se le pregunta a la IA de Vercel (AI Gateway)
// Todo lo encontrado se guarda en doc.modelosIA para no volver a buscar ese código.
// Autenticación con el gateway: AI_GATEWAY_API_KEY si existe; si no, el token OIDC de Vercel (sin clave aparte).
import { load, update, verifyToken, json, bearer, readBody } from './_lib/core.js';
import { buscarEnBases } from './_lib/bases.js';

const GATEWAY = 'https://ai-gateway.vercel.sh/v1';
// modelos baratos que se prueban primero; si el plan no los permite se usa cualquier otro disponible
const PREFERIDOS = ['google/gemini-2.5-flash-lite', 'google/gemini-2.5-flash', 'openai/gpt-5-nano', 'openai/gpt-4.1-nano', 'openai/gpt-4o-mini',
  'openai/gpt-5-mini', 'xai/grok-3-mini', 'deepseek/deepseek-v3', 'anthropic/claude-haiku-4.5', 'anthropic/claude-sonnet-5'];
let modelosOk = null; // se calcula una vez por instancia

async function modelosDisponibles(llave) {
  if (modelosOk) return modelosOk;
  try {
    const r = await fetch(`${GATEWAY}/models?include_availability`, { headers: { Authorization: `Bearer ${llave}` } });
    if (r.ok) {
      const { data = [] } = await r.json();
      const aptos = data.filter((m) => (!m.type || m.type === 'language') && (!m.model_eligibility || m.model_eligibility.status !== 'ineligible'));
      const ids = new Set(aptos.map((m) => m.id));
      const precio = (m) => Number(m.pricing && m.pricing.input) || 1;
      const resto = aptos.filter((m) => !PREFERIDOS.includes(m.id)).sort((a, b) => precio(a) - precio(b)).map((m) => m.id);
      modelosOk = [...PREFERIDOS.filter((id) => ids.has(id)), ...resto].slice(0, 6);
      if (modelosOk.length) return modelosOk;
    } else console.error('ai-gateway models', r.status, (await r.text()).slice(0, 200));
  } catch (e) { console.error('ai-gateway models', e && e.message); }
  return PREFERIDOS;
}

async function preguntar(llave, model, pregunta, cod, conBusqueda, pista) {
  const body = { model, messages: [{ role: 'user', content: pregunta }], max_tokens: 300 };
  if (conBusqueda) body.tools = [{ type: 'vercel:perplexity_search', config: { query: `${pista ? pista + ' ' : ''}${cod} phone model name`, max_results: 5 } }];
  const r = await fetch(`${GATEWAY}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${llave}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) { console.error('ai-gateway', model, conBusqueda ? 'busqueda' : 'sin-busqueda', r.status, (await r.text()).slice(0, 200)); return null; }
  const data = await r.json();
  const m = String(data?.choices?.[0]?.message?.content || '').match(/\{[\s\S]*?\}/);
  if (!m) return null;
  const out = JSON.parse(m[0]);
  return { marca: String(out.marca || '').trim().slice(0, 30), modelo: String(out.modelo || '').trim().slice(0, 80) };
}

export async function POST(request) {
  const { doc } = await load();
  if (!verifyToken(doc, bearer(request))) return json(401, { error: 'Sesión vencida, vuelva a entrar' });
  const body = await readBody(request);
  const { codigo = '', fabricante = '', marca: pista = '', extra = '' } = body;
  const cod = String(codigo).trim().slice(0, 60);
  if (!cod) return json(400, { error: 'Falta el código' });
  const clave = cod.toUpperCase();

  // corrección del técnico: reemplaza lo que haya en la base (por ejemplo, una respuesta equivocada de la IA)
  const { corregir } = body;
  if (corregir && corregir.modelo) {
    const fijo = { marca: String(corregir.marca || '').trim().slice(0, 30), modelo: String(corregir.modelo).trim().slice(0, 80), fecha: new Date().toISOString().slice(0, 10), manual: true };
    await update((d) => { d.modelosIA = { ...(d.modelosIA || {}), [clave]: fijo }; });
    return json(200, { ...fijo, deBase: true });
  }

  const guardar = (res) =>
    update((d) => {
      d.modelosIA = { ...(d.modelosIA || {}), [clave]: { ...res, fecha: new Date().toISOString().slice(0, 10) } };
    }).catch((e) => console.error('guardar modelosIA', e && e.message));

  // 1) corregido a mano o ya encontrado en las bases: no se vuelve a buscar
  const guardado = doc.modelosIA && doc.modelosIA[clave];
  if (guardado && guardado.modelo && (guardado.manual || guardado.fuente === 'base')) return json(200, { ...guardado, deBase: true });

  // 2) bases públicas de modelos (no gastan IA y no inventan)
  const enBase = await buscarEnBases(cod, pista).catch((e) => { console.error('bases', e && e.message); return null; });
  if (enBase) {
    await guardar(enBase);
    return json(200, { ...enBase, deBase: true });
  }

  // 3) lo que la IA respondió antes
  if (guardado && guardado.modelo) return json(200, { ...guardado, deBase: true });

  const llave = process.env.AI_GATEWAY_API_KEY || request.headers.get('x-vercel-oidc-token') || process.env.VERCEL_OIDC_TOKEN;
  if (!llave) return json(503, { error: 'La búsqueda con IA no está activada en Vercel' });

  const pregunta =
    `Un teléfono Android conectado por USB (Fastboot / modo descarga) se identificó con el código "${cod}"` +
    (fabricante ? ` y el fabricante USB "${String(fabricante).slice(0, 40)}"` : '') +
    (pista ? `. La marca probable es ${String(pista).slice(0, 30)}` : '') +
    (extra ? `. Más datos que dio el equipo: ${String(extra).slice(0, 200)}` : '') +
    '. Ese código puede ser el nombre clave (codename) del dispositivo o su número de modelo. ' +
    'Ojo: Xiaomi, Redmi y POCO usan nombres clave en inglés (emerald, sapphire, arctic…); no los confundas con nombres de colores de otras marcas. ' +
    '¿A qué teléfono corresponde? Responde SOLO un JSON sin texto extra, así: ' +
    '{"marca":"Xiaomi|Samsung|Honor|Huawei|Motorola|Oppo|Tecno|Infinix|ZTE|…","modelo":"nombre comercial completo, ej. Redmi Note 13 Pro 4G"}. ' +
    'Si no estás seguro, responde {"marca":"","modelo":""}.';

  // 4) IA: con búsqueda en internet y, si el plan no la permite, solo con lo que el modelo sabe
  const modelos = await modelosDisponibles(llave);
  let res = null;
  for (const model of modelos) {
    try {
      res = (await preguntar(llave, model, pregunta, cod, true, pista)) || (await preguntar(llave, model, pregunta, cod, false, pista));
    } catch (e) { console.error('ai-gateway', model, e && e.message); }
    if (res) break;
  }
  if (!res) return json(502, { error: 'No se pudo buscar el modelo' });

  // se guarda para no volver a gastar IA con este código
  if (res.modelo) await guardar({ ...res, fuente: 'ia' });
  return json(200, { ...res, fuente: 'ia', deBase: false });
}
