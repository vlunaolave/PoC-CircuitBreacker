/**
 * Controla el modo de falla del rover durante la demostración local.
 * También cuenta las peticiones de telemetría que sí entran al proceso,
 * para comprobar que un circuito OPEN no las deja pasar.
 */

const MODES = new Set(['normal', 'fail', 'timeout']);

class FaultController {
  constructor() {
    this.mode = 'normal';
    this.requestCount = 0;
    this.timeoutDelayMs = 3000;
    this.responseDelayMs = 0;
  }

  setMode(mode) {
    if (!MODES.has(mode)) {
      const error = new Error(`Modo no reconocido: ${mode}`);
      error.status = 400;
      throw error;
    }
    this.mode = mode;
  }

  recordRequest() {
    this.requestCount += 1;
  }

  setTimeoutDelay(delayMs) {
    this.timeoutDelayMs = normalizeDelay(delayMs, this.timeoutDelayMs);
  }

  setResponseDelay(delayMs) {
    this.responseDelayMs = normalizeDelay(delayMs, 0);
  }

  reset() {
    this.mode = 'normal';
    this.requestCount = 0;
    this.timeoutDelayMs = 3000;
    this.responseDelayMs = 0;
  }

  snapshot() {
    return {
      mode: this.mode,
      requestCount: this.requestCount,
      timeoutDelayMs: this.timeoutDelayMs,
      responseDelayMs: this.responseDelayMs,
    };
  }
}

function normalizeDelay(value, fallback) {
  const delay = Number(value);
  if (!Number.isFinite(delay) || delay < 0) {
    return fallback;
  }
  return delay;
}

module.exports = {
  FaultController,
};
