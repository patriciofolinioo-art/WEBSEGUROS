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
const ID_CLAUSULA_AJUSTE = 7;  // Sin Ajuste 0%
const ID_AUTO_ORIGEN = 1;      // Nacional (no viene en el Excel, default fijo)

// La vigencia tiene que arrancar el día de la cotización (no puede ser pasada) y dura 1 año.
function fechasVigencia() {
  const hoy = new Date();
  const vigenciaDesde = hoy.toISOString().slice(0, 10);
  const en1Anio = new Date(hoy);
  en1Anio.setFullYear(en1Anio.getFullYear() + 1);
  const vigenciaHasta = en1Anio.toISOString().slice(0, 10);
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
    const detalle = (json && json.error) || '';
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

exports.handler = async function (event) {
  const headersCors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: headersCors, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: headersCors, body: JSON.stringify({ error: 'Método no permitido' }) };
  }

  let dat;
  try { dat = JSON.parse(event.body || '{}'); }
  catch (e) { return { statusCode: 400, headers: headersCors, body: JSON.stringify({ error: 'Body inválido' }) }; }

  try {
    const veh = buscarVehiculoInfoAuto(dat.marca, dat.modelo);
    if (!veh) {
      return { statusCode: 200, headers: headersCors, body: JSON.stringify({ error: 'No se encontró el vehículo en InfoAuto', opciones: [] }) };
    }

    const headers = await authHeaders();
    const { idVigencia, idPlanComercial } = await getVigenciaYPlan(headers);
    const idCodigoPostal = await getCodigoPostal(dat.cp, headers);
    const idTarifa = await getTarifa(idVigencia, idCodigoPostal, headers);

    const { vigenciaDesde, vigenciaHasta } = fechasVigencia();

    const payload = {
      idSeccion: ID_SECCION_AUTOS,
      idVigencia: idVigencia,
      vigenciaDesde,
      vigenciaHasta,
      idPlanComercial: idPlanComercial,
      cantidadCuotas: 1,
      idProvincia: ID_PROVINCIA_BA,
      idCodigoPostal: idCodigoPostal,
      codigoPostal: parseInt(dat.cp, 10),
      idTarifa: idTarifa,
      idPersonaTipo: ID_PERSONA_TIPO,
      idSexo: dat.genero === 'F' ? 2 : 1, // 1=Hombre, 2=Mujer (co_genero manda M/F/X)
      entidadPublica: false,
      fechaNacimiento: dat.nac || '1990-01-01',  // co_nac llega como "AAAA-06-15" (YYYY-MM-DD) ✓
      idCondicionFiscal: ID_CONDICION_FISCAL,
      solicitante: dat.nombre || 'Cliente Web',
      idFormaCobro: ID_FORMA_COBRO,
      anio: parseInt(dat.anio, 10) || 0,
      codigoReferencia: veh.c,
      idAutoTipo: veh.t,
      idAutoUso: mapUso(dat.uso),
      idClausulaAjuste: ID_CLAUSULA_AJUSTE,
      idAutoOrigen: ID_AUTO_ORIGEN,
      idAutoCombustible: dat.gnc === 'si' ? 3 : 1, // 3 GNC / 1 Nafta — TODO: sumar diesel si se agrega al form
      valorVehiculo: 0,
      es0km: false,
      rastreadorSat: false,
      rastreadorSatPropio: false,
      accesorios: [],
      // Descuento 20% (código 29). Se probó dejarlo SIN descuento (array vacío) para subir el
      // precio, pero Digna NO cotiza con descuentosPoliza vacío → se volvió al 20%. Para subir
      // el precio de verdad hay que pedirle a Digna el código de RECARGO y agregarlo acá.
      descuentosPoliza: [
        { idDescuento: 29 } // 20%
      ]
    };

    const resultado = await dignaFetch('/CotizacionAutos/cotizar', {
      method: 'POST', headers, body: payload
    });

    const items = resultado.payload || [];
    const opciones = items.map(it => ({
      plan: it.CoberturaPaquete || '',
      cobertura: it.CoberturaPaqueteDetalle || it.CoberturaPaqueteCodigo || '',
      premio: it.ValorCuota || it.Premio || 0,
      suma: it.SumaAsegurada || 0,
      idCoberturaPaquete: it.IdCoberturaPaquete // necesario para /CotizacionAutos/generar más adelante
    }));

    if (!opciones.length) {
      return { statusCode: 200, headers: headersCors, body: JSON.stringify({ error: 'Sin opciones de Digna para este vehículo', opciones: [] }) };
    }

    return { statusCode: 200, headers: headersCors, body: JSON.stringify({ opciones }) };
  } catch (e) {
    return { statusCode: 200, headers: headersCors, body: JSON.stringify({ error: 'No se pudo cotizar con Digna: ' + e.message, opciones: [] }) };
  }
};
