/**
 * Rutas de Mission Control.
 * Toda consulta de telemetría pasa por el Circuit Breaker.
 * Cambiar el modo del rover no modifica el estado del circuito:
 * la recuperación ocurre solo con la transición HALF_OPEN y una prueba exitosa.
 */

const path = require('node:path');
const express = require('express');
const { requestTelemetry, postSimulation } = require('./telemetry-client');

function registerRoutes(app, dependencies) {
  const { breaker, eventLog, roverUrl } = dependencies;
  const publicDir = dependencies.publicDir || path.join(__dirname, '..', '..', 'public');

  app.get('/api/health', (req, res) => {
    res.json({ ok: true, service: 'mission-control' });
  });

  app.get('/api/telemetry', asyncRoute(async (req, res) => {
    const result = await breaker.execute((context) => requestTelemetry({
      roverUrl,
      signal: context.signal,
      timeoutMs: breaker.timeoutMs,
    }));

    recordTelemetryEvents(eventLog, breaker, result);

    const body = {
      ok: result.ok,
      stale: result.stale,
      source: result.source,
      blocked: result.blocked,
      message: result.stale
        ? 'Los datos pueden estar desactualizados porque el circuito está abierto.'
        : result.message,
      cachedAt: toIso(result.cachedAt),
      telemetry: result.ok ? result.data : null,
      error: result.error,
      circuit: publicStats(breaker.getStats()),
    };

    res.status(result.ok ? 200 : (result.error?.status || 503)).json(body);
  }));

  app.get('/api/status', (req, res) => {
    const stats = publicStats(breaker.getStats());
    for (const transition of breaker.consumeTransitions()) {
      eventLog.add(`Circuit Breaker: ${transition.to}`);
    }
    res.json({ ok: true, circuit: stats });
  });

  app.get('/api/events', (req, res) => {
    res.json({ ok: true, events: eventLog.list() });
  });

  app.post('/api/simulation/fail', asyncRoute(async (req, res) => {
    const rover = await postSimulation(roverUrl, '/simulation/fail');
    eventLog.add('Pérdida de comunicación simulada en el servicio del rover');
    res.json({ ok: true, mode: rover.mode, circuit: publicStats(breaker.getStats()) });
  }));

  app.post('/api/simulation/recover', asyncRoute(async (req, res) => {
    const rover = await postSimulation(roverUrl, '/simulation/recover');
    eventLog.add('Comunicación del rover restaurada. El circuito sigue su recuperación automática');
    res.json({ ok: true, mode: rover.mode, circuit: publicStats(breaker.getStats()) });
  }));

  app.post('/api/simulation/timeout', asyncRoute(async (req, res) => {
    const rover = await postSimulation(roverUrl, '/simulation/timeout', {
      delayMs: req.body?.delayMs,
    });
    eventLog.add('Respuesta lenta simulada. El circuito cortará la espera si se agota el tiempo máximo');
    res.json({ ok: true, mode: rover.mode, circuit: publicStats(breaker.getStats()) });
  }));

  app.post('/api/simulation/reset', asyncRoute(async (req, res) => {
    await postSimulation(roverUrl, '/simulation/reset');
    breaker.reset();
    eventLog.clear();
    eventLog.add('Demostración reiniciada');
    eventLog.add('Misión ARES-01 iniciada');
    eventLog.add('Circuit Breaker: CLOSED');
    res.json({ ok: true, circuit: publicStats(breaker.getStats()) });
  }));

  app.use('/api', (req, res) => {
    res.status(404).json({
      ok: false,
      message: 'La ruta solicitada no existe en Mission Control.',
    });
  });

  app.use(express.static(publicDir));

  app.use((error, req, res, next) => {
    if (res.headersSent) {
      next(error);
      return;
    }
    const status = error.status || 503;
    res.status(status).json({
      ok: false,
      message: error.message || 'Mission Control no pudo completar la operación.',
    });
  });
}

function recordTelemetryEvents(eventLog, breaker, result) {
  for (const transition of result.transitionsBefore) {
    eventLog.add(`Circuit Breaker: ${transition.to}`);
  }

  if (result.blocked) {
    eventLog.add(result.stale ? 'Solicitud bloqueada. Se entregaron los últimos datos conocidos' : 'Solicitud bloqueada');
  } else if (result.ok && result.previousState === 'HALF_OPEN') {
    eventLog.add('Consulta de recuperación exitosa');
  } else if (result.ok) {
    eventLog.add('Telemetría recibida correctamente');
  } else if (result.previousState === 'HALF_OPEN') {
    eventLog.add(`Consulta de recuperación fallida. ${failureMessage(breaker, result)}`);
  } else {
    eventLog.add(failureMessage(breaker, result));
  }

  for (const transition of result.transitionsAfter) {
    eventLog.add(`Circuit Breaker: ${transition.to}`);
  }
}

function failureMessage(breaker, result) {
  const code = result.error?.code || '';
  const status = result.error?.status;
  const progress = `${result.consecutiveFailures}/${breaker.failureThreshold}`;

  if (status >= 400 && status < 500) {
    return `Respuesta HTTP ${status}. No cuenta como fallo de disponibilidad`;
  }
  if (code === 'TIMEOUT') {
    return `Timeout de comunicación ${progress}`;
  }
  if (code === 'CONNECTION') {
    return `Error de conexión ${progress}`;
  }
  if (code.startsWith('HTTP_')) {
    return `Error del servicio HTTP ${status} ${progress}`;
  }
  return `Fallo de comunicación ${progress}`;
}

function publicStats(stats) {
  return {
    ...stats,
    lastStateChange: {
      ...stats.lastStateChange,
      at: toIso(stats.lastStateChange.at),
    },
    cachedAt: toIso(stats.cachedAt),
  };
}

function toIso(value) {
  if (typeof value !== 'number') {
    return null;
  }
  return new Date(value).toISOString();
}

function asyncRoute(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

module.exports = {
  registerRoutes,
};
