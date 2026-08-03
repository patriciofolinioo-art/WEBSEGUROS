// ===================== PROXY DIGNA SEGUROS — Cotizador online =====================
// Recibe el mismo _coDat que mandan las otras compañías (nombre, marca, modelo, anio, cp,
// uso, gnc, gnc_monto, nac, genero, ...) y devuelve { opciones:[{plan,cobertura,premio,suma}],
// error? } — mismo contrato que provincia-cot.js / mercantil-cot.js.
//
// Flujo Digna (ver Manual_de_Cotización_API.pdf):
//   1. POST /Seguridad/authenticate            -> Bearer token   (cacheado)
//   2. GET  /Global/obtenervigencias/57         -> idVigencia      (cacheado)
//   3. GET  /Global/obtenerplanescomerciales/.. -> idPlanComercial (cacheado)
//   4. GET  /Global/obtenercodigospostales?..   -> idCodigoPostal
//   5. GET  /Global/obtenertarifas?..           -> idTarifa
//   6. POST /CotizacionAutos/cotizar            -> array de paquetes de cobertura (= opciones)
//
// El código de vehículo (codigoReferencia) se resuelve 100% local contra infoauto.json
// (generado desde el Excel de InfoAuto con build_infoauto.py), sin pegarle a ninguna API.
// Formato: infoauto.json = { "MARCA": [ {n: descripcion, c: codigoReferencia, t: idAutoTipo} ] }

const INFOAUTO = require('./infoauto.json');

// ── TODO: confirmar con tu comercial de Digna cuál es la URL real de testing.
// El PDF tiene AMBAS marcadas como "URL base Desarrollo API" bajo títulos distintos:
//   "Entorno de Testing"    -> https://equiswebtest.digna.seg.ar/dcxapi/api/v1/
//   "Entorno de Desarrollo" -> https://portalweb.digna.seg.ar/dcxapi/api/v1/
const BASE_URL = process.env.DIGNA_BASE_URL || 'https://equiswebtest.digna.seg.ar/dcxapi/api/v1';
const DIGNA_USER = process.env.DIGNA_USER;                    // TODO: completar en Netlify env vars
const DIGNA_PASS = process.env.DIGNA_PASS;                    // TODO
const DIGNA_COD_PRODUCTOR = process.env.DIGNA_COD_PRODUCTOR;  // TODO: "código de conversión del productor"
                                                                // — no aparece en el body de /cotizar del
                                                                // manual; confirmar con tu comercial dónde se usa.

const ID_SECCION_AUTOS = 57;  // 58 = Motovehículos, no usado en este proxy
const ID_PROVINCIA_BA = 2;    // Buenos Aires — fijo por ahora (decisión tomada con Pato)

// ── Valores fijos (confirmar si en algún momento querés ofrecer variantes) ──
const ID_PERSONA_TIPO = 1;     // Física
const ID_CONDICION_FISCAL = 1; // Consumidor Final
const ID_FORMA_COBRO = 1;      // Efectivo (si se ofrece Tarjeta, hay que sumar el descuento 19 obligatorio)
const ID_CLAUSULA_AJUSTE = 2;  // Ajuste Hasta 15% (tabla: 1=20% 2=15% 3=25% 4=30% 7=SinAjuste). Igual al portal.
const ID_AUTO_ORIGEN = 1;      // Nacional (no viene en el Excel, default fijo)

// La vigencia tiene que arrancar el día de la cotización (no puede ser pasada) y dura 1 año.
function fechasVigencia() {
  // ⚠️ El ambiente de TESTING de Digna exige una fecha FIJA de vigencia (la que ellos definen,
  //    ej. "2026-06-30") — la fecha de hoy la rechaza con "La Vigencia Desde no es válida".
  //    Se setea con la env var DIGNA_VIGENCIA_DESDE. En PRODUCCIÓN se deja vacía y usa la fecha real.
  //    (Netlify corre en UTC; la fecha real se calcula en hora de Argentina para no adelantar el día.)
  const fija = (process.env.DIGNA_VIGENCIA_DESDE || '').trim();
  const vigenciaDesde = /^\d{4}-\d{2}-\d{2}$/.test(fija) ? fija : new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Argentina/Buenos_Aires', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date()); // "YYYY-MM-DD" en hora de Argentina
  // +1 año usando mediodía UTC (evita corrimientos de fecha y normaliza 29/02).
  const hasta = new Date(vigenciaDesde + 'T12:00:00Z');
  hasta.setUTCFullYear(hasta.getUTCFullYear() + 1);
  const vigenciaHasta = hasta.toISOString().slice(0, 10);
  return { vigenciaDesde, vigenciaHasta };
}

// ───────────────────────── Cache en memoria (vida del contenedor lambda) ─────────────────────────
let _cache = {
  token: null, tokenExp: 0,
  idVigencia: null, idPlanComercial: null, planExp: 0
};
const TOKEN_TTL_MS = 8 * 60 * 1000;   // 8 min, conservador — TODO: ajustar según la duración real
const PLAN_TTL_MS = 60 * 60 * 1000;   // 1 hora — vigencia/plan comercial casi no cambian

async function dignaFetch(path, { method = 'GET', headers = {}, body } = {}) {
  const resp = await fetch(BASE_URL + path, {
    method,
    headers: Object.assign({ 'Content-Type': 'application/json' }, headers),
    body: body ? JSON.stringify(body) : undefined
  });
  const json = await resp.json().catch(() => null);
  if (!resp.ok || (json && json.error)) {
    let detalle = (json && json.error) || '';
    if (detalle && typeof detalle === 'object') detalle = JSON.stringify(detalle);
    throw new Error('Digna ' + path + ' -> HTTP ' + resp.status + ' ' + detalle);
  }
  if (json === null) throw new Error('Digna ' + path + ' -> respuesta no es JSON válido');
  return json;
}

async function getToken() {
  if (_cache.token && Date.now() < _cache.tokenExp) return _cache.token;
  const json = await dignaFetch('/Seguridad/authenticate', {
    method: 'POST',
    body: { usuarioName: DIGNA_USER, password: DIGNA_PASS }
  });
  // El manual dice: "session_token: Bearer Token que se usará para todas las consultas"
  // TODO: confirmar si session_token ya incluye el prefijo "Bearer " o hay que agregarlo.
  const token = json.payload && json.payload.session_token;
  if (!token) throw new Error('Digna authenticate: no se obtuvo session_token. Respuesta: ' + JSON.stringify(json).slice(0, 200));
  _cache.token = token;
  _cache.tokenExp = Date.now() + TOKEN_TTL_MS;
  return _cache.token;
}

async function authHeaders() {
  const token = await getToken();
  const value = /^Bearer /i.test(token) ? token : ('Bearer ' + token);
  return { 'Authorization': value };
}

// Vigencia + Plan Comercial cacheados juntos (casi no cambian).
// No toda vigencia tiene planes comerciales asociados (confirmado en testing: la "BIMESTRAL (1 CUOTA)"
// no tenía ninguno) — por eso probamos hasta encontrar la primera que sí tenga, priorizando "MENSUAL (1 CUOTA)".
async function getVigenciaYPlan(headers) {
  if (_cache.idVigencia && _cache.idPlanComercial && Date.now() < _cache.planExp) {
    return { idVigencia: _cache.idVigencia, idPlanComercial: _cache.idPlanComercial };
  }
  const vigencias = await dignaFetch('/Global/obtenervigencias/' + ID_SECCION_AUTOS, { headers });
  const lista = vigencias.payload || [];
  const ordenadas = [
    ...lista.filter(v => /MENSUAL \(1 CUOTA\)/i.test(v.Descripcion)),
    ...lista.filter(v => !/MENSUAL \(1 CUOTA\)/i.test(v.Descripcion))
  ];

  for (const candidata of ordenadas) {
    const planes = await dignaFetch('/Global/obtenerplanescomerciales/' + ID_SECCION_AUTOS + '/' + candidata.IdVigencia, { headers });
    const plan = (planes.payload || [])[0];
    if (plan) {
      _cache.idVigencia = candidata.IdVigencia;
      _cache.idPlanComercial = plan.IdPlanComercial;
      _cache.planExp = Date.now() + PLAN_TTL_MS;
      return { idVigencia: _cache.idVigencia, idPlanComercial: _cache.idPlanComercial };
    }
  }
  throw new Error('Ninguna vigencia tiene planes comerciales asociados');
}

async function getCodigoPostal(cp, headers) {
  const url = '/Global/obtenercodigospostales?Codigo=' + encodeURIComponent(cp) + '&IdProvincia=' + ID_PROVINCIA_BA;
  const json = await dignaFetch(url, { headers });
  const item = (json.payload || [])[0];
  if (!item) throw new Error('No se encontró el código postal ' + cp + ' en Buenos Aires');
  return item.IdCodigoPostal;
}

async function getTarifa(idVigencia, idCodigoPostal, headers) {
  const url = '/Global/obtenertarifas?IdSeccion=' + ID_SECCION_AUTOS + '&IdVigencia=' + idVigencia + '&IdCodigoPostal=' + idCodigoPostal;
  const json = await dignaFetch(url, { headers });
  const item = (json.payload || [])[0];
  if (!item) throw new Error('No se encontró tarifa para ese código postal');
  return item.IdTarifa;
}

// Busca el codigoReferencia (InfoAuto) y el idAutoTipo por marca + texto de versión.
// TODO: confirmar que el texto que mandás como "modelo" desde el form se parece lo
// suficiente a la Descripcion de InfoAuto como para que el matching funcione bien.
function buscarVehiculoInfoAuto(marca, textoVersion) {
  const lista = INFOAUTO[(marca || '').trim().toUpperCase()];
  if (!lista || !lista.length) return null;
  const q = (textoVersion || '').toUpperCase();
  const qTokens = q.split(/\s+/).filter(Boolean);

  const exacto = lista.find(it => it.n.toUpperCase() === q);
  if (exacto) return exacto;

  let mejor = null, mejorScore = -1;
  lista.forEach(it => {
    const nom = it.n.toUpperCase();
    const score = qTokens.reduce((s, t) => s + (nom.includes(t) ? 1 : 0), 0);
    if (score > mejorScore) { mejorScore = score; mejor = it; }
  });
  // Solo devolver si al menos un token coincidió; si ninguno coincide, es un falso match.
  return (mejor && mejorScore > 0) ? mejor : null;
}

function mapUso(uso) {
  return uso === 'comercial' ? 2 : 1; // 1 Particular / 2 Comercial o Carga
}

// Clasifica un paquete de Digna por su código de letra (esquema Digna) + sus coberturas incluidas.
//   A* (A / AS)                     -> RC (los 2 se muestran)
//   C* con "granizo" en los items   -> Terceros Completo Full (flagship que se muestra)
//   D*                              -> Todo Riesgo (todas se muestran)
//   resto (B*, C* sin granizo)      -> intermedios -> ocultos
function grupoDigna(codigo, items) {
  const c = (codigo || '').toUpperCase().trim();
  if (!c) return ''; // sin código → dejamos que el frontend clasifique por texto (fallback seguro)
  if (c[0] === 'A') return 'rc';
  if (c[0] === 'D') return 'todoriesgo';
  if (c[0] === 'C') {
    const tieneGranizo = (items || []).some(it =>
      /GRANIZO/i.test(it && (it.descripcion || it.Descripcion || '')) || it && it.id === 450);
    return tieneGranizo ? 'flagship' : 'otro';
  }
  return 'otro';
}

// Corre todo el circuito de cotización de Digna y devuelve el resultado crudo + lo enviado.
async function correrCotizacion(dat) {
  // Si el frontend ya resolvió el código InfoAuto (selector nuevo), lo usamos DIRECTO (exacto).
  // Si no, caemos al match por texto (compatibilidad).
  const veh = dat.infoautoCod
    ? { c: dat.infoautoCod, t: (dat.infoautoTipo != null ? dat.infoautoTipo : 1) }
    : buscarVehiculoInfoAuto(dat.marca, dat.modelo);
  if (!veh) return { error: 'No se encontró el vehículo en InfoAuto' };

  const headers = await authHeaders();
  const { idVigencia, idPlanComercial } = await getVigenciaYPlan(headers);
  const idCodigoPostal = await getCodigoPostal(dat.cp, headers);
  const idTarifa = await getTarifa(idVigencia, idCodigoPostal, headers);
  const { vigenciaDesde, vigenciaHasta } = fechasVigencia();

  const payload = {
    idSeccion: ID_SECCION_AUTOS,
    idVigencia,
    vigenciaDesde,
    vigenciaHasta,
    idPlanComercial,
    cantidadCuotas: 1,
    idProvincia: ID_PROVINCIA_BA,
    idCodigoPostal,
    codigoPostal: parseInt(dat.cp, 10),
    idTarifa,
    idPersonaTipo: ID_PERSONA_TIPO,
    idSexo: dat.genero === 'F' ? 2 : 1, // 1=Hombre, 2=Mujer (co_genero manda M/F/X)
    entidadPublica: false,
    fechaNacimiento: dat.nac || '1990-01-01',
    idCondicionFiscal: ID_CONDICION_FISCAL,
    solicitante: dat.nombre || 'Cliente Web',
    idFormaCobro: ID_FORMA_COBRO,
    anio: parseInt(dat.anio, 10) || 0,
    codigoReferencia: veh.c,
    idAutoTipo: veh.t,
    idAutoUso: mapUso(dat.uso),
    idClausulaAjuste: ID_CLAUSULA_AJUSTE,
    idAutoOrigen: ID_AUTO_ORIGEN,
    idAutoCombustible: dat.gnc === 'si' ? 3 : 1, // 3 GNC / 1 Nafta
    valorVehiculo: 0,
    es0km: false,
    rastreadorSat: false,
    rastreadorSatPropio: false,
    accesorios: [],
    // Configuración comercial igual al portal: descuento 5% + recargo 20% (15%+5%).
    // (El recargo 25% apilando 42+82 hacía que Digna rechazara la cotización → se volvió a 42+50.)
    // Códigos del manual de Digna (mismo campo idDescuento sirve para descuentos y recargos):
    //   Descuentos: 25=10% · 26=15% · 29=20% · 24=5% · 19=Tarjeta5%(oblig)
    //   Recargos:   50=5% · 82=10% · 42=15%
    descuentosPoliza: [
      { idDescuento: 24 }, // Descuento 5%
      { idDescuento: 42 }, // Recargo 15%  ┐ = recargo 20%
      { idDescuento: 50 }  // Recargo 5%   ┘
    ]
  };

  const resultado = await dignaFetch('/CotizacionAutos/cotizar', { method: 'POST', headers, body: payload });
  return { veh, payload, resultado };
}

// Mapea el payload crudo de Digna a nuestro contrato { plan, cobertura, premio, suma, grupo }.
// Acepta los nombres reales de la API (descripcion/codigo/valor/premioTotal/items) con fallbacks.
function mapearOpciones(resultado) {
  const items = (resultado && resultado.payload) || [];
  return items.map(it => {
    const codigo = it.codigo || it.Codigo || it.CoberturaPaqueteCodigo || '';
    const desc = it.descripcion || it.Descripcion || it.CoberturaPaqueteDetalle || it.CoberturaPaquete || '';
    const premio = Number(it.premioTotal || it.PremioTotal || it.valor || it.ValorCuota || it.Premio || 0) || 0;
    const suma = Number(it.sumaAsegurada || it.SumaAsegurada || 0) || 0;
    return {
      plan: (codigo || desc).toString().trim(),
      cobertura: (desc || codigo).toString().trim(),
      premio,
      suma,
      grupo: grupoDigna(codigo, it.items || it.Items),
      idCoberturaPaquete: it.id || it.IdCoberturaPaquete // para /CotizacionAutos/generar más adelante
    };
  });
}

exports.handler = async function (event) {
  const headersCors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: headersCors, body: '' };

  // ── DEBUG: /.netlify/functions/digna-cot?debug=1[&marca=&modelo=&anio=&cp=]
  // Devuelve el payload CRUDO de Digna + cómo lo mapeamos (para verificar nombres de campo y códigos).
  if (event.httpMethod === 'GET' && (event.queryStringParameters || {}).debug) {
    const q = event.queryStringParameters || {};
    const dat = { marca: q.marca || 'Chevrolet', modelo: q.modelo || 'Cruze', anio: q.anio || '2018', cp: q.cp || '1636', genero: 'M' };
    const dbg = { _debug: true, env: {
      DIGNA_VIGENCIA_DESDE: process.env.DIGNA_VIGENCIA_DESDE || null,
      fechasQueSeEnvian: fechasVigencia()
    } };
    try {
      const r = await correrCotizacion(dat);
      if (r.error) { dbg.error = r.error; }
      else {
        dbg.vehiculo = r.veh;
        dbg.payloadCrudo = (r.resultado && r.resultado.payload || []).slice(0, 20);
        dbg.opcionesMapeadas = mapearOpciones(r.resultado);
      }
    } catch (e) { dbg.error = e.message; }
    return { statusCode: 200, headers: headersCors, body: JSON.stringify(dbg) };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: headersCors, body: JSON.stringify({ error: 'Método no permitido' }) };
  }

  let dat;
  try { dat = JSON.parse(event.body || '{}'); }
  catch (e) { return { statusCode: 400, headers: headersCors, body: JSON.stringify({ error: 'Body inválido' }) }; }

  try {
    const r = await correrCotizacion(dat);
    if (r.error) {
      return { statusCode: 200, headers: headersCors, body: JSON.stringify({ error: r.error, opciones: [] }) };
    }
    const opciones = mapearOpciones(r.resultado);
    if (!opciones.length) {
      return { statusCode: 200, headers: headersCors, body: JSON.stringify({ error: 'Sin opciones de Digna para este vehículo', opciones: [] }) };
    }
    return { statusCode: 200, headers: headersCors, body: JSON.stringify({ opciones }) };
  } catch (e) {
    return { statusCode: 200, headers: headersCors, body: JSON.stringify({ error: 'No se pudo cotizar con Digna: ' + e.message, opciones: [] }) };
  }
};
