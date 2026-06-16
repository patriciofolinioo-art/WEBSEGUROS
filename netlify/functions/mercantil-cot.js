// ============================================================================
//  mercantil-cot.js  ·  Netlify Function para la WEB PÚBLICA
//  Cotizador online de Mercantil Andina (solo cotización, NO emisión)
//
//  Devuelve el MISMO formato que provincia-cot:
//      { ok:true, opciones:[{ plan, cobertura, premio, suma }] }  ó  { error }
//  para que el cotizador del front (CO_CIAS) sume Mercantil junto a Provincia.
//
//  API: api-cotiza-auto v2  (OpenAPI provisto por Mercantil)
//  Base DEV: https://apidev.mercantilandina.com.ar/cotizaciones/v2
//
//  ⚠️ SEGURIDAD: credenciales en variables de entorno de Netlify, nunca acá.
//  Configurar en Netlify → Site settings → Environment variables:
//      MERCANTIL_LOGIN_URL   = (URL del login que devuelve el token)  ← CONFIRMAR
//      MERCANTIL_USER        = (usuario para el login basic auth)
//      MERCANTIL_PASS        = (contraseña para el login basic auth)
//      MERCANTIL_SUBKEY      = (Ocp-Apim-Subscription-Key del producto)
//      MERCANTIL_PRODUCTOR   = (id de productor, ej. 87165)
// ============================================================================

// Base de la API de cotización. Cambiar a producción cuando esté lista.
const BASE        = 'https://apidev.mercantilandina.com.ar/cotizaciones/v2';
const COTIZAR_URL = BASE + '/auto';
// URL del login (basic auth → token). Se toma de env; dejamos un default por las dudas.
const LOGIN_URL   = process.env.MERCANTIL_LOGIN_URL || 'https://apidev.mercantilandina.com.ar/auth/v1/login';

// ── Parámetros comerciales (igual que en el portal) ──
const COMISION     = 20; // % de comisión del productor (se mantiene en 20)
const BONIFICACION = 25; // % de descuento/bonificación que aplica el productor (igual al portal)

// Uso del vehículo en Mercantil: 1 = Particular (por defecto)
const USO_PARTICULAR = 1;
const USO_COMERCIAL  = 2; // ← CONFIRMAR código real de uso comercial

async function getToken() {
  const user = process.env.MERCANTIL_USER;
  const pass = process.env.MERCANTIL_PASS;
  const sub  = process.env.MERCANTIL_SUBKEY;
  if (!user || !pass) throw new Error('Credenciales Mercantil no configuradas (MERCANTIL_USER / MERCANTIL_PASS).');
  if (!sub) throw new Error('Falta MERCANTIL_SUBKEY (Ocp-Apim-Subscription-Key).');

  // Login con Basic Auth → token. La API indica: "Token generado con login con método basic auth".
  const basic = Buffer.from(user + ':' + pass).toString('base64');
  const resp = await fetch(LOGIN_URL, {
    method: 'POST',
    headers: {
      'Authorization': 'Basic ' + basic,
      'Ocp-Apim-Subscription-Key': sub,
      'Content-Type': 'application/json'
    }
  });
  if (!resp.ok) {
    const txt = await resp.text().catch(() => '');
    throw new Error('Login Mercantil falló (' + resp.status + '). ' + txt.slice(0, 160));
  }
  // El token puede venir como texto plano o dentro de un JSON. Contemplamos ambos.
  const raw = await resp.text();
  let token = '';
  try {
    const j = JSON.parse(raw);
    token = j.token || j.access_token || j.accessToken || j.jwt || j.id_token || '';
  } catch (e) {
    token = raw.trim(); // respuesta en texto plano
  }
  if (!token) throw new Error('No se obtuvo token de Mercantil.');
  return token.replace(/^Bearer\s+/i, '');
}

function construirPayload(datos, infoauto) {
  const uso = datos.uso === 'comercial' ? USO_COMERCIAL : USO_PARTICULAR;
  return {
    "localidad": { "codigo_postal": Number(datos.cp) || 1642 },
    "vehiculo": {
      "infoauto": Number(infoauto),
      "anio": Number(datos.anio) || new Date().getFullYear(),
      "uso": uso,
      "gnc": datos.gnc === 'si',
      "rastreo": 0
    },
    "comision": COMISION,
    "bonificacion": BONIFICACION,
    "periodo": 1,
    "cuotas": 1,
    "pago": { "tipo_pago": "D" },
    "iva": 5,            // 5 = Consumidor Final
    "desglose": true,
    "productor": { "id": Number(process.env.MERCANTIL_PRODUCTOR) || 0 }
  };
}

// Convierte el resultado de Mercantil al formato del cotizador
function parsearResultado(cotData) {
  const sumaVeh = Number(cotData.suma_asegurada) || (cotData.vehiculo && Number(cotData.vehiculo.valor)) || 0;
  const opciones = [];
  (cotData.resultado || []).forEach(item => {
    if (item.error) return;                 // cobertura no cotizable
    const premio = Number(item.desglose && item.desglose.total && item.desglose.total.premio) || Number(item.costo) || 0;
    if (premio <= 0) return;
    opciones.push({
      plan: item.producto || '',
      cobertura: item.titulo || item.descripcion || item.texto || '',
      premio,
      suma: sumaVeh
    });
  });
  opciones.sort((a, b) => a.premio - b.premio);
  return opciones;
}

exports.handler = async function(event) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST')    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method Not Allowed' }) };

  try {
    const datos = JSON.parse(event.body || '{}');

    // Mercantil identifica el vehículo por código INFOAUTO (no por la base de Paraná).
    // El front debe mandar datos.infoauto. Si no viene, no podemos cotizar en Mercantil.
    const infoauto = datos.infoauto || datos.infoAuto || datos.codInfoauto;
    if (!infoauto) {
      return { statusCode: 200, headers, body: JSON.stringify({ error: 'Falta código Infoauto del vehículo para Mercantil.' }) };
    }
    if (!datos.anio || !datos.cp) {
      return { statusCode: 200, headers, body: JSON.stringify({ error: 'Faltan datos (año o código postal).' }) };
    }

    const token   = await getToken();
    const payload = construirPayload(datos, infoauto);

    const resp = await fetch(COTIZAR_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + token,
        'Ocp-Apim-Subscription-Key': process.env.MERCANTIL_SUBKEY
      },
      body: JSON.stringify(payload)
    });

    const txt = await resp.text();
    if (!resp.ok) {
      // Errores controlados de Mercantil vienen con HTTP 409 y { errores:[{mensaje_error}] }
      let msg = 'No se pudo cotizar en Mercantil.';
      try { const j = JSON.parse(txt); if (j.errores && j.errores[0]) msg = j.errores[0].mensaje_error || j.errores[0].mensaje || msg; } catch(e) {}
      return { statusCode: 200, headers, body: JSON.stringify({ error: msg, httpStatus: resp.status }) };
    }

    const cotData = JSON.parse(txt);
    const opciones = parsearResultado(cotData);
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, cotId: cotData.id || '', opciones }) };

  } catch (e) {
    return { statusCode: 200, headers, body: JSON.stringify({ error: e.message || 'Error inesperado' }) };
  }
};
