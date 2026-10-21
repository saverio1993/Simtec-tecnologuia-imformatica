// POST /api/modelo { codigo, fabricante }  ->  { marca, modelo }
// Cuando "Leer equipo" da un código que la app no conoce (ej. el nombre clave "arctic" de un Xiaomi en Fastboot),
// se le pregunta a la IA de Vercel (AI Gateway) con búsqueda en internet cuál es el teléfono.
// Autenticación con el gateway: AI_GATEWAY_API_KEY si existe; si no, el token OIDC de Vercel (sin clave aparte).
import { load, verifyToken, json, bearer, readBody } from './_lib/core.js';

const MODELOS = ['anthropic/claude-sonnet-5', 'openai/gpt-5-mini'];

export async function POST(request) {
  const { doc } = await load();
  if (!verifyToken(doc, bearer(request))) return json(401, { error: 'Sesión vencida, vuelva a entrar' });
  const { codigo = '', fabricante = '' } = await readBody(request);
  const cod = String(codigo).trim().slice(0, 60);
  if (!cod) return json(400, { error: 'Falta el código' });
  const llave = process.env.AI_GATEWAY_API_KEY || request.headers.get('x-vercel-oidc-token') || process.env.VERCEL_OIDC_TOKEN;
  if (!llave) return json(503, { error: 'La búsqueda con IA no está activada en Vercel' });

  const pregunta =
    `Un teléfono Android conectado por USB (Fastboot / modo descarga) se identificó con el código "${cod}"` +
    (fabricante ? ` y el fabricante USB "${String(fabricante).slice(0, 40)}"` : '') +
    '. Ese código puede ser el nombre clave (codename) del dispositivo o su número de modelo. ' +
    'Busca en internet a qué teléfono corresponde. Responde SOLO un JSON sin texto extra, así: ' +
    '{"marca":"Xiaomi|Samsung|Honor|Huawei|Motorola|Oppo|Tecno|Infinix|ZTE|…","modelo":"nombre comercial completo, ej. Redmi Note 13 Pro 4G"}. ' +
    'Si no estás seguro, responde {"marca":"","modelo":""}.';

  for (const model of MODELOS) {
    try {
      const r = await fetch('https://ai-gateway.vercel.sh/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${llave}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: pregunta }],
          tools: [{ type: 'vercel:perplexity_search', config: { query: `${cod} android phone codename model`, max_results: 5 } }],
          max_tokens: 300,
        }),
      });
      if (!r.ok) { console.error('ai-gateway', model, r.status, (await r.text()).slice(0, 300)); continue; }
      const data = await r.json();
      const texto = String(data?.choices?.[0]?.message?.content || '');
      const m = texto.match(/\{[\s\S]*?\}/);
      if (!m) continue;
      const out = JSON.parse(m[0]);
      return json(200, { marca: String(out.marca || '').trim().slice(0, 30), modelo: String(out.modelo || '').trim().slice(0, 80) });
    } catch (e) {
      console.error('ai-gateway', model, e && e.message);
    }
  }
  return json(502, { error: 'No se pudo buscar el modelo' });
}
