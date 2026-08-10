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
//      PARANA_PLAN           = plan comercial (default PLAN1)
//      PARANA_BASE           = (opcional) URL base. Default: PRUE (test).
//      PARANA_RAMA / PARANA_FORMA_PAGO / PARANA_MODO_FACT / PARANA_COND_PAGO = overrides opcionales.
//
//  ⚠️ El manual no trae ejemplo de RESPONSE → el parseo de premios se afina con el debug (?debug=1),
//     que devuelve el XML crudo de Paraná.

const VEH = require('./parana_vehiculos.js');
const PARANA_VEHIC = VEH.PARANA_VEHIC || {};
// CP → SubCódigo postal (de TablasCotizacion). Paraná rechaza SubCodigoPostal 0.
let CP_SUB = {};
try { CP_SUB = require('./parana_cp.json'); } catch (e) { CP_SUB = {}; }

const BASE = (process.env.PARANA_BASE || 'http://ws.paranaseguros.com.ar/PARANA_COMERCIAL_PRUE').replace(/\/+$/, '');
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
const TIPO_USO       = process.env.PARANA_TIPO_USO || '1';   // 1 = Particular (ajustar si Paraná usa otro código)

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

// Resuelve marca + texto de modelo → códigos de Paraná (codMarca / cod del modelo).
function buscarVehiculo(marca, textoModelo) {
  const m = PARANA_VEHIC[(marca || '').trim().toUpperCase()];
  if (!m || !m.modelos) return null;
  const q = (textoModelo || '').toUpperCase();
  // Ignoramos tokens de ruido de la descripción InfoAuto (PTAS, AT, MT, L/XX, nº de puertas).
  const RUIDO = /^(\d+|PTAS?|PUERTAS?|AT|MT|CVT|L\/?\d+|\d+P)$/;
  const qTokens = q.split(/\s+/).filter(t => t && !RUIDO.test(t));
  let mod = m.modelos.find(x => (x.nombre || '').toUpperCase() === q);
  if (!mod) {
    let best = null, bs = 0;
    m.modelos.forEach(x => {
      const nom = (x.nombre || '').toUpperCase();
      const sc = qTokens.reduce((s, t) => s + (nom.includes(t) ? 1 : 0), 0);
      if (sc > bs) { bs = sc; best = x; }
    });
    mod = best; // best solo si bs>0 (al menos un token relevante coincidió)
  }
  if (!mod) return null;
  return { codMarca: m.codMarca, codModelo: mod.cod, nombre: mod.nombre };
}

function construirSoap(dat, veh) {
  const cp = String(dat.cp || '').replace(/\D/g, '') || '1636';
  const anio = parseInt(dat.anio, 10) || new Date().getFullYear();
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
    ['PoseeEquipoGNC', dat.gnc === 'si' ? 'S' : '']
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

// Clasifica una cobertura de Paraná por su código de letra (mismo esquema que Digna/Galicia):
//   A* -> RC · C* -> Terceros Completo (flagship) · D* -> Todo Riesgo · B* (total parcial) -> oculto
function grupoParana(codigo) {
  const c = (codigo || '').toUpperCase().trim();
  if (!c) return '';
  if (c[0] === 'A') return 'rc';
  if (c[0] === 'D') return 'todoriesgo';
  if (c[0] === 'C') return 'flagship';
  return 'otro';
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
      out.push({ plan: cod || '', cobertura: desc || cod || 'Cobertura', premio: premio || cuota, suma, grupo: grupoParana(cod) });
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
      const veh = buscarVehiculo(marca, modelo);
      dbg.vehiculo = veh;
      if (!veh) { dbg.nota = 'vehículo no encontrado en parana_vehiculos.js'; return { statusCode: 200, headers, body: JSON.stringify(dbg) }; }
      const xml = construirSoap({ marca, modelo, anio, cp: q.cp || '1636' }, veh);
      dbg.soapEnviado = xml;
      const r = await cotizarSoap(xml);
      dbg.httpStatus = r.status;
      dbg.respuestaRaw = (r.text || '').slice(0, 6000);
      const p = parsearRespuesta(r.text || '');
      dbg.opcionesParseadas = p.opciones;
      dbg.erroresParana = p.errores;
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
    const veh = buscarVehiculo(dat.marca, dat.modelo);
    if (!veh) return { statusCode: 200, headers, body: JSON.stringify({ error: 'No se encontró el vehículo en la base de Paraná', opciones: [] }) };

    const r = await cotizarSoap(construirSoap(dat, veh));
    if (r.status < 200 || r.status >= 300) {
      return { statusCode: 200, headers, body: JSON.stringify({ error: 'Paraná HTTP ' + r.status, opciones: [] }) };
    }
    const { opciones, errores } = parsearRespuesta(r.text || '');
    if (!opciones.length) {
      const msg = errores.length ? ('Paraná: ' + errores[0]) : 'Sin opciones de Paraná para este vehículo';
      return { statusCode: 200, headers, body: JSON.stringify({ error: msg, opciones: [] }) };
    }
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, opciones }) };
  } catch (e) {
    return { statusCode: 200, headers, body: JSON.stringify({ error: 'No se pudo cotizar con Paraná: ' + e.message, opciones: [] }) };
  }
};
