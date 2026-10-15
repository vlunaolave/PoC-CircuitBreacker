/**
 * Cliente HTTP hacia el servicio del rover.
 *
 * Los códigos 4xx y 5xx se convierten en errores con `status` explícito.
 * Si Axios los lanzara por su cuenta, un 503 podría confundirse con una
 * caída de red. Timeout y conexión se clasifican aparte.
 */

const axios = require('axios');

async function requestTelemetry({ roverUrl, signal, timeoutMs }) {
  try {
    const response = await axios.get(`${roverUrl}/telemetry`, {
      signal,
      timeout: timeoutMs,
      validateStatus: () => true,
    });

    if (response.status >= 400) {
      const error = new Error(response.data?.message || `Respuesta HTTP ${response.status}`);
      error.kind = 'http';
      error.status = response.status;
      throw error;
    }

    return response.data;
  } catch (error) {
    if (error.kind === 'http') {
      throw error;
    }

    if (
      error.code === 'ECONNABORTED' ||
      error.code === 'ERR_CANCELED' ||
      error.name === 'CanceledError'
    ) {
      const timeoutError = new Error('Tiempo de respuesta agotado');
      timeoutError.kind = 'timeout';
      timeoutError.code = 'TIMEOUT';
      throw timeoutError;
    }

    const connectionError = new Error('No se pudo conectar con el servicio de telemetría');
    connectionError.kind = 'connection';
    connectionError.code = error.code;
    throw connectionError;
  }
}

async function postSimulation(roverUrl, path, body) {
  try {
    const response = await axios.post(`${roverUrl}${path}`, body ?? {}, {
      timeout: 2000,
      validateStatus: () => true,
    });
    if (response.status >= 400) {
      const error = new Error(response.data?.message || 'El rover no aceptó el comando de simulación');
      error.status = response.status;
      throw error;
    }
    return response.data;
  } catch (error) {
    if (error.status) {
      throw error;
    }
    const connectionError = new Error('No se pudo contactar al servicio del rover para cambiar la simulación');
    connectionError.status = 503;
    throw connectionError;
  }
}

module.exports = {
  requestTelemetry,
  postSimulation,
};
