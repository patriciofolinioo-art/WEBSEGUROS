// ===================== BÚSQUEDA DE CLIENTE POR DNI (área de clientes) =====================
// Recibe { dni } por POST. Lee sanisidro/datos DEL LADO DEL SERVIDOR (con una service account
// de Firebase) y devuelve SOLO el cliente que matchea + sus pólizas vigentes + las compañías.
// NUNCA expone el resto de la base (otros clientes, mails de productores, etc.).
//
// Mismo estilo que los proxys del cotizador: sin dependencias npm, solo fetch + crypto nativo.
// Usa la REST API de Firestore autenticada con un JWT firmado por la service account.
//
//  ⚠️ SEGURIDAD: la clave de la service account va en variables de entorno de Netlify:
//      Netlify → Site settings → Environment variables:
//        FIREBASE_PROJECT_ID    = base-seguros-f5144  (opcional, ya viene por defecto)
//        FIREBASE_CLIENT_EMAIL  = ...@....iam.gserviceaccount.com  (del JSON de la service account)
//        FIREBASE_PRIVATE_KEY   = -----BEGIN PRIVATE KEY-----\n...  (del JSON; pegar tal cual)

const crypto = require('crypto');

const PROJECT_ID   = process.env.FIREBASE_PROJECT_ID || 'base-seguros-f5144';
const CLIENT_EMAIL = process.env.FIREBASE_CLIENT_EMAIL;
// En Netlify la private key se pega con "\n" literales; los convertimos a saltos de línea reales.
const PRIVATE_KEY  = (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n');

// Cache del access token en memoria (vida del contenedor lambda).
let _tokenCache = { token: null, exp: 0 };

function base64url(input) {
  return Buffer.from(input).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

// Firma un JWT con la service account y lo canjea por un access token de Google (scope datastore).
async function getAccessToken() {
  if (_tokenCache.token && Date.now() < _tokenCache.exp) return _tokenCache.token;
  if (!CLIENT_EMAIL || !PRIVATE_KEY) {
    throw new Error('Faltan credenciales de Firebase (FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY).');
  }
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = base64url(JSON.stringify({
    iss: CLIENT_EMAIL,
    scope: 'https://www.googleapis.com/auth/datastore',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600
  }));
  const signingInput = header + '.' + claim;
  const signature = crypto.createSign('RSA-SHA256').update(signingInput).sign(PRIVATE_KEY);
  const jwt = signingInput + '.' + base64url(signature);

  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt
    }).toString()
  });
  const j = await resp.json().catch(() => ({}));
  if (!j.access_token) throw new Error('No se obtuvo access_token de Google: ' + JSON.stringify(j).slice(0, 200));
  _tokenCache = { token: j.access_token, exp: Date.now() + ((j.expires_in || 3600) - 60) * 1000 };
  return j.access_token;
}

// Convierte un "value" del formato REST de Firestore a un valor JS plano (recursivo).
function decode(v) {
  if (v == null) return null;
  if ('stringValue' in v)    return v.stringValue;
  if ('integerValue' in v)   return Number(v.integerValue);
  if ('doubleValue' in v)    return v.doubleValue;
  if ('booleanValue' in v)   return v.booleanValue;
  if ('nullValue' in v)      return null;
  if ('timestampValue' in v) return v.timestampValue;
  if ('arrayValue' in v)     return (v.arrayValue.values || []).map(decode);
  if ('mapValue' in v) {
    const out = {};
    const f = v.mapValue.fields || {};
    for (const k in f) out[k] = decode(f[k]);
    return out;
  }
  return null;
}

// Lee el documento sanisidro/datos completo (server-side) y lo devuelve como objeto JS.
async function getDatos() {
  const token = await getAccessToken();
  const url = 'https://firestore.googleapis.com/v1/projects/' + PROJECT_ID +
              '/databases/(default)/documents/sanisidro/datos';
  const resp = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
  if (!resp.ok) {
    const txt = await resp.text().catch(() => '');
    throw new Error('Firestore HTTP ' + resp.status + ' ' + txt.slice(0, 160));
  }
  const j = await resp.json();
  const fields = j.fields || {};
  const root = {};
  for (const k in fields) root[k] = decode(fields[k]);
  return root.sisData || root;
}

const ESTADOS_INACTIVOS = ['vencida', 'baja', 'cancelled', 'canceled', 'expired'];

exports.handler = async function (event) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  // ── DEBUG temporal: abrir en el navegador
  //    https://sanisidroseguros.com.ar/.netlify/functions/cliente-dni?debug=1
  //    Muestra si están cargadas las credenciales de Firebase y si puede leer la base
  //    (cuántos clientes/pólizas ve). Para diagnosticar por qué el siniestro no encuentra el DNI.
  //    NO expone datos de clientes. QUITAR tras verificar.
  if (event.httpMethod === 'GET' && (event.queryStringParameters || {}).debug) {
    const dbg = {
      _debug: true,
      env: {
        FIREBASE_PROJECT_ID: PROJECT_ID,
        FIREBASE_CLIENT_EMAIL: !!CLIENT_EMAIL,
        FIREBASE_PRIVATE_KEY: !!PRIVATE_KEY
      }
    };
    try {
      const d = await getDatos();
      dbg.lecturaOK = true;
      dbg.cantidadClientes = (d.clients || []).length;
      dbg.cantidadPolizas = (d.policies || []).length;
    } catch (e) { dbg.error = e.message; }
    return { statusCode: 200, headers, body: JSON.stringify(dbg) };
  }

  if (event.httpMethod !== 'POST')    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Método no permitido' }) };

  let dni;
  try { dni = String((JSON.parse(event.body || '{}').dni) || '').replace(/\D/g, '').trim(); }
  catch (e) { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Body inválido' }) }; }
  if (!dni) return { statusCode: 200, headers, body: JSON.stringify({ error: 'Falta el DNI' }) };

  try {
    const d = await getDatos();
    const cli = (d.clients || []).find(c => String(c.dni).replace(/\D/g, '') === dni);
    if (!cli) return { statusCode: 200, headers, body: JSON.stringify({ encontrado: false }) };

    const polizas = (d.policies || []).filter(p =>
      p.clientId === cli.id &&
      !p.annulled &&
      !ESTADOS_INACTIVOS.includes((p.estado || p.status || '').toLowerCase())
    );

    // Solo devolvemos las compañías referenciadas por las pólizas de ESTE cliente.
    const idsComp = new Set(polizas.map(p => p.companyId));
    const companias = (d.companies || []).filter(c => idsComp.has(c.id));

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ encontrado: true, cliente: cli, polizas, companias })
    };
  } catch (e) {
    return { statusCode: 200, headers, body: JSON.stringify({ error: 'No se pudo consultar el sistema: ' + e.message }) };
  }
};
