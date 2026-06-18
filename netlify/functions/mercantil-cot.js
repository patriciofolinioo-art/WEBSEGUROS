// ===================== PROXY MERCANTIL ANDINA — Cotizador online =====================
// Recibe el mismo _coDat que manda cotizar.html (nombre, marca, modelo, anio, cp, uso, tel,
// email, via, contacto, modeloProvCod, gnc, gnc_monto, nac, genero) y devuelve
// { opciones:[{plan,cobertura,premio,suma}], error? } — mismo contrato que provincia-cot.js.

const BASE_URL = 'https://apidev.mercantilandina.com.ar';

// ── TODO: completar cuando tengas la posta de cada uno ──
const MA_RAMA      = 0;   // TODO: código de rama "Automotor"
const MA_CANAL     = 0;   // TODO: código de tu canal (PAS web / online)
const MA_PRODUCTOR = { id: 0, nombre: '' }; // TODO: tu código de productor con Mercantil Andina
const MA_COMISION    = 0; // TODO: valor por defecto si no aplica
const MA_BONIFICACION = 0; // TODO: valor por defecto si no aplica

// TODO: confirmar el header/esquema real de auth (¿Bearer token? ¿Ocp-Apim-Subscription-Key
// tipo Azure API Management, que es lo que usa el portal de Mercantil Andina?)
function authHeaders() {
  return {
    'Content-Type': 'application/json',
    // 'Authorization': 'Bearer ' + process.env.MERCANTIL_TOKEN,
    // 'Ocp-Apim-Subscription-Key': process.env.MERCANTIL_SUBSCRIPTION_KEY,
  };
}

// TODO: mapear código de uso del form (co_uso) al código numérico que pide Mercantil Andina
function mapUso(uso) {
  const TABLA_USO = {
    // 'particular': 1,
    // 'comercial': 2,
  };
  return TABLA_USO[uso] ?? 0;
}

// Busca el código de vehículo de Mercantil Andina por texto libre + año.
// Devuelve el primer match razonable, priorizando coincidencia de texto contra `nombre`
// y, si hay GNC, un resultado cuyo nombre lo mencione (heurística — confirmar con la
// tabla real de `propulsion` cuando la tengas).
// TODO: confirmar que el `codigo` que devuelve este endpoint es lo que va en
// vehiculo.infoauto del payload de cotización (y no en vehiculo.id).
async function buscarCodigoVehiculo(marca, modelo, anio, gnc) {
  const q = (marca + ' ' + modelo).trim();
  const url = BASE_URL + '/vehiculos/v1/?q=' + encodeURIComponent(q) + '&anio=' + encodeURIComponent(anio);
  const resp = await fetch(url, { method: 'GET', headers: authHeaders() });
  if (!resp.ok) {
    const txt = await resp.text().catch(() => '');
    throw new Error('Búsqueda de vehículo HTTP ' + resp.status + ' ' + txt.slice(0, 200));
  }
  const json = await resp.json();
  const datos = (json && json.datos) || [];
  if (!datos.length) return null;

  // 1) match exacto de nombre (sin distinguir mayúsculas)
  const qLower = q.toLowerCase();
  let candidatos = datos;
  if (gnc) {
    const conGnc = datos.filter(d => /gnc/i.test(d.nombre || ''));
    if (conGnc.length) candidatos = conGnc;
  }
  const exacto = candidatos.find(d => (d.nombre || '').toLowerCase() === qLower);
  if (exacto) return exacto.codigo;

  // 2) el que más palabras de la búsqueda contenga
  const tokens = qLower.split(/\s+/).filter(Boolean);
  let mejor = candidatos[0], mejorScore = -1;
  candidatos.forEach(d => {
    const nom = (d.nombre || '').toLowerCase();
    const score = tokens.reduce((s, t) => s + (nom.includes(t) ? 1 : 0), 0);
    if (score > mejorScore) { mejorScore = score; mejor = d; }
  });
  return mejor ? mejor.codigo : null;
}

async function crearCotizacion(payload) {
  const resp = await fetch(BASE_URL + '/cotizaciones/v2', {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(payload)
  });
  if (!resp.ok) {
    const txt = await resp.text().catch(() => '');
    throw new Error('HTTP ' + resp.status + ' ' + txt.slice(0, 200));
  }
  return resp.json();
}

// TODO: confirmar si esto hace falta. Si el POST ya devuelve `resultado` resuelto en la misma
// respuesta, esta función no se usa. Si el POST solo da un `id` y hay que consultarlo aparte,
// se usa para el GET /cotizaciones/v2/{id}.
async function consultarCotizacion(id) {
  const resp = await fetch(BASE_URL + '/cotizaciones/v2/' + id, {
    method: 'GET',
    headers: authHeaders()
  });
  if (!resp.ok) {
    const txt = await resp.text().catch(() => '');
    throw new Error('HTTP ' + resp.status + ' ' + txt.slice(0, 200));
  }
  return resp.json();
}

exports.handler = async function (event) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Método no permitido' }) };
  }

  let dat;
  try {
    dat = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Body inválido' }) };
  }

  try {
    const codVeh = await buscarCodigoVehiculo(dat.marca, dat.modelo, dat.anio, dat.gnc === 'si');
    if (codVeh == null) {
      return { statusCode: 200, headers, body: JSON.stringify({ error: 'No se encontró el vehículo en Mercantil Andina', opciones: [] }) };
    }

    const payload = {
      id: 0,
      rama: MA_RAMA,
      canal: MA_CANAL,
      localidad: {
        id: 0,
        codigo_postal: parseInt(dat.cp) || 0,
        nombre: '',      // TODO: ¿hace falta resolver nombre/provincia por CP, o el código postal solo alcanza?
        provincia: ''
      },
      vehiculo: {
        id: 0,
        infoauto: codVeh,
        nombre: dat.marca + ' ' + dat.modelo,
        anio: parseInt(dat.anio) || 0,
        uso: mapUso(dat.uso),
        gnc: dat.gnc === 'si',
        valor: 0,    // TODO: ¿lo calcula la compañía a partir de infoauto, o hay que mandar la suma asegurada?
        rastreo: 0   // TODO: código si tiene/no tiene rastreo satelital
      },
      periodo: 0,     // TODO: código de periodicidad (¿mensual/anual?)
      cuotas: 1,      // TODO: cantidad de cuotas default
      comision: MA_COMISION,
      bonificacion: MA_BONIFICACION,
      productor: MA_PRODUCTOR,
      fecha: new Date().toISOString().slice(0, 10),
      cantidad: 0
    };

    let resultado = await crearCotizacion(payload);

    // TODO: descomentar si el flujo real requiere un segundo GET por id
    // if (resultado && resultado.id && (!resultado.resultado || !resultado.resultado.length)) {
    //   resultado = await consultarCotizacion(resultado.id);
    // }

    const items = (resultado && resultado.resultado) || [];
    const opciones = items
      .filter(it => !it.error && it.costo)
      .map(it => ({
        plan: it.producto || it.titulo || '',
        cobertura: it.titulo || it.descripcion || '',
        premio: (it.desglose && it.desglose.total && it.desglose.total.premio) || it.costo || 0,
        suma: 0 // TODO: confirmar si la API devuelve suma asegurada en algún campo
      }));

    if (!opciones.length) {
      return { statusCode: 200, headers, body: JSON.stringify({ error: 'Sin opciones para este vehículo', opciones: [] }) };
    }

    return { statusCode: 200, headers, body: JSON.stringify({ opciones }) };
  } catch (e) {
    return { statusCode: 200, headers, body: JSON.stringify({ error: 'No se pudo cotizar con Mercantil Andina: ' + e.message, opciones: [] }) };
  }
};
