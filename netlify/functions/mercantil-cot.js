// ===================== PROXY MERCANTIL ANDINA — Cotizador online =====================
// Recibe el mismo _coDat que manda cotizar.html (nombre, marca, modelo, anio, cp, uso, tel,
// email, via, contacto, modeloProvCod, gnc, gnc_monto, nac, genero) y devuelve
// { opciones:[{plan,cobertura,premio,suma}], error? } — mismo contrato que provincia-cot.js.
//
// Flujo:
//   1) login (basic auth)                         -> Bearer token  (cacheado)
//   2) GET  /vehiculos/v1/?q=...&anio=...&tipo=AUTO -> código de vehículo de Mercantil
//   3) POST /cotizaciones/v2/auto                  -> resultado[] (coberturas con premio)
//
//  ⚠️ SEGURIDAD: credenciales en variables de entorno de Netlify, nunca acá.
//  Netlify → Site settings → Environment variables:
//      MERCANTIL_USER        = usuario del login (basic auth)
//      MERCANTIL_PASS        = contraseña del login
//      MERCANTIL_SUBKEY      = Ocp-Apim-Subscription-Key del producto
//      MERCANTIL_PRODUCTOR   = id de productor (ej. 87165)
//      MERCANTIL_LOGIN_URL   = (opcional) URL del login si difiere del default

const HOST       = 'https://apidev.mercantilandina.com.ar';   // DEV — cambiar a prod cuando esté ok
const VEH_BASE   = HOST + '/vehiculos/v1';
const COTIZAR_URL = HOST + '/cotizaciones/v2/auto';
const LOGIN_URL  = process.env.MERCANTIL_LOGIN_URL || (HOST + '/credenciales/v2');

// ── Parámetros comerciales (igual que en el portal) ──
const COMISION     = 20; // % de comisión del productor (se mantiene en 20)
const BONIFICACION = 25; // % de descuento/bonificación que aplica el productor

// Uso del vehículo en Mercantil: 1 = Particular (por defecto)
const USO_PARTICULAR = 1;
const USO_COMERCIAL  = 2; // ← CONFIRMAR código real de uso comercial

// Cache del token en memoria (vida del contenedor lambda)
let _cache = { token: null, exp: 0 };
const TOKEN_TTL_MS = 8 * 60 * 1000; // 8 min, conservador

async function getToken() {
  if (_cache.token && Date.now() < _cache.exp) return _cache.token;
  const user = process.env.MERCANTIL_USER;
  const pass = process.env.MERCANTIL_PASS;
  const sub  = process.env.MERCANTIL_SUBKEY;
  if (!user || !pass) throw new Error('Credenciales Mercantil no configuradas (MERCANTIL_USER / MERCANTIL_PASS).');
  if (!sub) throw new Error('Falta MERCANTIL_SUBKEY (Ocp-Apim-Subscription-Key).');

  // Login OAuth2 (password grant, estilo Keycloak) → POST /credenciales/v2 con body urlencoded.
  // (Confirmado en la colección Postman oficial de Mercantil: request "Login").
  const body = new URLSearchParams({
    client_id: 'api-clientes-login',
    grant_type: 'password',
    username: user,
    password: pass
  });
  const resp = await fetch(LOGIN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Ocp-Apim-Subscription-Key': sub
    },
    body: body.toString()
  });
  if (!resp.ok) {
    const txt = await resp.text().catch(() => '');
    throw new Error('Login Mercantil HTTP ' + resp.status + ' ' + txt.slice(0, 160));
  }
  const j = await resp.json().catch(() => ({}));
  const token = j.access_token || j.token || '';
  if (!token) throw new Error('No se obtuvo access_token de Mercantil.');
  _cache.token = token;
  _cache.exp = Date.now() + TOKEN_TTL_MS;
  return token;
}

// Headers de auth para todas las llamadas (token + subscription key).
function authHeaders(token) {
  return {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer ' + token,
    'Ocp-Apim-Subscription-Key': process.env.MERCANTIL_SUBKEY
  };
}

function mapUso(uso) {
  return uso === 'comercial' ? USO_COMERCIAL : USO_PARTICULAR;
}

// Busca el código de vehículo de Mercantil por texto libre (marca + modelo) + año.
// Prioriza, si el auto tiene GNC, un resultado cuyo nombre lo mencione; luego match exacto
// de nombre; luego el que más palabras de la búsqueda contenga.
async function buscarCodigoVehiculo(token, marca, modelo, anio, gnc) {
  const q = ((marca || '') + ' ' + (modelo || '')).trim();
  const url = VEH_BASE + '/?q=' + encodeURIComponent(q) + '&anio=' + encodeURIComponent(anio) + '&tipo=AUTO&limit=20';
  const resp = await fetch(url, { method: 'GET', headers: authHeaders(token) });
  if (!resp.ok) {
    const txt = await resp.text().catch(() => '');
    throw new Error('Búsqueda de vehículo HTTP ' + resp.status + ' ' + txt.slice(0, 160));
  }
  const json = await resp.json().catch(() => null);
  const datos = (json && json.datos) || [];
  if (!datos.length) return null;

  const qLower = q.toLowerCase();
  let candidatos = datos;
  if (gnc) {
    const conGnc = datos.filter(d => /gnc/i.test(d.nombre || ''));
    if (conGnc.length) candidatos = conGnc;
  }
  const exacto = candidatos.find(d => (d.nombre || '').toLowerCase() === qLower);
  if (exacto) return exacto.codigo;

  // El nombre trae la línea del modelo como "L/16" o "L|14" (año de la línea). Un auto 2015
  // NO puede ser línea 2016 → Mercantil devuelve MCA204 "Error en llamado Vehiculos". Por eso
  // preferimos la línea cuyo año no sea posterior al pedido y sea la más cercana.
  const anioNum = parseInt(anio, 10) || 0;
  const lineaAnio = (nombre) => {
    const m = (nombre || '').match(/L[\/|](\d{2})/i);
    return m ? 2000 + parseInt(m[1], 10) : null;
  };
  const tokens = qLower.split(/\s+/).filter(Boolean);
  let mejor = candidatos[0], mejorScore = -Infinity;
  candidatos.forEach(d => {
    const nom = (d.nombre || '').toLowerCase();
    const tokenScore = tokens.reduce((s, t) => s + (nom.includes(t) ? 1 : 0), 0);
    const ly = lineaAnio(d.nombre);
    let yearScore = 0;
    if (ly != null && anioNum) {
      // Línea posterior al año pedido: penalización fuerte. Línea igual o anterior: mientras
      // más cerca del año, mejor.
      yearScore = ly > anioNum ? (-100 - (ly - anioNum)) : -(anioNum - ly);
    }
    const score = tokenScore * 10 + yearScore;      // el modelo correcto manda; el año desempata
    if (score > mejorScore) { mejorScore = score; mejor = d; }
  });
  return mejor ? mejor.codigo : null;
}

function construirPayload(dat, vehiculoId) {
  return {
    "localidad": { "codigo_postal": parseInt(dat.cp, 10) || 1642 },
    "vehiculo": {
      "id": Number(vehiculoId),               // código de Mercantil (api-vehiculos)
      "anio": parseInt(dat.anio, 10) || new Date().getFullYear(),
      "uso": mapUso(dat.uso),
      "gnc": dat.gnc === 'si',
      "rastreo": 0
    },
    "comision": COMISION,
    "bonificacion": BONIFICACION,
    "periodo": 1,
    "cuotas": 1,
    "pago": { "tipo_pago": "D" },             // D = débito
    "iva": 5,                                  // 5 = Consumidor Final
    "desglose": true,
    "productor": { "id": Number(process.env.MERCANTIL_PRODUCTOR) || 0 }  // MERCANTIL_PRODUCTOR debe estar configurado
  };
}

function parsearResultado(cotData) {
  const sumaVeh = Number(cotData.suma_asegurada) || (cotData.vehiculo && Number(cotData.vehiculo.valor)) || 0;
  const opciones = [];
  (cotData.resultado || []).forEach(it => {
    if (it.error) return;                       // cobertura no cotizable
    const premio = Number(it.desglose && it.desglose.total && it.desglose.total.premio) || Number(it.costo) || 0;
    if (premio <= 0) return;
    opciones.push({
      plan: it.producto || '',
      cobertura: it.titulo || it.descripcion || it.texto || '',
      premio,
      suma: sumaVeh
    });
  });
  opciones.sort((a, b) => a.premio - b.premio);
  return opciones;
}

exports.handler = async function (event) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  // ── DEBUG temporal: abrir en el navegador
  //    https://sanisidroseguros.com.ar/.netlify/functions/mercantil-cot?debug=1
  //    Muestra el productor.id que se usa, si obtiene token, si encuentra el vehículo y la
  //    respuesta cruda de la cotización. Para verificar el código 15056. QUITAR tras verificar.
  if (event.httpMethod === 'GET' && (event.queryStringParameters || {}).debug) {
    const dbg = {
      _debug: true,
      env: {
        MERCANTIL_USER: !!process.env.MERCANTIL_USER,
        MERCANTIL_PASS: !!process.env.MERCANTIL_PASS,
        MERCANTIL_SUBKEY: !!process.env.MERCANTIL_SUBKEY,
        MERCANTIL_PRODUCTOR: process.env.MERCANTIL_PRODUCTOR || null,
        HOST
      }
    };
    try {
      const q = event.queryStringParameters || {};
      const anio = q.anio || '2015';
      const token = await getToken();
      dbg.tokenObtenido = !!token;
      const vq = ((q.marca || 'Ford') + ' ' + (q.modelo || 'Focus')).trim();
      const vurl = VEH_BASE + '/?q=' + encodeURIComponent(vq) + '&anio=' + encodeURIComponent(anio) + '&tipo=AUTO&limit=20';
      const vresp = await fetch(vurl, { headers: authHeaders(token) });
      const vjson = await vresp.json().catch(() => null);
      const datos = (vjson && vjson.datos) || [];
      const vehId = await buscarCodigoVehiculo(token, q.marca || 'Ford', q.modelo || 'Focus', anio, false);
      const vehObj = datos.find(d => d.codigo === vehId) || datos[0] || null;
      dbg.vehiculoElegido = vehObj;
      // Probamos cotizar con los dos identificadores para ver cuál acepta Mercantil.
      const probar = async (idVeh, etiqueta) => {
        const payloadD = construirPayload({ cp: q.cp || '1642', anio, uso: 'particular', gnc: 'no' }, idVeh);
        const r = await fetch(COTIZAR_URL, { method: 'POST', headers: authHeaders(token), body: JSON.stringify(payloadD) });
        return { etiqueta, id: idVeh, status: r.status, raw: (await r.text()).slice(0, 400) };
      };
      if (vehObj) {
        dbg.pruebaCodigo = await probar(vehObj.codigo, 'codigo (api-vehiculos)');
        if (vehObj.infoauto != null) dbg.pruebaInfoauto = await probar(vehObj.infoauto, 'infoauto');
      }
    } catch (e) { dbg.error = e.message; }
    return { statusCode: 200, headers, body: JSON.stringify(dbg) };
  }

  if (event.httpMethod !== 'POST')    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Método no permitido' }) };

  let dat;
  try { dat = JSON.parse(event.body || '{}'); }
  catch (e) { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Body inválido' }) }; }

  try {
    if (!dat.anio || !dat.cp) {
      return { statusCode: 200, headers, body: JSON.stringify({ error: 'Faltan datos (año o código postal).', opciones: [] }) };
    }
    if (!process.env.MERCANTIL_PRODUCTOR) {
      return { statusCode: 200, headers, body: JSON.stringify({ error: 'MERCANTIL_PRODUCTOR no configurado en el servidor.', opciones: [] }) };
    }

    const token = await getToken();

    let vehiculoId = dat.mercantilId || null;
    if (!vehiculoId) {
      vehiculoId = await buscarCodigoVehiculo(token, dat.marca, dat.modelo, dat.anio, dat.gnc === 'si');
      if (vehiculoId == null) {
        return { statusCode: 200, headers, body: JSON.stringify({ error: 'No se encontró el vehículo en Mercantil Andina', opciones: [] }) };
      }
    }

    const payload = construirPayload(dat, vehiculoId);
    const resp = await fetch(COTIZAR_URL, { method: 'POST', headers: authHeaders(token), body: JSON.stringify(payload) });
    const txt = await resp.text();
    if (!resp.ok) {
      // Errores controlados de Mercantil: HTTP 409 con { errores:[{mensaje_error}] }
      let msg = 'No se pudo cotizar en Mercantil.';
      try { const j = JSON.parse(txt); if (j.errores && j.errores[0]) msg = j.errores[0].mensaje_error || j.errores[0].mensaje || msg; } catch (e) {}
      return { statusCode: 200, headers, body: JSON.stringify({ error: msg, httpStatus: resp.status, opciones: [] }) };
    }

    const cotData = JSON.parse(txt);
    const opciones = parsearResultado(cotData);
    if (!opciones.length) {
      return { statusCode: 200, headers, body: JSON.stringify({ error: 'Sin opciones de Mercantil para este vehículo', opciones: [] }) };
    }
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, cotId: cotData.id || '', opciones }) };

  } catch (e) {
    return { statusCode: 200, headers, body: JSON.stringify({ error: 'No se pudo cotizar con Mercantil Andina: ' + e.message, opciones: [] }) };
  }
};
