// Bases públicas de modelos de teléfonos, para no depender de la IA (que a veces se equivoca):
//  1) la lista oficial de Google Play (marca, nombre comercial, nombre clave y número de modelo de cada equipo certificado)
//  2) MobileModels en GitHub (nombres clave de Xiaomi/Redmi/POCO, Honor, Huawei, Samsung… con todas sus variantes)
// Se descargan una vez por instancia y se guardan en memoria.

const PLAY = 'https://storage.googleapis.com/play_public/supported_devices.csv';
const MM = 'https://raw.githubusercontent.com/KHwang9883/MobileModels/master/brands/';
const MM_ARCHIVOS = {
  xiaomi_en: 'Xiaomi', honor_global_en: 'Honor', huawei_global_en: 'Huawei', samsung_global_en: 'Samsung', oppo_global_en: 'Oppo',
  realme_global_en: 'Realme', vivo_global_en: 'Vivo', oneplus_en: 'OnePlus', google: 'Google', nothing: 'Nothing', asus_en: 'Asus',
};

// marcas que son de la misma familia (un Redmi o un POCO es Xiaomi; Honor salió de Huawei)
const FAMILIA = { redmi: 'xiaomi', poco: 'xiaomi', pocophone: 'xiaomi', mi: 'xiaomi', xiaomi: 'xiaomi', honor: 'honor', huawei: 'honor', samsung: 'samsung',
  oppo: 'oppo', realme: 'oppo', oneplus: 'oppo', vivo: 'vivo', iqoo: 'vivo', motorola: 'motorola', lenovo: 'motorola', tecno: 'transsion', infinix: 'transsion', itel: 'transsion' };
const familia = (m) => FAMILIA[String(m || '').trim().toLowerCase().split(/\s+/)[0]] || String(m || '').trim().toLowerCase();
const MARCA_APP = { xiaomi: 'Xiaomi', honor: 'Honor' }; // cómo se guarda la marca en la app (Redmi y POCO van como Xiaomi; Huawei como Honor)

let play = null; // { porModelo: Map, porClave: Map }
let mm = null; // { porModelo: Map, porClave: Map }

const agregar = (mapa, k, v) => {
  if (!k) return;
  const l = mapa.get(k);
  if (l) l.push(v); else mapa.set(k, [v]);
};

async function cargarPlay() {
  if (play) return play;
  const r = await fetch(PLAY);
  if (!r.ok) throw new Error('google play ' + r.status);
  const texto = new TextDecoder('utf-16le').decode(await r.arrayBuffer());
  const porModelo = new Map();
  const porClave = new Map();
  for (const linea of texto.split(/\r?\n/)) {
    const m = linea.match(/^"(.*)","(.*)","(.*)","(.*)"$/);
    if (!m) continue;
    const [, marca, nombre, clave, modelo] = m.map((x) => x.replace(/""/g, '"').replace(/\s+/g, ' ').trim());
    if (!nombre) continue;
    const v = { marca, nombre };
    agregar(porModelo, modelo.toUpperCase(), v);
    agregar(porClave, clave.toLowerCase(), v);
  }
  return (play = { porModelo, porClave });
}

async function cargarMM() {
  if (mm) return mm;
  const porModelo = new Map();
  const porClave = new Map();
  await Promise.all(Object.entries(MM_ARCHIVOS).map(async ([archivo, marca]) => {
    try {
      const r = await fetch(MM + archivo + '.md');
      if (!r.ok) return;
      let titulo = '';
      for (const linea of (await r.text()).split(/\r?\n/)) {
        // **[`N6`] Redmi Note 13 Pro (`emerald`):**   →   nombre del equipo y sus nombres clave
        const t = linea.match(/^\*\*(?:\[`[^`]*`\]\s*)?(.+?)((?:\s*\(`[^`]+`\))*):\*\*\s*$/);
        if (t) {
          titulo = t[1].replace(/\s+/g, ' ').trim();
          for (const [, c] of t[2].matchAll(/\(`([^`]+)`\)/g)) agregar(porClave, c.toLowerCase(), { marca, nombre: titulo });
          continue;
        }
        // `RKY-LX1` `RKY-LX2` `RKY-LX3`: HONOR X7a   →   números de modelo
        const l = linea.match(/^((?:`[^`]+`\s*)+):\s*(.+)$/);
        if (l && titulo) for (const [, c] of l[1].matchAll(/`([^`]+)`/g)) agregar(porModelo, c.toUpperCase(), { marca, nombre: titulo });
      }
    } catch (e) { /* si una marca no baja, se sigue con las demás */ }
  }));
  if (!porModelo.size && !porClave.size) throw new Error('mobilemodels vacío');
  return (mm = { porModelo, porClave });
}

// Devuelve { marca, modelo, fuente } o null. «pista» es la marca que ya cree la app (para no confundir, por ejemplo,
// el «emerald» de Xiaomi con un «Emerald» de otra marca).
export async function buscarEnBases(codigo, pista = '') {
  const cod = String(codigo || '').trim();
  if (!cod) return null;
  const sinRegion = cod.replace(/_(global|eea|in|ru|tw|id|tr|jp|lm|cn|eu)$/i, '');
  const claves = [...new Set([cod.toLowerCase(), sinRegion.toLowerCase()])];
  const modelos = [...new Set([cod.toUpperCase(), sinRegion.toUpperCase()])];
  const [p, g] = await Promise.all([cargarPlay().catch(() => null), cargarMM().catch(() => null)]);
  if (!p && !g) return null;
  const fam = pista ? familia(pista) : '';
  const deLaMarca = (l) => (fam ? l.filter((x) => familia(x.marca) === fam) : l);
  const buscar = (porModelo, porClave) => [
    ...modelos.flatMap((k) => (porModelo && porModelo.get(k)) || []),
    ...claves.flatMap((k) => (porClave && porClave.get(k)) || []),
  ];
  // primero el número de modelo exacto; si no, el nombre clave
  let hallados = deLaMarca([...buscar(p && p.porModelo, null), ...buscar(g && g.porModelo, null)]);
  if (!hallados.length) hallados = deLaMarca([...buscar(null, g && g.porClave), ...buscar(null, p && p.porClave)]);
  if (!hallados.length) return null;
  // marca más repetida y hasta 3 nombres comerciales distintos (un mismo nombre clave puede venderse con varios nombres)
  const cuenta = {};
  const conocidas = new Set(Object.values(FAMILIA)); // ante la duda gana una marca que se ve en la tienda
  for (const h of hallados) cuenta[familia(h.marca)] = (cuenta[familia(h.marca)] || 0) + (conocidas.has(familia(h.marca)) ? 1000 : 1);
  const fGanadora = Object.keys(cuenta).sort((a, b) => cuenta[b] - cuenta[a])[0];
  const deEsa = hallados.filter((h) => familia(h.marca) === fGanadora);
  const vistos = new Set();
  const nombres = [];
  for (const h of deEsa) {
    for (const parte of h.nombre.split(' / ')) {
      // sin repetir la marca, que la app ya la muestra aparte (HONOR X7a → X7a, OPPO A18 → A18)
      const n = parte.replace(/^(samsung|huawei|honor|oppo|vivo|realme|tecno|infinix|itel|motorola|xiaomi|oneplus|google|asus|nothing)\s+/i, '').trim();
      const k = n.toLowerCase().replace(/\s+5g$/, '');
      if (!n || vistos.has(k)) continue;
      vistos.add(k);
      nombres.push(n);
    }
  }
  const marca = MARCA_APP[fGanadora] || deEsa[0].marca.replace(/^./, (c) => c.toUpperCase());
  return { marca, modelo: nombres.slice(0, 3).join(' / ').slice(0, 80), fuente: 'base' };
}
