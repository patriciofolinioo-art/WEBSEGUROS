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

const BASE = (process.env.PARANA_BASE || 'http://ws.paranaseguros.com.ar/PARANA_COMERCIAL_PRUE').replace(/\/+$/, '');
const COTIZAR_URL = BASE + '/servlet/ar.com.glmsa.seguros.comercial.awscotizarautomotores';
const SOAP_ACTION = 'http://tempuri.org/WSCotizarAutomotores.Execute';

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

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

// Fecha de vigencia en hora de Argentina (UTC-3), formato YYYYMMDD (ajustar si Paraná pide otro).
function vigenciaDesde() {
  const d = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Argentina/Buenos_Aires', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date());
  return d.replace(/-/g, '');
}

// Resuelve marca + texto de modelo → códigos de Paraná (codMarca / cod del modelo).
function buscarVehiculo(marca, textoModelo) {
  const m = PARANA_VEHIC[(marca || '').trim().toUpperCase()];
  if (!m || !m.modelos) return null;
  const q = (textoModelo || '').toUpperCase();
  const qTokens = q.split(/\s+/).filter(Boolean);
  let mod = m.modelos.find(x => (x.nombre || '').toUpperCase() === q);
  if (!mod) {
    let best = null, bs = -1;
    m.modelos.forEach(x => {
      const nom = (x.nombre || '').toUpperCase();
      const sc = qTokens.reduce((s, t) => s + (nom.includes(t) ? 1 : 0), 0);
      if (sc > bs) { bs = sc; best = x; }
    });
    mod = (best && bs > 0) ? best : null;
  }
  if (!mod) return null;
  return { codMarca: m.codMarca, codModelo: mod.cod, nombre: mod.nombre };
}

function construirSoap(dat, veh) {
  const cp = String(dat.cp || '').replace(/\D/g, '') || '1636';
  return '<?xml version="1.0" encoding="utf-8"?>'
    + '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:tem="http://tempuri.org/">'
    + '<soapenv:Header/><soapenv:Body>'
    + '<tem:WSCotizarAutomotores.Execute>'
    + '<tem:Entserviciocotizacionautomotores>'
    + '<tem:SistemaOrigen>' + esc(SISTEMA_ORIGEN) + '</tem:SistemaOrigen>'
    + '<tem:Rama>' + esc(RAMA) + '</tem:Rama>'
    + '<tem:TipoPolizaCodigo>' + esc(TIPO_POLIZA) + '</tem:TipoPolizaCodigo>'
    + '<tem:TomadorNombre>' + esc(dat.nombre || 'Cliente Web') + '</tem:TomadorNombre>'
    + '<tem:TomadorCUIT></tem:TomadorCUIT>'
    + '<tem:TomadorTipoPersona>1</tem:TomadorTipoPersona>'
    + '<tem:TomadoCategoriaIVACodigo>' + esc(CAT_IVA) + '</tem:TomadoCategoriaIVACodigo>'
    + '<tem:TomadorIIBBCodigo></tem:TomadorIIBBCodigo>'
    + '<tem:VigenciaDesde>' + vigenciaDesde() + '</tem:VigenciaDesde>'
    + '<tem:ProductorCodigo>' + esc(PRODUCTOR) + '</tem:ProductorCodigo>'
    + '<tem:MonedaCodigo></tem:MonedaCodigo>'
    + '<tem:PlanComercialCodigo>' + esc(PLAN) + '</tem:PlanComercialCodigo>'
    + '<tem:FormaPagoCodigo>' + esc(FORMA_PAGO) + '</tem:FormaPagoCodigo>'
    + '<tem:ModoFacturacionCodigo>' + esc(MODO_FACT) + '</tem:ModoFacturacionCodigo>'
    + '<tem:CondicionPagoCodigo>' + esc(COND_PAGO) + '</tem:CondicionPagoCodigo>'
    + '<tem:CodigoPostal>' + esc(cp) + '</tem:CodigoPostal>'
    + '<tem:SubCodigoPostal>00</tem:SubCodigoPostal>'
    + '<tem:MarcaCodigo>' + esc(veh.codMarca) + '</tem:MarcaCodigo>'
    + '<tem:ModeloCodigo>' + esc(veh.codModelo) + '</tem:ModeloCodigo>'
    + '<tem:SubModeloCodigo>1</tem:SubModeloCodigo>'
    + '<tem:CeroKM></tem:CeroKM>'
    + '<tem:AnioFabricacion>' + (parseInt(dat.anio, 10) || '') + '</tem:AnioFabricacion>'
    + '<tem:SumaAsegurada></tem:SumaAsegurada>'
    + '<tem:ClausulaAjusteCodigo></tem:ClausulaAjusteCodigo>'
    + '<tem:AdicionalGranizoCodigo></tem:AdicionalGranizoCodigo>'
    + '<tem:PoseeEquipoRastreo></tem:PoseeEquipoRastreo>'
    + '<tem:EquipoRastreoCodigo></tem:EquipoRastreoCodigo>'
    + '<tem:PoseeEquipoGNC>' + (dat.gnc === 'si' ? 'S' : '') + '</tem:PoseeEquipoGNC>'
    + '</tem:Entserviciocotizacionautomotores>'
    + '</tem:WSCotizarAutomotores.Execute>'
    + '</soapenv:Body></soapenv:Envelope>';
}

// Parseo best-effort del XML de respuesta. Paraná devuelve una lista de coberturas con su premio.
// Se afina cuando veamos el XML real (debug). Busca bloques repetidos con un código de cobertura y un importe.
function parsearRespuesta(xml) {
  const out = [];
  const val = (frag, tags) => {
    for (const t of tags) {
      const m = frag.match(new RegExp('<[^>]*' + t + '[^>]*>\\s*([^<]+?)\\s*</', 'i'));
      if (m && m[1].trim()) return m[1].trim();
    }
    return '';
  };
  // Cada cobertura suele venir como un item/nodo repetido. Probamos varios nombres de contenedor.
  const contRe = /<[^>]*(Cobertura|Item|Coberturas)[^>]*>([\s\S]*?)<\/[^>]*(?:Cobertura|Item|Coberturas)[^>]*>/gi;
  let m;
  while ((m = contRe.exec(xml)) !== null) {
    const frag = m[2];
    const cod = val(frag, ['CoberturaCodigo', 'Codigo', 'Cobertura']);
    const desc = val(frag, ['CoberturaDescripcion', 'Descripcion', 'Detalle']);
    const premioRaw = val(frag, ['Premio', 'PremioTotal', 'Importe', 'PrecioTotal', 'Total']);
    const sumaRaw = val(frag, ['SumaAsegurada', 'Suma']);
    const premio = Number(String(premioRaw).replace(/\./g, '').replace(',', '.')) || 0;
    const suma = Number(String(sumaRaw).replace(/\./g, '').replace(',', '.')) || 0;
    if (premio > 0 && (cod || desc)) {
      out.push({ plan: cod || '', cobertura: desc || cod || 'Cobertura', premio, suma });
    }
  }
  return out.sort((a, b) => a.premio - b.premio);
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
      PARANA_SISTEMA_ORIGEN: !!SISTEMA_ORIGEN, PARANA_PRODUCTOR: !!PRODUCTOR, PLAN, BASE
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
      dbg.respuestaRaw = (r.text || '').slice(0, 5000);
      dbg.opcionesParseadas = parsearRespuesta(r.text || '');
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
    const opciones = parsearRespuesta(r.text || '');
    if (!opciones.length) {
      return { statusCode: 200, headers, body: JSON.stringify({ error: 'Sin opciones de Paraná para este vehículo', opciones: [] }) };
    }
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, opciones }) };
  } catch (e) {
    return { statusCode: 200, headers, body: JSON.stringify({ error: 'No se pudo cotizar con Paraná: ' + e.message, opciones: [] }) };
  }
};
