// ============ CATÁLOGO DE VEHÍCULOS POR AÑO — vía Mercantil (InfoAuto) ============
// Devuelve las VERSIONES de un modelo YA FILTRADAS por el año elegido, cada una con su
// código InfoAuto correcto. Sirve para poblar el desplegable de "versión" del cotizador,
// de modo que un auto 2015 no traiga versiones de líneas 2008/2016 (que hacían fallar la
// cotización en todas las compañías, porque el código InfoAuto no correspondía al año).
//
// Mercantil expone /vehiculos/v1/?q=<texto>&anio=<AAAA>&tipo=AUTO que ya filtra por año y
// devuelve el código InfoAuto de cada resultado. Como todas las compañías (Provincia,
// Mercantil, Paraná, etc.) usan la tabla InfoAuto, ese código sirve para todas.
//
//   GET /.netlify/functions/mercantil-vehiculos?marca=Ford&modelo=Focus&anio=2015
//   -> { ok:true, versiones:[{ n:"FOCUS S 1.6 L/15", c:12345 }, ...] }
//
//  ⚠️ SEGURIDAD: credenciales SOLO en variables de entorno de Netlify (idem mercantil-cot.js).

const HOST      = process.env.MERCANTIL_HOST || 'https://apidev.mercantilandina.com.ar';
const VEH_BASE  = HOST + '/vehiculos/v1';
const LOGIN_URL = process.env.MERCANTIL_LOGIN_URL || (HOST + '/credenciales/v2');
const CLIENT_ID = process.env.MERCANTIL_CLIENT_ID || 'api-clientes-login';

// Índice de InfoAuto por código numérico. Mercantil se usa SOLO para saber qué versiones existen
// para el año pedido; los DATOS (nombre, código, tipo) los tomamos de infoauto.json, que es el
// estándar que usan todas las compañías. Así el desplegable devuelve nombres LIMPIOS (sin la marca
// adelante, que rompía el match de Paraná/Provincia) y el código en el formato correcto ("0300261").
const INFOAUTO = require('./infoauto.json');
const _infoIdx = new Map(); // código numérico → { n, c, t }
for (const mk of Object.keys(INFOAUTO)) {
  const arr = Array.isArray(INFOAUTO[mk]) ? INFOAUTO[mk] : (INFOAUTO[mk].modelos || []);
  for (const it of arr) {
    const num = parseInt(it.c, 10);
    if (!Number.isNaN(num) && !_infoIdx.has(num)) _infoIdx.set(num, { n: it.n, c: it.c, t: it.t });
  }
}
// Saca la marca del inicio del nombre de Mercantil (fallback cuando el código no está en InfoAuto).
function _sinMarca(nombre, marca) {
  let t = (nombre || '').trim();
  const ma = (marca || '').trim().toUpperCase();
  if (t && ma && t.toUpperCase().startsWith(ma + ' ')) { const r = t.slice(ma.length).trim(); if (r) return r; }
  return t;
}

// Cache del token en memoria (vida del contenedor lambda). Comparte la misma cuenta que
// mercantil-cot.js pero cada función corre en su propio contexto, así que cachea aparte.
let _cache = { token: null, exp: 0 };
const TOKEN_TTL_MS = 8 * 60 * 1000;

async function getToken() {
  if (_cache.token && Date.now() < _cache.exp) return _cache.token;
  const user = process.env.MERCANTIL_USER;
  const pass = process.env.MERCANTIL_PASS;
  const sub  = process.env.MERCANTIL_SUBKEY;
  if (!user || !pass) throw new Error('Credenciales Mercantil no configuradas (MERCANTIL_USER / MERCANTIL_PASS).');
  if (!sub) throw new Error('Falta MERCANTIL_SUBKEY (Ocp-Apim-Subscription-Key).');

  const body = new URLSearchParams({
    client_id: CLIENT_ID,
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

function authHeaders(token) {
  return {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer ' + token,
    'Ocp-Apim-Subscription-Key': process.env.MERCANTIL_SUBKEY
  };
}

// Año de la línea, del nombre "FOCUS ... L/15" o "L|15" -> 2015.
function lineaAnio(nombre) {
  const m = (nombre || '').match(/L[\/|](\d{2})/i);
  return m ? 2000 + parseInt(m[1], 10) : null;
}

exports.handler = async function (event) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, OPTIONS'
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  const q = event.queryStringParameters || {};
  const marca  = (q.marca  || '').trim();
  const modelo = (q.modelo || '').trim();
  const anio   = (q.anio   || '').trim();
  const debug  = q.debug;

  if (!marca || !anio) {
    return { statusCode: 200, headers, body: JSON.stringify({ ok: false, error: 'Faltan marca o año.', versiones: [] }) };
  }

  try {
    const token = await getToken();

    // Mercantil rechaza búsquedas muy largas (HTTP 400 ERR0014): marca + primeras 2 palabras
    // del modelo, capado a 40 caracteres.
    const modeloCorto = modelo.split(/\s+/).slice(0, 2).join(' ');
    const texto = (marca + ' ' + modeloCorto).trim().slice(0, 40);
    const url = VEH_BASE + '/?q=' + encodeURIComponent(texto) +
                '&anio=' + encodeURIComponent(anio) + '&tipo=AUTO&limit=50';

    const resp = await fetch(url, { method: 'GET', headers: authHeaders(token) });
    if (!resp.ok) {
      const txt = await resp.text().catch(() => '');
      return { statusCode: 200, headers, body: JSON.stringify({
        ok: false, error: 'Catálogo Mercantil HTTP ' + resp.status, versiones: [],
        raw: debug ? txt.slice(0, 500) : undefined
      }) };
    }

    const json = await resp.json().catch(() => null);
    const datos = (json && json.datos) || [];
    const anioNum = parseInt(anio, 10) || 0;

    // Descartamos líneas POSTERIORES al año pedido (un 2015 no puede ser línea 2016, hace
    // fallar la cotización). Aceptamos líneas iguales/anteriores o sin año explícito.
    const filtradas = datos.filter(d => {
      const ly = lineaAnio(d.nombre);
      if (ly == null || !anioNum) return true;
      return ly <= anioNum;
    });

    // Dedup por código y armado del resultado. Para cada código de Mercantil buscamos la entrada
    // canónica en InfoAuto (nombre limpio, código "0300261", tipo). Si no está, usamos el nombre de
    // Mercantil sin la marca y el código tal cual (fallback).
    const vistos = new Set();
    const versiones = [];
    filtradas.forEach(d => {
      const cod = d.infoauto != null ? d.infoauto : d.codigo;
      if (cod == null) return;
      const num = parseInt(cod, 10);
      const info = _infoIdx.get(num);
      const item = info
        ? { n: info.n, c: info.c, t: info.t }
        : { n: _sinMarca(d.nombre, marca), c: String(cod) };
      const key = String(item.c);
      if (vistos.has(key)) return;
      vistos.add(key);
      versiones.push(item);
    });
    versiones.sort((a, b) => (a.n || '').localeCompare(b.n || '', 'es'));

    const out = { ok: true, versiones };
    if (debug) { out.q = texto; out.total = datos.length; out.tras_filtro = filtradas.length; }
    return { statusCode: 200, headers, body: JSON.stringify(out) };

  } catch (e) {
    return { statusCode: 200, headers, body: JSON.stringify({ ok: false, error: e.message, versiones: [] }) };
  }
};
