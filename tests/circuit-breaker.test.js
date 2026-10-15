const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { CircuitBreaker } = require('../src/circuit-breaker/CircuitBreaker');

function createClock(start = 1_700_000_000_000) {
  let current = start;
  return {
    now() {
      return current;
    },
    advance(ms) {
      current += ms;
    },
  };
}

function createBreaker(clock, overrides = {}) {
  return new CircuitBreaker({
    failureThreshold: 3,
    resetTimeoutMs: 8000,
    timeoutMs: 1500,
    now: () => clock.now(),
    ...overrides,
  });
}

function httpFailure(status) {
  return async () => {
    const error = new Error(`HTTP ${status}`);
    error.kind = 'http';
    error.status = status;
    throw error;
  };
}

function connectionFailure() {
  return async () => {
    const error = new Error('conexión rechazada');
    error.kind = 'connection';
    error.code = 'ECONNREFUSED';
    throw error;
  };
}

async function openWithCache(breaker) {
  const calls = [];
  const action = async () => {
    calls.push('call');
    if (calls.length === 1) {
      return { battery: 70, temperature: -60 };
    }
    const error = new Error('servicio no disponible');
    error.kind = 'http';
    error.status = 503;
    throw error;
  };

  const live = await breaker.execute(action);
  assert.equal(live.ok, true);
  await breaker.execute(action);
  await breaker.execute(action);
  const opened = await breaker.execute(action);
  assert.equal(opened.ok, false);
  assert.equal(breaker.getState(), 'OPEN');
  return calls;
}

describe('Circuit Breaker', () => {
  it('escenario A: una respuesta correcta permanece en CLOSED y reinicia la racha', async () => {
    const clock = createClock();
    const breaker = createBreaker(clock);
    const calls = [];

    await breaker.execute(httpFailure(503));
    const result = await breaker.execute(async () => {
      calls.push('live');
      return { battery: 81 };
    });

    assert.equal(result.ok, true);
    assert.equal(result.stale, false);
    assert.equal(result.source, 'live');
    assert.deepEqual(result.data, { battery: 81 });
    assert.equal(breaker.getState(), 'CLOSED');
    assert.equal(breaker.getStats().consecutiveFailures, 0);
    assert.equal(breaker.getStats().successCount, 1);
    assert.equal(breaker.getStats().remoteCallCount, 2);
    assert.deepEqual(calls, ['live']);
  });

  it('escenario B: tres fallos consecutivos abren el circuito', async () => {
    const clock = createClock();
    const breaker = createBreaker(clock);
    const codes = [];

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const result = await breaker.execute(httpFailure(503));
      codes.push(result.error.code);
    }

    const stats = breaker.getStats();
    assert.deepEqual(codes, ['HTTP_503', 'HTTP_503', 'HTTP_503']);
    assert.equal(stats.state, 'OPEN');
    assert.equal(stats.consecutiveFailures, 3);
    assert.equal(stats.failureCount, 3);
    assert.equal(stats.remoteCallCount, 3);
    assert.equal(stats.blockedCount, 0);
    assert.equal(stats.lastStateChange.from, 'CLOSED');
    assert.equal(stats.lastStateChange.to, 'OPEN');
    assert.equal(stats.remainingMs, 8000);
  });

  it('escenario C: en OPEN no ejecuta la acción y devuelve la última lectura', async () => {
    const clock = createClock();
    const breaker = createBreaker(clock);
    const calls = await openWithCache(breaker);

    const blocked = await breaker.execute(async () => {
      calls.push('no debería ejecutarse');
      return { battery: 1 };
    });

    assert.equal(calls.length, 4);
    assert.equal(blocked.blocked, true);
    assert.equal(blocked.stale, true);
    assert.equal(blocked.source, 'cache');
    assert.equal(blocked.ok, true);
    assert.deepEqual(blocked.data, { battery: 70, temperature: -60 });
    assert.equal(breaker.getStats().blockedCount, 1);
    assert.equal(breaker.getStats().remoteCallCount, 4);

    const again = await breaker.execute(async () => {
      calls.push('tampoco');
      return { battery: 2 };
    });
    assert.equal(again.blocked, true);
    assert.equal(calls.length, 4);
    assert.equal(breaker.getStats().blockedCount, 2);
  });

  it('escenario C: sin datos previos responde circuito abierto y no inventa telemetría', async () => {
    const clock = createClock();
    const breaker = createBreaker(clock);
    await breaker.execute(httpFailure(500));
    await breaker.execute(connectionFailure());
    await breaker.execute(httpFailure(503));

    let called = false;
    const blocked = await breaker.execute(async () => {
      called = true;
      return { battery: 10 };
    });

    assert.equal(called, false);
    assert.equal(blocked.ok, false);
    assert.equal(blocked.data, null);
    assert.equal(blocked.error.code, 'CIRCUIT_OPEN');
    assert.equal(blocked.error.status, 503);
    assert.equal(breaker.getStats().remoteCallCount, 3);
    assert.equal(breaker.getStats().blockedCount, 1);
  });

  it('escenario D: tras la ventana, una prueba exitosa pasa por HALF_OPEN y cierra', async () => {
    const clock = createClock();
    const breaker = createBreaker(clock);
    await openWithCache(breaker);

    clock.advance(7999);
    assert.equal(breaker.getState(), 'OPEN');
    assert.equal(breaker.getStats().remainingMs, 1);

    clock.advance(1);
    assert.equal(breaker.getState(), 'HALF_OPEN');
    assert.equal(breaker.getStats().remoteCallCount, 4);

    const probe = await breaker.execute(async () => ({ battery: 66, temperature: -55 }));
    assert.equal(probe.previousState, 'HALF_OPEN');
    assert.equal(probe.ok, true);
    assert.equal(probe.source, 'live');
    assert.equal(probe.transitionsAfter.some((item) => item.to === 'CLOSED'), true);
    assert.equal(breaker.getState(), 'CLOSED');
    assert.equal(breaker.getStats().consecutiveFailures, 0);
    assert.equal(breaker.getStats().remoteCallCount, 5);
    assert.equal(breaker.getStats().remainingMs, 0);
  });

  it('escenario E: una prueba fallida en HALF_OPEN vuelve a OPEN y reinicia la espera', async () => {
    const clock = createClock();
    const breaker = createBreaker(clock);
    await openWithCache(breaker);

    clock.advance(8000);
    assert.equal(breaker.getState(), 'HALF_OPEN');

    const probe = await breaker.execute(httpFailure(503));
    assert.equal(probe.ok, false);
    assert.equal(probe.error.code, 'HTTP_503');
    assert.equal(probe.transitionsAfter.some((item) => item.from === 'HALF_OPEN' && item.to === 'OPEN'), true);
    assert.equal(breaker.getState(), 'OPEN');
    assert.equal(breaker.getStats().remainingMs, 8000);
    assert.equal(breaker.getStats().consecutiveFailures, 3);

    clock.advance(7999);
    assert.equal(breaker.getState(), 'OPEN');
    clock.advance(1);
    assert.equal(breaker.getState(), 'HALF_OPEN');
  });

  it('escenario F: un timeout cuenta como fallo de disponibilidad y puede abrir el circuito', async () => {
    const clock = createClock();
    const breaker = createBreaker(clock, { timeoutMs: 40 });

    const first = await breaker.execute(() => new Promise(() => {}));
    assert.equal(first.error.code, 'TIMEOUT');
    assert.equal(first.error.status, 504);
    assert.equal(breaker.getState(), 'CLOSED');
    assert.equal(breaker.getStats().failureCount, 1);
    assert.equal(breaker.getStats().consecutiveFailures, 1);
    assert.equal(breaker.getStats().remoteCallCount, 1);

    await breaker.execute(() => new Promise(() => {}));
    await breaker.execute(() => new Promise(() => {}));
    assert.equal(breaker.getState(), 'OPEN');
    assert.equal(breaker.getStats().failureCount, 3);
    assert.equal(breaker.getStats().remoteCallCount, 3);
  });

  it('escenario G: en HALF_OPEN solo una solicitud concurrente llega a la acción', async () => {
    const clock = createClock();
    const breaker = createBreaker(clock);
    await openWithCache(breaker);
    clock.advance(8000);
    assert.equal(breaker.getState(), 'HALF_OPEN');

    const calls = [];
    let release;
    const action = () => {
      calls.push('probe');
      return new Promise((resolve) => {
        release = () => resolve({ battery: 64 });
      });
    };

    const remoteBefore = breaker.getStats().remoteCallCount;
    const first = breaker.execute(action);
    const second = breaker.execute(action);
    const third = breaker.execute(action);

    const blockedResults = await Promise.all([second, third]);
    assert.equal(blockedResults.every((result) => result.blocked && result.source === 'cache'), true);
    assert.equal(breaker.getStats().probeInFlight, true);
    assert.equal(breaker.getStats().remoteCallCount, remoteBefore + 1);

    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls.length, 1);

    release();
    const probe = await first;
    assert.equal(probe.ok, true);
    assert.equal(probe.source, 'live');
    assert.equal(calls.length, 1);
    assert.equal(breaker.getState(), 'CLOSED');
    assert.equal(breaker.getStats().blockedCount, 2);
  });

  it('un HTTP 4xx no cuenta como fallo de disponibilidad ni borra la racha', async () => {
    const clock = createClock();
    const breaker = createBreaker(clock);

    await breaker.execute(httpFailure(503));
    await breaker.execute(httpFailure(503));
    const clientError = await breaker.execute(httpFailure(404));

    assert.equal(clientError.ok, false);
    assert.equal(clientError.error.status, 404);
    assert.equal(clientError.error.code, 'HTTP_404');
    assert.equal(breaker.getStats().consecutiveFailures, 2);
    assert.equal(breaker.getStats().failureCount, 2);
    assert.equal(breaker.getState(), 'CLOSED');

    await breaker.execute(httpFailure(503));
    assert.equal(breaker.getState(), 'OPEN');
  });

  it('consultar el estado no dispara la acción al pasar a HALF_OPEN', async () => {
    const clock = createClock();
    const breaker = createBreaker(clock);
    const calls = await openWithCache(breaker);

    clock.advance(8000);
    const stats = breaker.getStats();
    assert.equal(stats.state, 'HALF_OPEN');
    assert.equal(calls.length, 4);
    assert.equal(stats.remoteCallCount, 4);
  });

  it('reiniciar deja el circuito cerrado, sin caché ni contadores', async () => {
    const clock = createClock();
    const breaker = createBreaker(clock);
    await openWithCache(breaker);
    await breaker.execute(async () => ({ battery: 1 }));

    breaker.reset();
    const stats = breaker.getStats();
    assert.equal(stats.state, 'CLOSED');
    assert.equal(stats.blockedCount, 0);
    assert.equal(stats.remoteCallCount, 0);
    assert.equal(stats.failureCount, 0);
    assert.equal(stats.successCount, 0);
    assert.equal(stats.hasCache, false);

    let called = false;
    const result = await breaker.execute(async () => {
      called = true;
      return { battery: 12 };
    });
    assert.equal(called, true);
    assert.equal(result.source, 'live');
  });
});
