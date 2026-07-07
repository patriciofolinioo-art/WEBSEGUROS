// ============================================================================
//  provincia-cot.js  ·  Netlify Function para la WEB PÚBLICA
//  Cotizador online de Provincia Seguros (solo cotización, NO emisión)
//
//  ⚠️ SEGURIDAD: las credenciales de PS2 van en variables de entorno de
//  Netlify, NUNCA en el HTML público ni en este archivo.
//  Configurar en Netlify → Site settings → Environment variables:
//      PROVINCIA_USER  = (usuario PS2)
//      PROVINCIA_PASS  = (contraseña PS2)
// ============================================================================

const AUTH_URL    = 'https://authp.provinciaseguros.com.ar/auth/realms/ps/protocol/openid-connect/token';
const COTIZAR_URL = 'https://apimprod.provinciaseguros.com.ar/PS/PS-COTIZACION/2.2/cotizar';
const BASE        = 'https://apimprod.provinciaseguros.com.ar/PS/PS-COTIZACION/2.2/valores';
const API_KEY     = '84630d93-d8c2-40b3-ad3d-b82773c092b5';
const CLIENT_ID   = 'ps2';
const CLIENT_SECRET = 'a0ab7e18-baea-4d38-b22e-f61184960745';

// Bonificación / descuento que aplica el productor, igual al que se carga en el portal PS2.
// El portal usa 25% de descuento (con 20% de comisión). Si cambia el descuento, editar acá.
const BONIF_ADICIONAL = 25;

// Mapa de marcas conocidas nombre → código Provincia
const MARCA_MAP = {
  'Toyota':'TOY','Volkswagen':'VOL','Ford':'FOR','Chevrolet':'CHE','Renault':'REN',
  'Fiat':'FIA','Peugeot':'PEU','Honda':'HON','Nissan':'NIS','Hyundai':'HYU',
  'Kia':'KIA','Citroën':'CIT','Mercedes-Benz':'MBZ','BMW':'BMW','Audi':'AUD',
  'Jeep':'JEP','Dodge':'DOD','RAM':'RAM','Mitsubishi':'MIT','Mazda':'MAZ',
  'Subaru':'SUB','Suzuki':'SUZ','Volvo':'VLV','Porsche':'POR','Tesla':'TES',
  'BYD':'BYD','Chery':'CHE','GWM':'GWM','MG':'MG0','BAIC':'BAI','Geely':'GEE',
  'JAC':'JAC','Changan':'CHA','Land Rover':'LAN','Lexus':'LEX','MINI':'MIN',
  'Seat':'SEA','Alfa Romeo':'ALF','DS':'DS0','Isuzu':'ISU'
};

async function getToken() {
  const user = process.env.PROVINCIA_USER;
  const pass = process.env.PROVINCIA_PASS;
  if (!user || !pass) {
    throw new Error('Credenciales no configuradas en el servidor (PROVINCIA_USER / PROVINCIA_PASS).');
  }
  const params = new URLSearchParams();
  params.append('grant_type',    'password');
  params.append('client_id',     CLIENT_ID);
  params.append('client_secret', CLIENT_SECRET);
  params.append('username',      user);
  params.append('password',      pass);
  const resp = await fetch(AUTH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString()
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error('Auth fallida: ' + (err.error_description || resp.status));
  }
  const data = await resp.json();
  return data.access_token;
}

async function buscarCodigoMarca(token, nombreMarca, producto) {
  const codLocal = MARCA_MAP[nombreMarca];
  if (codLocal) return codLocal;
  const url = `${BASE}/marcas/4/${producto}?apikey=${API_KEY}`;
  const resp = await fetch(url, { headers: { 'Authorization': 'Bearer ' + token, 'apikey': API_KEY } });
  if (!resp.ok) return 'AAA';
  const lista = await resp.json();
  const arr = Array.isArray(lista) ? lista : (lista.valores || []);
  const nombreUp = (nombreMarca || '').toUpperCase();
  const encontrado = arr.find(m => {
    const d = (m.descripcion || m.descripción || '').toUpperCase();
    return d === nombreUp || d.includes(nombreUp);
  });
  return encontrado ? (encontrado.código || encontrado.codigo) : 'AAA';
}

async function buscarCodigoModelo(token, marcaCod, nombreModelo, anio, producto) {
  const url = `${BASE}/modelo/4/${producto}/${marcaCod}/${anio}/N?apikey=${API_KEY}`;
  const resp = await fetch(url, { headers: { 'Authorization': 'Bearer ' + token, 'apikey': API_KEY } });
  if (!resp.ok) return '000000';
  let lista;
  try { lista = JSON.parse(await resp.text()); } catch(e) { return '000000'; }
  const arr = Array.isArray(lista) ? lista : (lista.valores || []);
  const nombreUp = (nombreModelo || '').toUpperCase();
  let encontrado = arr.find(m => (m.descripcion || m.descripción || '').toUpperCase().includes(nombreUp));
  if (!encontrado && nombreUp.includes(' ')) {
    const primera = nombreUp.split(' ')[0];
    encontrado = arr.find(m => (m.descripcion || m.descripción || '').toUpperCase().includes(primera));
  }
  return encontrado ? (encontrado.código || encontrado.codigo) : '000000';
}

function construirPayload(datos, marcaCod, modeloCod) {
  const usoCod = datos.uso === 'comercial' ? '42' : '1';
  return {
    "contacto": {
      "dni":   (datos.dni||'').replace(/\D/g,''),
      "corte": (datos.dni||'').replace(/\D/g,''),
      "nombre": datos.nombre || '',
      "celular": (datos.tel||'').replace(/\D/g,''),
      "correo electrónico": datos.email || '',
      "canal": "PAS"
    },
    "ramoProducto": { "ramo":"4", "producto": "04100" },
    "datosGenerales": {
      "provincia":"1","tipoPersona":"F","medioDePago":"2","origenDePago":"VISO",
      "condicionIva":"CF","cuit":"","vigencia":"E","vigenciaTecnica":"A",
      "tipoFacturacion":"F","moneda":"01","planDePago":"1","modoDeCalculo":"N"
    },
    "bien": {
      "40007_tipo":"1",
      "40012_anio": String(datos.anio || new Date().getFullYear()),
      "40013_esOkm":"N",
      "40020_marca": marcaCod,
      "40021_modelo": modeloCod,
      "40008_uso": usoCod,
      "40220_ValorDelVehiculo": Number(datos.suma) || 0,
      "900008_codPostal": Number(datos.cp) || 1642,
      "40086_genero": (datos.genero === 'F' ? 'F' : 'M'),
      "40550_clausulaAjuste":10,
      "40088_bonifAdicional": BONIF_ADICIONAL,
      "40102_limiteResponsabilidadCivil":0,
      // GNC: el monto del equipo va como accesorio del vehículo (afecta la prima).
      "montoAccesorios": Number(datos.gnc_monto) || 0,
      "40090_limiteMercosur":0,
      "40082_roboContenido":"N",
      "40101_cobAdicComerciales":"N"
    }
  };
}

// Convierte texto a Título legible respetando puntos/guiones: "SURAN 1.6 5P" → "Suran 1.6 5p"
function _tituloRaw(s) {
  return (s || '').toString().trim()
    .toLowerCase()
    .replace(/([a-záéíóúñ0-9])([a-záéíóúñ0-9]*)/gi, (m, a, b) => a.toUpperCase() + b)
    .replace(/\s+/g, ' ');
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

    // ── ACCIÓN: buscar modelos en vivo (para autos que no están en la base local) ──
    if (datos.accion === 'listarModelos') {
      if (!datos.marca || !datos.anio) {
        return { statusCode: 200, headers, body: JSON.stringify({ error: 'Falta marca o año.' }) };
      }
      const tokenL = await getToken();
      const marcaCodL = await buscarCodigoMarca(tokenL, datos.marca, '04100');
      if (!marcaCodL || marcaCodL === 'AAA') {
        return { statusCode: 200, headers, body: JSON.stringify({ error: 'Marca no encontrada.' }) };
      }
      const urlL = `${BASE}/modelo/4/04100/${marcaCodL}/${datos.anio}/N?apikey=${API_KEY}`;
      const respL = await fetch(urlL, { headers: { 'Authorization': 'Bearer ' + tokenL, 'apikey': API_KEY } });
      if (!respL.ok) {
        return { statusCode: 200, headers, body: JSON.stringify({ error: 'No se pudieron traer los modelos.' }) };
      }
      let listaL;
      try { listaL = JSON.parse(await respL.text()); } catch(e) { return { statusCode: 200, headers, body: JSON.stringify({ error: 'Respuesta inválida.' }) }; }
      const arrL = Array.isArray(listaL) ? listaL : (listaL.valoresparamétricos || listaL.valores || []);
      const modelos = arrL
        .map(m => ({ codigo: (m.código || m.codigo), nombre: _tituloRaw(m.descripcion || m.descripción || '') }))
        .filter(m => m.codigo && m.nombre)
        .sort((a, b) => a.nombre.localeCompare(b.nombre));
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, modelos }) };
    }

    if (!datos.marca || !datos.anio) {
      return { statusCode: 200, headers, body: JSON.stringify({ error: 'Faltan datos del vehículo (marca y año).' }) };
    }

    const token     = await getToken();
    const marcaCod  = await buscarCodigoMarca(token, datos.marca, '04100');
    // Si el modelo se eligió del catálogo en vivo, usamos su código exacto
    let modeloCod;
    if (datos.modeloProvCod && /^[A-Z0-9]+$/i.test(datos.modeloProvCod)) {
      modeloCod = datos.modeloProvCod;
    } else {
      modeloCod = await buscarCodigoModelo(token, marcaCod, datos.modelo, datos.anio, '04100');
    }
    const payload   = construirPayload(datos, marcaCod, modeloCod);

    const cotResp = await fetch(COTIZAR_URL + '?apikey=' + API_KEY, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token, 'apikey': API_KEY },
      body: JSON.stringify(payload)
    });

    const cotText = await cotResp.text();
    if (!cotResp.ok) {
      return { statusCode: 200, headers, body: JSON.stringify({ error: 'No se pudo cotizar en este momento.', httpStatus: cotResp.status }) };
    }

    const cotData = JSON.parse(cotText);

    // Aplanar planes → lista limpia de coberturas con premio (sin exponer datos internos)
    // Provincia PS2 devuelve { status, content:[...] }; otras versiones devuelven planes/cotizaciones.
    const planesRaw = cotData.planes || cotData.cotizaciones || cotData.resultados || cotData.content || [];
    // La suma asegurada puede venir a nivel general de la cotización
    const sumaGeneral = parseFloat(
      cotData.sumaAsegurada ?? cotData.valorAsegurado ?? cotData.capitalAsegurado ??
      cotData.valorVehiculo ?? cotData.sumaAseg ?? 0
    ) || 0;
    const leerSuma = o => parseFloat(
      o.sumaAsegurada ?? o.valorAsegurado ?? o.capitalAsegurado ??
      o.valorVehiculo ?? o.sumaAseg ?? o.suma ?? 0
    ) || 0;

    const opciones = [];
    planesRaw.forEach(pl => {
      const proms = pl.promocionesPorPlan || pl.promociones || pl.coberturas || null;
      const sumaPlan = leerSuma(pl) || sumaGeneral;
      if (Array.isArray(proms) && proms.length > 0) {
        proms.forEach(promo => {
          const premio = parseFloat(promo.premio ?? promo.premioMensual ?? promo.importe ?? promo.prima ?? promo.importe_premio_1) || 0;
          const suma = leerSuma(promo) || sumaPlan;
          if (premio > 0) opciones.push({ plan: pl.plan || pl.codigo_plan || '', cobertura: pl.descripcion || pl.denominacion_plan || promo.descripcion || '', premio, suma });
        });
      } else {
        // ⚠️ Formato PS2: importe_premio_1 es el precio final CON promo (lo que muestra el portal).
        // NUNCA usar importe_base: ese es el precio SIN promo (~2,4x más caro).
        const premio = parseFloat(pl.premio ?? pl.premioMensual ?? pl.importe ?? pl.prima ?? pl.importe_premio_1) || 0;
        if (premio > 0) opciones.push({ plan: pl.plan || pl.codigo_plan || '', cobertura: pl.descripcion || pl.denominacion_plan || '', premio, suma: sumaPlan });
      }
    });
    opciones.sort((a,b) => a.premio - b.premio);

    return { statusCode: 200, headers, body: JSON.stringify({
      ok: true,
      cotId: cotData.numeroCotizacion || cotData.cotizacionId || '',
      opciones
    }) };

  } catch(e) {
    return { statusCode: 200, headers, body: JSON.stringify({ error: e.message || 'Error inesperado' }) };
  }
};
