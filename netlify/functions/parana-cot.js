// ===================== PROXY PARANÁ SEGUROS (SOAP) — Cotizador online =====================
// Recibe el mismo _coDat que las otras compañías y devuelve { opciones:[{plan,cobertura,premio,suma}], error? }.
//
// API de Paraná = servicio SOAP (GeneXus). Método WSCotizarAutomotores.Execute (namespace tempuri.org).
//   Endpoint PRUE (test): http://ws.paranaseguros.com.ar/PARANA_COMERCIAL_PRUE/servlet/ar.com.glmsa.seguros.comercial.awscotizarautomotores
//   Endpoint PROD:        https://productores.paranaseguros.com.ar/PARANA_COMERCIAL_PROD/servlet/ar.com.glmsa.seguros.comercial.awscotizarautomotores
//
// El vehículo usa códigos PROPIOS de Paraná (MarcaCodigo/ModeloCodigo) que resolvemos contra
// parana_vehiculos.js (marca + texto de modelo → codMarca/cod).
//
//  ⚠️ CONFIG por variables de entorno de Netlify (los provee Paraná / comercial):
//      PARANA_SISTEMA_ORIGEN = "Origen de cotización" definido en el sistema (obligatorio)
//      PARANA_PRODUCTOR      = código de productor en Paraná (obligatorio)
//      PARANA_PLAN           = plan comercial (default NPM)
//      PARANA_BASE           = (opcional) URL base. Default: PROD (producción).
//                              Setearla SOLO para volver a testing (PRUE).
//      PARANA_RAMA / PARANA_FORMA_PAGO / PARANA_MODO_FACT / PARANA_COND_PAGO = overrides opcionales.
//
//  ⚠️ El manual no trae ejemplo de RESPONSE → el parseo de premios se afina con el debug (?debug=1),
//     que devuelve el XML crudo de Paraná.

const VEH = require('./parana_vehiculos.js');
const PARANA_VEHIC = VEH.PARANA_VEHIC || {};
// CP → SubCódigo postal (de TablasCotizacion). Paraná rechaza SubCodigoPostal 0.
let CP_SUB = {};
try { CP_SUB = require('./parana_cp.json'); } catch (e) { CP_SUB = {}; }

// BASE por env. PROD (default): https://productores.paranaseguros.com.ar/PARANA_COMERCIAL_PROD
//   TEST: http://ws.paranaseguros.com.ar/PARANA_COMERCIAL_PRUE (setear PARANA_BASE para volver a testing)
const BASE = (process.env.PARANA_BASE || 'https://productores.paranaseguros.com.ar/PARANA_COMERCIAL_PROD').replace(/\/+$/, '');
const COTIZAR_URL = BASE + '/servlet/ar.com.glmsa.seguros.comercial.awscotizarautomotores';
const SOAP_ACTION = 'http://tempuri.org/action/AWSCOTIZARAUTOMOTORES.Execute'; // del WSDL

// Config comercial. Defaults tomados de TablasCotizacion (Paraná) para póliza Individual Mensual.
//   Plan Comercial NPM · Modo Facturación NPM · Condición Pago 201 · IVA 5 (Consumidor Final)
//   Forma de Pago: 0=Manual · 3=Tarjeta · 4=CBU   |   Granizo (adicional): 1004
const SISTEMA_ORIGEN = process.env.PARANA_SISTEMA_ORIGEN || '';
const PRODUCTOR      = process.env.PARANA_PRODUCTOR || '';
const PLAN           = process.env.PARANA_PLAN || 'NPM';
const RAMA           = process.env.PARANA_RAMA || '04';
const TIPO_POLIZA    = process.env.PARANA_TIPO_POLIZA || 'AUT01';
const CAT_IVA        = process.env.PARANA_CAT_IVA || '5';   // 5 = Consumidor Final
const FORMA_PAGO     = process.env.PARANA_FORMA_PAGO || '0';
const MODO_FACT      = process.env.PARANA_MODO_FACT || 'NPM';
const COND_PAGO      = process.env.PARANA_COND_PAGO || '201';
// % de bonificación (descuento). Default 0 (desactivado): el ORIGEN de TESTING no admite modificarla
// ("El origen de cotización no admite modificar la Bonificación"). En PRODUCCIÓN, si el origen lo
// permite, setear PARANA_BONIFICACION=20 para aplicar el 20%.
const BONIFICACION   = process.env.PARANA_BONIFICACION || '0';

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

// Fecha de vigencia. El ambiente de TESTING de Paraná exige una fecha FIJA (la que ellos definen).
// Se setea con la env var PARANA_VIGENCIA_DESDE (YYYY-MM-DD). En PRODUCCIÓN se deja vacía y usa la
// fecha real de Argentina (UTC-3). El WSDL define VigenciaDesde como xsd:date → YYYY-MM-DD.
function vigenciaDesde() {
  const fija = (process.env.PARANA_VIGENCIA_DESDE || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(fija)) return fija;
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Argentina/Buenos_Aires', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date());
}

// Rankea los modelos de Paraná para (marca + texto de modelo). Devuelve los mejores candidatos,
// MEJOR PRIMERO. El texto viene del catálogo InfoAuto ("FOCUS S 1.6 L/15", "208 FELINE 1.6"):
// el 1er token SIEMPRE es el modelo (FOCUS, 208, CRONOS); el resto es cilindrada/terminación/ruido.
//
// Por qué una LISTA y no uno solo: la base de Paraná NO trae un año explícito por modelo, y Paraná
// valida la relación vehículo-año. Un "Gol" 2018 puede matchear primero el "GOL GL"/"TRENDLINE"
// viejo (no válido para 2018 → error). Devolviendo varios candidatos, la cotización prueba el
// siguiente hasta que Paraná acepta el año.
//
// Además usamos el AÑO para rankear: muchos nombres de Paraná traen el tag de línea "L/13", "L/17",
// "L/19" (ej. "GOL 1.6 5 P TREND L/17" = línea 2017). Para un 2018 preferimos la línea más cercana
// que NO sea posterior al año, así el modelo correcto queda arriba y se prueba primero.
function lineaAnioParana(nombre) {
  const m = (nombre || '').match(/\bL\/\s*(\d{2})\b/i);
  return m ? 2000 + parseInt(m[1], 10) : null;
}
function rankearVehiculos(marca, textoModelo, anio, maxN) {
  const m = PARANA_VEHIC[(marca || '').trim().toUpperCase()];
  if (!m || !m.modelos) return [];
  const q = (textoModelo || '').toUpperCase();
  // Ruido de la descripción InfoAuto (PTAS, AT, MT, L/XX, nº de puertas). OJO: NO filtramos el
  // 1er token aunque sea numérico — para Peugeot/Fiat/BMW/Alfa el modelo ES un número (208, 147,
  // 320, 155) y descartarlo hacía que un 208 matcheara un 207 (auto equivocado → no cotizaba).
  const RUIDO = /^(\d+|PTAS?|PUERTAS?|AT|MT|CVT|L\/?\d+|\d+P)$/;
  const raw = q.split(/\s+/).filter(Boolean);
  const qTokens = raw.filter((t, i) => i === 0 ? true : !RUIDO.test(t));
  if (!qTokens.length) return [];
  const anioNum = parseInt(anio, 10) || 0;
  const mk = (x) => ({ codMarca: m.codMarca, codModelo: x.cod, nombre: x.nombre });
  // Comparación del head sin espacios para tolerar tipeo ("ECOSPORT" ↔ "ECO SPORT", "C3" ↔ "C 3").
  const head = qTokens[0].replace(/\s+/g, '');
  const scored = m.modelos.map(x => {
    const nom = (x.nombre || '').toUpperCase();
    const exact = nom === q ? 1 : 0;                                  // match exacto: prioridad máxima
    const headMatch = nom.replace(/\s+/g, '').includes(head) ? 1 : 0; // el MODELO tiene que matchear
    const rest = qTokens.slice(1).reduce((s, t) => s + (nom.includes(t) ? 1 : 0), 0); // terminación desempata
    // Año de línea (L/XX). Bonus si es igual/anterior al año pedido y cercano; penalización fuerte si
    // es POSTERIOR (no puede ser). Sin tag → neutral (0), no queremos castigar a los que no lo traen.
    const ly = lineaAnioParana(nom);
    let yearScore = 0;
    if (ly != null && anioNum) yearScore = (ly > anioNum) ? (-1000 - (ly - anioNum)) : (50 - (anioNum - ly));
    const sc = exact * 100000 + headMatch * 10000 + rest * 100 + yearScore;
    return { x, headMatch, sc };
  }).filter(o => o.headMatch === 1)   // sin modelo que matchee no hay candidato (mejor null → WhatsApp)
    .sort((a, b) => b.sc - a.sc);
  return scored.slice(0, maxN || 6).map(o => mk(o.x));
}

// Compatibilidad: devuelve el mejor candidato (o null).
function buscarVehiculo(marca, textoModelo, anio) {
  const r = rankearVehiculos(marca, textoModelo, anio, 1);
  return r.length ? r[0] : null;
}

function construirSoap(dat, veh, bonifOverride) {
  const cp = String(dat.cp || '').replace(/\D/g, '') || '1636';
  const anio = parseInt(dat.anio, 10) || new Date().getFullYear();
  const bonif = bonifOverride != null ? bonifOverride : BONIFICACION; // permite forzar 0 en el reintento
  // Campos EXACTAMENTE como el ejemplo oficial de Paraná (termina en PoseeEquipoGNC).
  // Los campos extra del WSDL (TipoUso, accesorios, adicionales) el ejemplo NO los manda → se omiten.
  const T = [
    ['SistemaOrigen', esc(SISTEMA_ORIGEN)],
    ['Rama', esc(RAMA)],
    ['TipoPolizaCodigo', esc(TIPO_POLIZA)],
    ['TomadorNombre', esc(dat.nombre || 'Persona Prueba CF')],
    ['TomadorCUIT', ''],
    ['TomadorTipoPersona', '1'],
    ['TomadoCategoriaIVACodigo', esc(CAT_IVA)],
    ['TomadorIIBBCodigo', ''],
    ['VigenciaDesde', vigenciaDesde()],
    ['ProductorCodigo', esc(PRODUCTOR)],
    ['MonedaCodigo', ''],
    ['PlanComercialCodigo', esc(PLAN)],
    ['FormaPagoCodigo', esc(FORMA_PAGO)],
    ['ModoFacturacionCodigo', esc(MODO_FACT)],
    ['CondicionPagoCodigo', esc(COND_PAGO)],
    ['CodigoPostal', esc(cp)],
    ['SubCodigoPostal', esc(CP_SUB[cp] || '1')], // subcódigo válido del CP (0 lo rechaza Paraná)
    ['MarcaCodigo', esc(veh.codMarca)],
    ['ModeloCodigo', esc(veh.codModelo)],
    ['SubModeloCodigo', '1'],
    ['CeroKM', ''],
    ['AnioFabricacion', String(anio)],
    ['SumaAsegurada', ''],
    ['ClausulaAjusteCodigo', ''],
    ['AdicionalGranizoCodigo', ''],
    ['PoseeEquipoRastreo', ''],
    ['EquipoRastreoCodigo', ''],
    ['PoseeEquipoGNC', dat.gnc === 'si' ? 'S' : ''],
    // Bonificación (descuento comercial). ModificarBonificacion='S' habilita aplicar BonificacionPorc.
    ['ModificarBonificacion', Number(bonif) > 0 ? 'S' : ''],
    ['ModificarRecargoAdministrativo', ''],
    ['BonificacionPorc', String(Number(bonif) || 0)],
    ['RecargoAdministrativoPorc', '0']
  ];
  const campos = T.map(([k, v]) => '<tem:' + k + '>' + v + '</tem:' + k + '>').join('');
  return '<?xml version="1.0" encoding="utf-8"?>'
    + '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:tem="http://tempuri.org/">'
    + '<soapenv:Header/><soapenv:Body>'
    + '<tem:WSCotizarAutomotores.Execute>'
    + '<tem:Entserviciocotizacionautomotores>' + campos + '</tem:Entserviciocotizacionautomotores>'
    + '</tem:WSCotizarAutomotores.Execute>'
    + '</soapenv:Body></soapenv:Envelope>';
}

// Lee el valor de un tag (ignora el prefijo de namespace).
function tag(frag, nombre) {
  const m = frag.match(new RegExp('<(?:[\\w-]+:)?' + nombre + '\\b[^>]*>([\\s\\S]*?)</(?:[\\w-]+:)?' + nombre + '>', 'i'));
  return m ? m[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim() : '';
}
function num(s) { return Number(String(s).replace(/\s/g, '').replace(/\.(?=\d{3}\b)/g, '').replace(',', '.')) || 0; }

// Clasifica una cobertura de Paraná. Jerarquía Paraná:
//   Oro / Platino = Terceros Completo con MÁS detalle · C8 > C4 > C0 = Terceros Completo
//     → todos van a "Terceros Completo" (flagship); el frontend muestra el más caro/completo
//   D* = Todo Riesgo · A0 = RC · B0/B1 (total parcial) = ocultos
// Se detecta por NOMBRE (Oro/Platino/Todo Riesgo) y, si no, por la letra del código.
function grupoParana(codigo, desc) {
  const c = (codigo || '').toUpperCase().trim();
  const d = (desc || '').toUpperCase();
  if (/TODO\s*RIESGO/.test(d)) return 'todoriesgo';
  if (/\bORO\b|\bPLATINO\b/.test(d)) return 'flagship'; // Terceros Completo premium
  if (!c) return '';
  if (c[0] === 'A') return 'rc';
  if (c[0] === 'D') return 'todoriesgo';
  if (c[0] === 'C') return 'flagship'; // Terceros Completo (C8/C4/C0); gana el más caro = el más completo
  return 'otro'; // B0/B1 (total parcial)
}

// Parseo según el WSDL: Salserviciocotizacionautomotores → Coberturas → Cobertura[]
//   cada Cobertura: <Cobertura> (código), <CoberturaDesc>/<CoberturaDsc> (texto), <Premio>, <SumaAsegurada>.
//   La suma asegurada del vehículo viene a nivel general en <ValorAseguradoVehic>.
// Devuelve { opciones, errores }.
function parsearRespuesta(xml) {
  const valorVehic = num(tag(xml, 'ValorAseguradoVehic')); // suma asegurada del vehículo (general)
  const errores = [];
  // Errores / Excepciones que puede devolver Paraná
  const errRe = /<(?:[\w-]+:)?Error\b[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?Error>/gi;
  let em;
  while ((em = errRe.exec(xml)) !== null) {
    const d = tag(em[1], 'Descripcion');
    if (d) errores.push(d);
  }
  const excRe = /<(?:[\w-]+:)?Excepcion\b[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?Excepcion>/gi;
  let xm;
  while ((xm = excRe.exec(xml)) !== null) {
    const d = tag(xm[1], 'Detalle');
    if (d) errores.push(d);
  }

  const out = [];
  // El contenedor <Cobertura> anida OTRO <Cobertura> (el código) → mismo nombre. Anclamos por <Item>:
  // cada cobertura tiene exactamente un <Item>, así que partimos por él y leemos los campos de cada bloque.
  const bloques = xml.split(/<(?:[\w-]+:)?Item\b[^>]*>/i).slice(1);
  for (const frag of bloques) {
    const cod = tag(frag, 'Cobertura');            // <Cobertura>A</Cobertura> (Cobertura\b no matchea CoberturaDesc)
    const desc = tag(frag, 'CoberturaDesc') || tag(frag, 'CoberturaDsc');
    const premio = num(tag(frag, 'Premio'));
    const suma = num(tag(frag, 'SumaAsegurada')) || valorVehic; // suma por cobertura o la general del vehículo
    const cuota = num(tag(frag, 'ImporteCuota1'));
    if (premio > 0 || cuota > 0) {
      out.push({ plan: cod || '', cobertura: desc || cod || 'Cobertura', premio: premio || cuota, suma, grupo: grupoParana(cod, desc) });
    }
  }
  out.sort((a, b) => a.premio - b.premio);
  return { opciones: out, errores };
}

async function cotizarSoap(xmlBody) {
  const resp = await fetch(COTIZAR_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/xml; charset=utf-8', 'SOAPAction': SOAP_ACTION },
    body: xmlBody
  });
  const text = await resp.text();
  return { status: resp.status, text };
}

// Cotiza UN vehículo y, si el origen no admite modificar la bonificación (error típico), reintenta
// sin bonificación. Devuelve { xml, r, opciones, errores, reintento }.
async function cotizarUnVehiculo(dat, veh) {
  let xml = construirSoap(dat, veh);
  let r = await cotizarSoap(xml);
  let p = parsearRespuesta(r.text || '');
  const bonifRechazada = p.errores.some(e => /bonific/i.test(e));
  let reintento = false;
  if (!p.opciones.length && bonifRechazada && Number(BONIFICACION) > 0) {
    reintento = true;
    xml = construirSoap(dat, veh, 0); // sin bonificación
    r = await cotizarSoap(xml);
    p = parsearRespuesta(r.text || '');
  }
  return { xml, r, opciones: p.opciones, errores: p.errores, reintento };
}

// El error "relación vehículo - año no válida" (o similar) significa que ESE modelo no corresponde
// al año pedido → probamos el siguiente candidato (ej. Gol viejo → Gol Trend).
function esErrorDeAnioOVehiculo(errores) {
  return (errores || []).some(e => /a[ñn]o|vehículo|vehiculo|no es v[áa]lida|no v[áa]lida|relaci[óo]n/i.test(e));
}

// Recibe UNO o VARIOS candidatos y devuelve el primero que cotiza. Si un candidato falla por
// relación vehículo-año (o no trae opciones), prueba el siguiente. Guarda el último resultado por
// si ninguno cotiza (para reportar el error real).
async function cotizarConReintento(dat, candidatos) {
  const lista = (Array.isArray(candidatos) ? candidatos : [candidatos]).filter(Boolean);
  let ultimo = null;
  for (const veh of lista) {
    const res = await cotizarUnVehiculo(dat, veh);
    res.veh = veh;
    if (res.opciones.length) return res;                 // cotizó → listo
    ultimo = res;
    // Sólo seguimos probando si el error es de vehículo-año o no hubo error explícito (sin opciones).
    if (!(esErrorDeAnioOVehiculo(res.errores) || res.errores.length === 0)) break;
  }
  return ultimo || { xml: '', r: { status: 0, text: '' }, opciones: [], errores: [], reintento: false, veh: null };
}

exports.handler = async function (event) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  // ── DEBUG: /.netlify/functions/parana-cot?debug=1[&marca=&modelo=&anio=&cp=]
  if (event.httpMethod === 'GET' && (event.queryStringParameters || {}).debug) {
    const q = event.queryStringParameters || {};
    const dbg = { _debug: true, env: {
      PARANA_SISTEMA_ORIGEN: !!SISTEMA_ORIGEN, PARANA_PRODUCTOR: !!PRODUCTOR, PLAN, BASE,
      PARANA_VIGENCIA_DESDE: process.env.PARANA_VIGENCIA_DESDE || null, vigenciaQueSeEnvia: vigenciaDesde()
    } };
    try {
      const marca = q.marca || 'Chevrolet', modelo = q.modelo || 'Corsa', anio = q.anio || '2015';
      const candidatos = rankearVehiculos(marca, modelo, anio, 5);
      dbg.candidatos = candidatos;   // todos los que se van a probar, mejor primero
      if (!candidatos.length) { dbg.nota = 'vehículo no encontrado en parana_vehiculos.js'; return { statusCode: 200, headers, body: JSON.stringify(dbg) }; }
      const cr = await cotizarConReintento({ marca, modelo, anio, cp: q.cp || '1636' }, candidatos);
      dbg.vehiculoQueCotizo = cr.veh;   // cuál de los candidatos aceptó Paraná
      dbg.soapEnviado = cr.xml;
      dbg.reintentoSinBonificacion = cr.reintento;
      dbg.httpStatus = cr.r.status;
      dbg.respuestaRaw = (cr.r.text || '').slice(0, 6000);
      dbg.opcionesParseadas = cr.opciones;
      dbg.erroresParana = cr.errores;
    } catch (e) { dbg.error = e.message; }
    return { statusCode: 200, headers, body: JSON.stringify(dbg) };
  }

  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Método no permitido' }) };

  let dat;
  try { dat = JSON.parse(event.body || '{}'); }
  catch (e) { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Body inválido' }) }; }

  try {
    if (!SISTEMA_ORIGEN || !PRODUCTOR) {
      return { statusCode: 200, headers, body: JSON.stringify({ error: 'Paraná no configurado (PARANA_SISTEMA_ORIGEN / PARANA_PRODUCTOR).', opciones: [] }) };
    }
    const candidatos = rankearVehiculos(dat.marca, dat.modelo, dat.anio, 5);
    if (!candidatos.length) return { statusCode: 200, headers, body: JSON.stringify({ error: 'No se encontró el vehículo en la base de Paraná', opciones: [] }) };

    const cr = await cotizarConReintento(dat, candidatos);
    if (cr.r.status < 200 || cr.r.status >= 300) {
      return { statusCode: 200, headers, body: JSON.stringify({ error: 'Paraná HTTP ' + cr.r.status, opciones: [] }) };
    }
    const { opciones, errores } = cr;
    if (!opciones.length) {
      const msg = errores.length ? ('Paraná: ' + errores[0]) : 'Sin opciones de Paraná para este vehículo';
      return { statusCode: 200, headers, body: JSON.stringify({ error: msg, opciones: [] }) };
    }
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, opciones }) };
  } catch (e) {
    return { statusCode: 200, headers, body: JSON.stringify({ error: 'No se pudo cotizar con Paraná: ' + e.message, opciones: [] }) };
  }
};
