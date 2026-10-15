const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { createRoverApp } = require('../src/rover-service/server');
const { FaultController } = require('../src/rover-service/fault-controller');
const { createMissionApp } = require('../src/mission-control/server');

const RESET_TIMEOUT_MS = 300;
const BREAKER_TIMEOUT_MS = 200;

describe('integración Mission Control y rover', { timeout: 20000 }, () => {
  let roverServer;
  let missionServer;
  let rover;
  let missionBase;
  let roverBase;

  before(async () => {
    const controller = new FaultController();
    rover = await listen(createRoverApp(controller));
    roverBase = `http://127.0.0.1:${rover.port}`;

    const mission = createMissionApp({
      roverUrl: roverBase,
      breakerOptions: {
        failureThreshold: 3,
        resetTimeoutMs: RESET_TIMEOUT_MS,
        timeoutMs: BREAKER_TIMEOUT_MS,
      },
    });
    missionServer = await listen(mission.app);
    missionBase = `http://127.0.0.1:${missionServer.port}`;
    roverServer = rover.server;
  });

  after(async () => {
    await close(missionServer.server);
    await close(roverServer);
  });

  beforeEach(async () => {
    const reset = await api('/api/simulation/reset', { method: 'POST', body: {} });
    assert.equal(reset.status, 200);
    assert.equal(reset.body.circuit.state, 'CLOSED');
  });

  it('escenario A: el rover responde, el circuito sigue CLOSED y el panel recibe datos reales', async () => {
    const reading = await api('/api/telemetry');
    assert.equal(reading.status, 200);
    assert.equal(reading.body.ok, true);
    assert.equal(reading.body.stale, false);
    assert.equal(reading.body.source, 'live');
    assert.equal(reading.body.telemetry.rover, 'ARES-01');
    assert.equal(typeof reading.body.telemetry.battery, 'number');
    assert.equal(typeof reading.body.telemetry.temperature, 'number');
    assert.equal(typeof reading.body.telemetry.signal, 'number');
    assert.equal(typeof reading.body.telemetry.speed, 'number');
    assert.equal(typeof reading.body.telemetry.location.x, 'number');
    assert.equal(typeof reading.body.telemetry.location.y, 'number');
    assert.equal(reading.body.telemetry.systems, 'NOMINAL');
    assert.equal(reading.body.circuit.state, 'CLOSED');
    assert.equal(reading.body.circuit.remoteCallCount, 1);

    const before = await roverStats();
    await api('/api/status');
    await api('/api/status');
    await api('/api/events');
    const after = await roverStats();
    assert.equal(after.requestCount, before.requestCount);
    assert.equal(after.requestCount, 1);
  });

  it('escenario B y C: tres fallos abren el circuito y las siguientes consultas no llegan al rover', async () => {
    const live = await api('/api/telemetry');
    assert.equal(live.body.source, 'live');
    const knownBattery = live.body.telemetry.battery;

    await api('/api/simulation/fail', { method: 'POST', body: {} });
    const failures = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      failures.push(await api('/api/telemetry'));
    }

    assert.equal(failures[0].status, 503);
    assert.equal(failures[2].body.circuit.state, 'OPEN');
    assert.equal(failures[2].body.circuit.consecutiveFailures, 3);
    assert.equal(failures[2].body.error.code, 'HTTP_503');

    const remoteAfterOpen = await roverStats();
    const started = Date.now();
    const blocked = await api('/api/telemetry');
    const elapsed = Date.now() - started;
    const remoteAfterBlock = await roverStats();

    assert.equal(blocked.status, 200);
    assert.equal(blocked.body.stale, true);
    assert.equal(blocked.body.source, 'cache');
    assert.equal(blocked.body.blocked, true);
    assert.equal(blocked.body.telemetry.battery, knownBattery);
    assert.match(blocked.body.message, /desactualizados/i);
    assert.equal(remoteAfterBlock.requestCount, remoteAfterOpen.requestCount);
    assert.equal(blocked.body.circuit.blockedCount, 1);
    assert.ok(elapsed < 500, `la respuesta bloqueada tardó ${elapsed} ms`);

    const recovered = await api('/api/simulation/recover', { method: 'POST', body: {} });
    assert.notEqual(recovered.body.circuit.state, 'CLOSED');
  });

  it('escenario D: restaurar el rover no cierra el circuito; lo cierra la prueba exitosa', async () => {
    await api('/api/telemetry');
    await api('/api/simulation/fail', { method: 'POST', body: {} });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await api('/api/telemetry');
    }

    await api('/api/simulation/recover', { method: 'POST', body: {} });
    const notClosed = await api('/api/status');
    assert.notEqual(notClosed.body.circuit.state, 'CLOSED');

    await delay(RESET_TIMEOUT_MS + 120);
    const halfOpen = await api('/api/status');
    assert.equal(halfOpen.body.circuit.state, 'HALF_OPEN');

    const probe = await api('/api/telemetry');
    assert.equal(probe.status, 200);
    assert.equal(probe.body.source, 'live');
    assert.equal(probe.body.stale, false);
    assert.equal(probe.body.circuit.state, 'CLOSED');

    const events = await api('/api/events');
    const messages = events.body.events.map((event) => event.message);
    assert.ok(messages.includes('Circuit Breaker: HALF_OPEN'));
    assert.ok(messages.includes('Consulta de recuperación exitosa'));
    assert.ok(messages.includes('Circuit Breaker: CLOSED'));
  });

  it('escenario E: si la prueba de HALF_OPEN falla, el circuito regresa a OPEN', async () => {
    await api('/api/simulation/fail', { method: 'POST', body: {} });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await api('/api/telemetry');
    }

    await delay(RESET_TIMEOUT_MS + 120);
    const halfOpen = await api('/api/status');
    assert.equal(halfOpen.body.circuit.state, 'HALF_OPEN');

    const probe = await api('/api/telemetry');
    assert.equal(probe.body.ok, false);
    assert.equal(probe.body.circuit.state, 'OPEN');
    assert.ok(probe.body.circuit.remainingMs > RESET_TIMEOUT_MS / 2);

    const events = await api('/api/events');
    const messages = events.body.events.map((event) => event.message);
    assert.ok(messages.some((message) => message.startsWith('Consulta de recuperación fallida')));
    assert.equal(messages.filter((message) => message === 'Circuit Breaker: OPEN').length >= 2, true);
  });

  it('escenario F: una demora superior al máximo cuenta como timeout y sí llega al rover', async () => {
    const mode = await fetch(`${roverBase}/simulation/timeout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ delayMs: 800 }),
    });
    assert.equal(mode.status, 200);

    const started = Date.now();
    const reading = await api('/api/telemetry');
    const elapsed = Date.now() - started;
    const stats = await roverStats();

    assert.equal(reading.status, 504);
    assert.equal(reading.body.error.code, 'TIMEOUT');
    assert.equal(reading.body.circuit.state, 'CLOSED');
    assert.equal(reading.body.circuit.consecutiveFailures, 1);
    assert.equal(stats.requestCount, 1);
    assert.ok(elapsed < 700, `el timeout tardó ${elapsed} ms`);
  });

  it('escenario G: durante HALF_OPEN solo una de las consultas concurrentes llega al rover', async () => {
    await api('/api/telemetry');
    await api('/api/simulation/fail', { method: 'POST', body: {} });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await api('/api/telemetry');
    }
    await api('/api/simulation/recover', { method: 'POST', body: {} });

    const delayResponse = await fetch(`${roverBase}/simulation/delay`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // Por debajo del timeout del circuito (200 ms) para que la prueba
      // llegue a responder, pero lo bastante larga para que las otras
      // solicitudes concurrentes encuentren la prueba ya en curso.
      body: JSON.stringify({ delayMs: 120 }),
    });
    assert.equal(delayResponse.status, 200);

    await delay(RESET_TIMEOUT_MS + 120);
    const halfOpen = await api('/api/status');
    assert.equal(halfOpen.body.circuit.state, 'HALF_OPEN');

    const before = await roverStats();
    const results = await Promise.all([
      api('/api/telemetry'),
      api('/api/telemetry'),
      api('/api/telemetry'),
    ]);
    const after = await roverStats();

    const live = results.filter((result) => result.body.source === 'live');
    const cached = results.filter((result) => result.body.source === 'cache' && result.body.blocked);
    const summary = results.map((result) => ({
      status: result.status,
      source: result.body.source,
      blocked: result.body.blocked,
      error: result.body.error?.code ?? null,
    }));
    assert.equal(live.length, 1, JSON.stringify(summary));
    assert.equal(cached.length, 2, JSON.stringify(summary));
    assert.equal(after.requestCount, before.requestCount + 1);
    assert.equal(live[0].body.circuit.state, 'CLOSED');
  });

  async function api(path, options = {}) {
    const response = await fetch(`${missionBase}${path}`, {
      method: options.method || 'GET',
      headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    const body = await response.json();
    return { status: response.status, body };
  }

  async function roverStats() {
    const response = await fetch(`${roverBase}/simulation/stats`);
    return response.json();
  }
});

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port });
    });
  });
}

function close(server) {
  if (!server) return Promise.resolve();
  return new Promise((resolve) => {
    server.close(() => resolve());
    // fetch mantiene los sockets abiertos; sin esto close() no termina.
    server.closeAllConnections();
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
