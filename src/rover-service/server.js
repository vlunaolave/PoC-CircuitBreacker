/**
 * Servicio remoto de telemetría del rover ARES-01.
 * Escucha en el puerto 3001 y no conoce el Circuit Breaker:
 * solo responde, falla o se demora según el modo de simulación.
 */

const express = require('express');
const { FaultController } = require('./fault-controller');
const { createTelemetry } = require('./telemetry-generator');

function createRoverApp(controller = new FaultController()) {
  const app = express();
  app.use(express.json());

  app.get('/health', (req, res) => {
    res.json({ ok: true, service: 'rover-telemetry' });
  });

  app.get('/telemetry', async (req, res, next) => {
    controller.recordRequest();
    try {
      if (controller.mode === 'fail') {
        res.status(503).json({
          error: 'SERVICE_UNAVAILABLE',
          message: 'Pérdida de comunicación con ARES-01.',
        });
        return;
      }

      if (controller.mode === 'timeout') {
        await delay(controller.timeoutDelayMs);
      } else if (controller.responseDelayMs > 0) {
        await delay(controller.responseDelayMs);
      }

      res.json(createTelemetry(Date.now()));
    } catch (error) {
      next(error);
    }
  });

  app.get('/simulation/stats', (req, res) => {
    res.json({ ok: true, ...controller.snapshot() });
  });

  app.post('/simulation/fail', (req, res) => {
    controller.setMode('fail');
    res.json({ ok: true, ...controller.snapshot() });
  });

  app.post('/simulation/recover', (req, res) => {
    controller.setMode('normal');
    res.json({ ok: true, ...controller.snapshot() });
  });

  app.post('/simulation/timeout', (req, res) => {
    if (req.body && req.body.delayMs !== undefined) {
      controller.setTimeoutDelay(req.body.delayMs);
    }
    controller.setMode('timeout');
    res.json({ ok: true, ...controller.snapshot() });
  });

  app.post('/simulation/delay', (req, res) => {
    controller.setResponseDelay(req.body?.delayMs ?? 0);
    res.json({ ok: true, ...controller.snapshot() });
  });

  app.post('/simulation/reset', (req, res) => {
    controller.reset();
    res.json({ ok: true, ...controller.snapshot() });
  });

  app.use((error, req, res, next) => {
    if (res.headersSent) {
      next(error);
      return;
    }
    const status = error.status || 500;
    res.status(status).json({
      ok: false,
      message: error.message || 'Error interno del servicio de telemetría.',
    });
  });

  return app;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function startRover(port = Number(process.env.ROVER_PORT) || 3001, controller) {
  const app = createRoverApp(controller);
  return app.listen(port);
}

if (require.main === module) {
  const server = startRover();
  server.on('listening', () => {
    const address = server.address();
    console.log(`Rover Telemetry Service escuchando en http://localhost:${address.port}`);
  });
  server.on('error', (error) => {
    console.error(`No se pudo iniciar el rover: ${error.message}`);
    process.exit(1);
  });
}

module.exports = {
  createRoverApp,
  startRover,
  FaultController,
};
