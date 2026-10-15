/**
 * Mission Control API.
 * Sirve la interfaz y consulta al rover solo a través del Circuit Breaker.
 */

const express = require('express');
const { CircuitBreaker } = require('../circuit-breaker/CircuitBreaker');
const { EventLog } = require('./event-log');
const { registerRoutes } = require('./routes');

function createMissionApp(options = {}) {
  const roverUrl = options.roverUrl || process.env.ROVER_URL || 'http://127.0.0.1:3001';
  const eventLog = options.eventLog || new EventLog(options.eventLimit || 100);
  const breaker = options.breaker || new CircuitBreaker({
    failureThreshold: 3,
    resetTimeoutMs: 8000,
    timeoutMs: 1500,
    ...(options.breakerOptions || {}),
  });

  if (!options.skipIntro) {
    eventLog.add('Misión ARES-01 iniciada');
    eventLog.add('Circuit Breaker: CLOSED');
  }

  const app = express();
  app.use(express.json());
  registerRoutes(app, {
    breaker,
    eventLog,
    roverUrl,
    publicDir: options.publicDir,
  });

  return { app, breaker, eventLog, roverUrl };
}

function startMission(port = Number(process.env.PORT) || 3000, options = {}) {
  const mission = createMissionApp(options);
  const server = mission.app.listen(port);
  return { server, ...mission };
}

if (require.main === module) {
  const { server } = startMission();
  server.on('listening', () => {
    const address = server.address();
    console.log(`Mission Control API escuchando en http://localhost:${address.port}`);
  });
  server.on('error', (error) => {
    console.error(`No se pudo iniciar Mission Control: ${error.message}`);
    process.exit(1);
  });
}

module.exports = {
  createMissionApp,
  startMission,
};
