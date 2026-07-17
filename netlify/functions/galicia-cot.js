// ===================== PROXY GALICIA SEGUROS (SURA) — Cotizador online =====================
// Recibe el mismo _coDat que las otras compañías y devuelve { opciones:[{plan,cobertura,premio,suma}], error? }.
//
// API "Technical Pricing" de Galicia (REST/JSON, OAuth password grant, .NET/WCF).
//   1) POST /Security/token                       -> access_token (Bearer, dura 28h) [cacheado]
//   2) POST /Motor/api/TechnicalPricing/Cotizar   -> premio de UNA cobertura por llamada
//      (para RC / Terceros / Todo Riesgo se llama una vez por cada IdCobertura)
//
// El vehículo se identifica con IdInfoAuto (código InfoAuto) → se resuelve local contra infoauto.json
// (el mismo que usa Digna). El campo `c` de infoauto.json es el código InfoAuto.
//
//  ⚠️ SEGURIDAD: credenciales en variables de entorno de Netlify:
//      GALICIA_USER        = usuario WCF provisto por GS/SURA
//      GALICIA_PASS        = clave provista por GS
//      GALICIA_INSTITUCION = IdInstitucion (nro de institución, ej. 999)
//      GALICIA_PRODUCTOR   = IdProductor (código del productor en Galicia, ej. 2050)
//      GALICIA_PRODUCTO    = CodigoProducto asociado al productor (ej. 774)
//      GALICIA_BASE        = (opcional) URL base. Default: PRE (testing).
//
//  ⚠️ Esta integración necesita testeo en vivo (debug ?debug=1) — el $type de .NET y la zona
//     de riesgo pueden requerir ajustes. Empieza apuntando a PRE (pre-producción).

const INFOAUTO = require('./infoauto.json');

// PRE (testing) por defecto; producción: https://productores.galiciaseguros.com.ar
const BASE = process.env.GALICIA_BASE || 'https://productores-pre.galiciaseguros.com.ar';
const TOKEN_URL   = BASE + '/Security/token';
const COTIZAR_URL = BASE + '/Motor/api/TechnicalPricing/Cotizar';

// $type de .NET (Technical Pricing, Cotización Input). Si Galicia los rechaza, ajustar acá.
const T_PERSONA  = 'Motor.Areas.SeguroNuevo.Version3.TechnicalPricing.Models.Cotizacion.Input.PersonaFisica, Motor, Version=1.0.0.0, Culture=neutral, PublicKeyToken=null';
const T_ITEMAUTO = 'Motor.Areas.SeguroNuevo.Version3.TechnicalPricing.Models.Cotizacion.Input.ItemAuto, Motor, Version=1.0.0.0, Culture=neutral, PublicKeyToken=null';

// Coberturas que cotizamos (una llamada por cada una). Códigos de la tabla de conversión de GS.
const COBERTURAS = [
  { idCobertura: 1,  nombre: 'Responsabilidad Civil',  cobertura: 'RESPONSABILIDAD CIVIL' },
  { idCobertura: 4,  nombre: 'Terceros Completo',      cobertura: 'TERCEROS COMPLETO (C)' },
  { idCobertura: 74, nombre: 'Todo Riesgo',            cobertura: 'TODO RIESGO (deducible 2%)' }
];

// Valores fijos / defaults (confirmar/ajustar con GS)
const ID_RC = 6;                 // R.C. Clásica (sin límite por persona)
const ID_ASISTENCIA = 0;         // Sin Asistencia
const ID_CLAUSULA_AJUSTE = 15;   // Cláusula de Ajuste 15%
const ID_KM_ANIO = 2;            // Hasta 25.000 km/año
const ID_COCHERA = 3;            // Ninguno
const ID_CONDICION_FISCAL = 4;   // Consumidor Final
const ID_TIPO_DOCUMENTO = 96;    // DNI
const COMISION = 20;             // % de comisión del productor (nodo ProductoComercial)
// ⚠️ Zona de riesgo: la tabla Localidad tiene 20k filas. Por ahora usamos un default (Buenos Aires).
//    Afecta el precio por zona; cuando esté OK, resolver IdProvincia/IdLocalidad reales desde el CP.
const ID_PROVINCIA_DEFAULT = 1;
const ID_LOCALIDAD_DEFAULT = 1;

let _cache = { token: null, exp: 0 };

async function getToken() {
  if (_cache.token && Date.now() < _cache.exp) return _cache.token;
  const user = process.env.GALICIA_USER, pass = process.env.GALICIA_PASS;
  if (!user || !pass) throw new Error('Credenciales Galicia no configuradas (GALICIA_USER / GALICIA_PASS).');
  const body = new URLSearchParams({ grant_type: 'password', Username: user, Password: pass, Store: 'B2B' });
  const resp = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Accept': 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString()
  });
  if (!resp.ok) throw new Error('Token Galicia HTTP ' + resp.status + ' ' + (await resp.text().catch(() => '')).slice(0, 160));
  const j = await resp.json().catch(() => ({}));
  const token = j.access_token;
  if (!token) throw new Error('No se obtuvo access_token de Galicia.');
  _cache = { token, exp: Date.now() + ((j.expires_in || 3600) - 60) * 1000 };
  return token;
}

// Resuelve el código InfoAuto (campo `c`) por marca + texto de modelo (igual que Digna).
function buscarIdInfoAuto(marca, textoVersion) {
  const lista = INFOAUTO[(marca || '').trim().toUpperCase()];
  if (!lista || !lista.length) return null;
  const q = (textoVersion || '').toUpperCase();
  const qTokens = q.split(/\s+/).filter(Boolean);
  const exacto = lista.find(it => it.n.toUpperCase() === q);
  if (exacto) return exacto.c;
  let mejor = null, mejorScore = -1;
  lista.forEach(it => {
    const nom = it.n.toUpperCase();
    const score = qTokens.reduce((s, t) => s + (nom.includes(t) ? 1 : 0), 0);
    if (score > mejorScore) { mejorScore = score; mejor = it; }
  });
  return (mejor && mejorScore > 0) ? mejor.c : null;
}

function mapUso(uso) { return uso === 'comercial' ? 15 : 1; } // 1 Particular / 15 Comercial

function fechasVigencia() {
  const hoy = new Date();
  const desde = hoy.toISOString().slice(0, 10);
  const en1 = new Date(hoy); en1.setFullYear(en1.getFullYear() + 1);
  return { desde, hasta: en1.toISOString().slice(0, 10) };
}

function construirPayload(dat, idInfoAuto, idCobertura) {
  const { desde, hasta } = fechasVigencia();
  const cp = String(dat.cp || '1001');
  return {
    IdRequest: 1,
    IdInstitucion: Number(process.env.GALICIA_INSTITUCION) || 0,
    NumeroOperacionProductor: 0,
    VigenciaDesde: desde,
    VigenciaHasta: hasta,
    FormaDePago: null,
    // Nodo del productor: comisión + códigos que da Galicia. CodigoProducto e IdProductor son obligatorios.
    ProductoComercial: {
      CodigoProducto: Number(process.env.GALICIA_PRODUCTO) || 774,
      Comision: COMISION,
      IdProductor: Number(process.env.GALICIA_PRODUCTOR) || 0
    },
    PolizaElectronica: { EmailProductor: 'pfolini.si@gmail.com', EmailOrganizador: 'pfolini.si@gmail.com', EmailCliente: dat.email || 'cliente@web.com' },
    Tomador: {
      $type: T_PERSONA,
      Nombre: dat.nombre || 'Cliente',
      Apellido: 'Web',
      FechaNacimiento: dat.nac || '1990-01-01',
      Sexo: dat.genero === 'F' ? 'F' : 'M',
      Email: dat.email || 'cliente@web.com',
      Domicilios: [{ IdProvincia: ID_PROVINCIA_DEFAULT, CodigoPostal: cp, IdLocalidad: ID_LOCALIDAD_DEFAULT, DescripcionLocalidad: '', Calle: 'S/D', Numero: '0', IdTipoDomicilio: 1 }],
      Telefonos: [{ IdTipoTelefono: 1, CodigoDeArea: '011', Celular: true, Numero: (dat.tel || '').replace(/\D/g, '') || '0000000000' }],
      Documentos: [{ IdTipoDocumento: ID_TIPO_DOCUMENTO, Documento: (dat.dni || '10000000').replace(/\D/g, '') }],
      IdCondicionFiscal: ID_CONDICION_FISCAL
    },
    Asegurado: null,
    ItemAuto: {
      $type: T_ITEMAUTO,
      IdInfoAuto: String(idInfoAuto),
      Anio: parseInt(dat.anio, 10) || new Date().getFullYear(),
      EsCero: false,
      IdUso: mapUso(dat.uso),
      InformaGNC: dat.gnc === 'si',
      InformaGPS: false,
      IdKmRecorridosPorAnio: ID_KM_ANIO,
      IdCochera: ID_COCHERA,
      SumaAsegurada: 0, // 0 = valor SURA por InfoAuto/año
      ZonaDeRiesgo: { CodigoPostal: parseInt(cp, 10) || 1001, IdProvincia: ID_PROVINCIA_DEFAULT, IdLocalidad: ID_LOCALIDAD_DEFAULT },
      ProductoTecnico: { IdAsistenciaMecanica: ID_ASISTENCIA, IdRc: ID_RC, IdClausulaAjuste: ID_CLAUSULA_AJUSTE, IdCobertura: idCobertura, Accesorios: [] }
    }
  };
}

// Extrae premio + suma de la respuesta de cotización de Galicia.
function parsearPremio(cotData) {
  const m = cotData && (cotData.Message || cotData.message || cotData);
  const premio = Number(m && (m.PremioTotal ?? m.premioTotal)) || 0;
  const suma = Number(m && (m.SumaAsegurada ?? m.sumaAsegurada ?? (m.ItemAuto && m.ItemAuto.SumaAsegurada))) || 0;
  return { premio, suma };
}

exports.handler = async function (event) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  // ── DEBUG temporal: /.netlify/functions/galicia-cot?debug=1[&marca=&modelo=&anio=&cp=]
  if (event.httpMethod === 'GET' && (event.queryStringParameters || {}).debug) {
    const dbg = { _debug: true, env: { GALICIA_USER: !!process.env.GALICIA_USER, GALICIA_PASS: !!process.env.GALICIA_PASS, GALICIA_INSTITUCION: process.env.GALICIA_INSTITUCION || null, BASE } };
    try {
      const q = event.queryStringParameters || {};
      const marca = q.marca || 'Ford', modelo = q.modelo || 'Focus', anio = q.anio || '2015';
      const token = await getToken();
      dbg.tokenObtenido = !!token;
      const idInfoAuto = buscarIdInfoAuto(marca, modelo);
      dbg.idInfoAuto = idInfoAuto;
      if (idInfoAuto != null) {
        const payload = construirPayload({ marca, modelo, anio, cp: q.cp || '1001', uso: 'particular' }, idInfoAuto, 4);
        const r = await fetch(COTIZAR_URL, { method: 'POST', headers: { 'Accept': 'application/json', 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token }, body: JSON.stringify(payload) });
        dbg.cotizarStatus = r.status;
        dbg.cotizarRaw = (await r.text()).slice(0, 3000);
        dbg.payloadEnviado = payload;
      } else { dbg.nota = 'vehículo no encontrado en infoauto.json'; }
    } catch (e) { dbg.error = e.message; }
    return { statusCode: 200, headers, body: JSON.stringify(dbg) };
  }

  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Método no permitido' }) };

  let dat;
  try { dat = JSON.parse(event.body || '{}'); }
  catch (e) { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Body inválido' }) }; }

  try {
    if (!process.env.GALICIA_INSTITUCION) {
      return { statusCode: 200, headers, body: JSON.stringify({ error: 'GALICIA_INSTITUCION no configurado.', opciones: [] }) };
    }
    const idInfoAuto = buscarIdInfoAuto(dat.marca, dat.modelo);
    if (idInfoAuto == null) {
      return { statusCode: 200, headers, body: JSON.stringify({ error: 'No se encontró el vehículo en InfoAuto (Galicia)', opciones: [] }) };
    }
    const token = await getToken();

    // Una llamada por cobertura, en paralelo.
    const resultados = await Promise.all(COBERTURAS.map(async (cob) => {
      try {
        const payload = construirPayload(dat, idInfoAuto, cob.idCobertura);
        const r = await fetch(COTIZAR_URL, { method: 'POST', headers: { 'Accept': 'application/json', 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token }, body: JSON.stringify(payload) });
        if (!r.ok) return null;
        const j = JSON.parse(await r.text());
        const { premio, suma } = parsearPremio(j);
        if (premio > 0) return { plan: cob.nombre, cobertura: cob.cobertura, premio, suma };
        return null;
      } catch (e) { return null; }
    }));

    const opciones = resultados.filter(Boolean).sort((a, b) => a.premio - b.premio);
    if (!opciones.length) {
      return { statusCode: 200, headers, body: JSON.stringify({ error: 'Sin opciones de Galicia para este vehículo', opciones: [] }) };
    }
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, opciones }) };
  } catch (e) {
    return { statusCode: 200, headers, body: JSON.stringify({ error: 'No se pudo cotizar con Galicia: ' + e.message, opciones: [] }) };
  }
};
