// ===================== INFOAUTO — catálogo de vehículos para el selector =====================
// Sirve el árbol marca → modelo → versión desde infoauto.json (el estándar de la industria).
// La versión trae el código InfoAuto `c` (que Digna/Galicia/Mercantil usan directo) y el tipo `t`.
//
//   GET ?accion=marcas
//   GET ?accion=modelos&marca=CHEVROLET
//   GET ?accion=versiones&marca=CHEVROLET&modelo=ONIX
//
// El "modelo" se deriva de la 1ª palabra de la descripción (ONIX 1.0T LT → modelo ONIX).

const INFOAUTO = require('./infoauto.json');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Content-Type': 'application/json'
};

const norm = (s) => (s || '').toString().replace(/\s+/g, ' ').trim();
const modeloDe = (n) => norm(n).split(' ')[0]; // 1ª palabra = modelo

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  const q = event.queryStringParameters || {};
  const accion = q.accion || 'marcas';

  try {
    if (accion === 'marcas') {
      const marcas = Object.keys(INFOAUTO)
        .filter(m => (INFOAUTO[m] || []).length > 0)
        .sort((a, b) => a.localeCompare(b, 'es'));
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, marcas }) };
    }

    const marca = (q.marca || '').trim().toUpperCase();
    const lista = INFOAUTO[marca] || [];
    if (!lista.length) return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, modelos: [], versiones: [] }) };

    if (accion === 'modelos') {
      const set = new Set();
      lista.forEach(it => { const m = modeloDe(it.n); if (m) set.add(m); });
      // Modelos con inicial de LETRA primero (ONIX, CRUZE…) y los numéricos (autos viejos) al final.
      const esNum = s => /^[0-9]/.test(s);
      const modelos = Array.from(set).sort((a, b) => {
        if (esNum(a) !== esNum(b)) return esNum(a) ? 1 : -1;
        return a.localeCompare(b, 'es', { numeric: true });
      });
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, modelos }) };
    }

    if (accion === 'versiones') {
      const modelo = (q.modelo || '').trim().toUpperCase();
      const versiones = lista
        .filter(it => modeloDe(it.n).toUpperCase() === modelo)
        .map(it => ({ n: norm(it.n), c: it.c, t: it.t }))
        .sort((a, b) => a.n.localeCompare(b.n, 'es', { numeric: true }));
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, versiones }) };
    }

    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Acción inválida' }) };
  } catch (e) {
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ error: 'InfoAuto: ' + e.message }) };
  }
};
