/**
 * Circuit Breaker reutilizable.
 *
 * No conoce el dominio de MarsGuard: envuelve cualquier acción asíncrona.
 * La ventana de recuperación usa el reloj inyectado en `now`, de modo que
 * las pruebas pueden avanzarla sin esperar el tiempo real. El tiempo máximo
 * de la acción sí usa un temporizador real, porque debe interrumpir una
 * promesa que no termina.
 */

const STATES = Object.freeze({
  CLOSED: 'CLOSED',
  OPEN: 'OPEN',
  HALF_OPEN: 'HALF_OPEN',
});

const CONNECTION_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'ECONNRESET',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
]);

function cloneValue(value) {
  if (typeof structuredClone !== 'function') {
    return value;
  }
  try {
    return structuredClone(value);
  } catch {
    return value;
  }
}

class CircuitBreaker {
  constructor(options = {}) {
    if (options.now !== undefined && typeof options.now !== 'function') {
      throw new TypeError('now debe ser una función que devuelva milisegundos');
    }

    this.failureThreshold = options.failureThreshold ?? 3;
    this.resetTimeoutMs = options.resetTimeoutMs ?? 8000;
    this.timeoutMs = options.timeoutMs ?? 1500;
    this.now = options.now ?? (() => Date.now());

    if (this.failureThreshold < 1) {
      throw new RangeError('failureThreshold debe ser al menos 1');
    }
    if (this.resetTimeoutMs < 0 || this.timeoutMs < 0) {
      throw new RangeError('los tiempos no pueden ser negativos');
    }

    this.state = STATES.CLOSED;
    this.consecutiveFailures = 0;
    this.successCount = 0;
    this.failureCount = 0;
    this.blockedCount = 0;
    this.remoteCallCount = 0;
    this.openedAt = null;
    this.probeInFlight = false;
    this.lastSuccess = null;
    this.unreadTransitions = [];
    this.lastStateChange = {
      at: this.now(),
      from: null,
      to: STATES.CLOSED,
    };
  }

  getState() {
    this.#maybeTransitionToHalfOpen();
    return this.state;
  }

  /**
   * Consultar el estado puede pasar de OPEN a HALF_OPEN cuando vence la
   * ventana, pero nunca ejecuta la acción protegida.
   */
  getStats() {
    this.#maybeTransitionToHalfOpen();
    return this.#snapshot();
  }

  consumeTransitions() {
    return this.#takeTransitions();
  }

  reset() {
    this.state = STATES.CLOSED;
    this.consecutiveFailures = 0;
    this.successCount = 0;
    this.failureCount = 0;
    this.blockedCount = 0;
    this.remoteCallCount = 0;
    this.openedAt = null;
    this.probeInFlight = false;
    this.lastSuccess = null;
    this.unreadTransitions = [];
    this.lastStateChange = {
      at: this.now(),
      from: null,
      to: STATES.CLOSED,
    };
  }

  async execute(action) {
    if (typeof action !== 'function') {
      throw new TypeError('execute espera una función');
    }

    this.#maybeTransitionToHalfOpen();
    const transitionsBefore = this.#takeTransitions();
    const previousState = this.state;

    const blocked =
      this.state === STATES.OPEN ||
      (this.state === STATES.HALF_OPEN && this.probeInFlight);

    if (blocked) {
      return {
        ...this.#block(),
        previousState,
        transitionsBefore,
        transitionsAfter: [],
      };
    }

    if (this.state === STATES.HALF_OPEN) {
      // La marca queda puesta antes del primer await. Así, las solicitudes
      // que entren mientras la prueba sigue en curso no disparan otra llamada.
      this.probeInFlight = true;
    }

    this.remoteCallCount += 1;
    const controller = new AbortController();

    try {
      const value = await this.#withTimeout(action, controller);
      this.#onSuccess(value);
      return {
        ok: true,
        stale: false,
        source: 'live',
        blocked: false,
        data: value,
        cachedAt: null,
        message: 'Operación completada',
        error: null,
        consecutiveFailures: this.consecutiveFailures,
        previousState,
        transitionsBefore,
        transitionsAfter: this.#takeTransitions(),
      };
    } catch (error) {
      const classified = this.#classify(error);
      if (classified.availabilityFailure) {
        this.#onAvailabilityFailure();
      } else {
        // Un HTTP 4xx indica que el servicio respondió. No es un fallo de
        // disponibilidad: no abre el circuito ni reinicia la racha.
        this.probeInFlight = false;
      }

      return {
        ok: false,
        stale: false,
        source: null,
        blocked: false,
        data: null,
        cachedAt: null,
        message: classified.message,
        error: {
          code: classified.code,
          status: classified.status,
          message: classified.message,
        },
        consecutiveFailures: this.consecutiveFailures,
        previousState,
        transitionsBefore,
        transitionsAfter: this.#takeTransitions(),
      };
    }
  }

  #block() {
    this.blockedCount += 1;

    if (this.lastSuccess) {
      return {
        ok: true,
        stale: true,
        source: 'cache',
        blocked: true,
        data: this.lastSuccess.value,
        cachedAt: this.lastSuccess.at,
        message:
          'Circuito abierto. Se entregan los últimos datos conocidos; pueden estar desactualizados.',
        error: null,
        consecutiveFailures: this.consecutiveFailures,
      };
    }

    return {
      ok: false,
      stale: false,
      source: null,
      blocked: true,
      data: null,
      cachedAt: null,
      message:
        'Circuito abierto. No hay datos previos y el servicio remoto no recibe esta solicitud.',
      error: {
        code: 'CIRCUIT_OPEN',
        status: 503,
        message:
          'Circuito abierto. No hay datos previos y el servicio remoto no recibe esta solicitud.',
      },
      consecutiveFailures: this.consecutiveFailures,
    };
  }

  #onSuccess(value) {
    this.probeInFlight = false;
    this.consecutiveFailures = 0;
    this.successCount += 1;
    // Se conserva el último resultado real. No se generan datos nuevos.
    this.lastSuccess = {
      value: cloneValue(value),
      at: this.now(),
    };
    if (this.state !== STATES.CLOSED) {
      this.#transition(STATES.CLOSED);
    }
  }

  #onAvailabilityFailure() {
    this.probeInFlight = false;
    this.failureCount += 1;

    if (this.state === STATES.HALF_OPEN) {
      // Una prueba fallida basta para reabrir. El contador queda en el umbral
      // para mostrar que la condición de apertura sigue cumplida.
      this.consecutiveFailures = this.failureThreshold;
      this.#transition(STATES.OPEN);
      return;
    }

    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= this.failureThreshold) {
      this.#transition(STATES.OPEN);
    }
  }

  #transition(next) {
    if (this.state === next) {
      return;
    }
    const from = this.state;
    const at = this.now();
    this.state = next;
    this.lastStateChange = { at, from, to: next };
    if (next === STATES.OPEN) {
      this.openedAt = at;
    }
    if (next === STATES.CLOSED) {
      this.openedAt = null;
    }
    this.unreadTransitions.push({ from, to: next, at });
  }

  #maybeTransitionToHalfOpen() {
    if (this.state !== STATES.OPEN || this.openedAt === null) {
      return;
    }
    if (this.now() - this.openedAt >= this.resetTimeoutMs) {
      this.#transition(STATES.HALF_OPEN);
    }
  }

  #remainingMs() {
    if (this.state !== STATES.OPEN || this.openedAt === null) {
      return 0;
    }
    return Math.max(0, this.resetTimeoutMs - (this.now() - this.openedAt));
  }

  #snapshot() {
    return {
      state: this.state,
      consecutiveFailures: this.consecutiveFailures,
      successCount: this.successCount,
      failureCount: this.failureCount,
      blockedCount: this.blockedCount,
      remoteCallCount: this.remoteCallCount,
      lastStateChange: { ...this.lastStateChange },
      remainingMs: this.#remainingMs(),
      timeoutMs: this.timeoutMs,
      resetTimeoutMs: this.resetTimeoutMs,
      failureThreshold: this.failureThreshold,
      hasCache: this.lastSuccess !== null,
      cachedAt: this.lastSuccess ? this.lastSuccess.at : null,
      probeInFlight: this.probeInFlight,
    };
  }

  #takeTransitions() {
    const items = this.unreadTransitions;
    this.unreadTransitions = [];
    return items;
  }

  #withTimeout(action, controller) {
    return new Promise((resolve, reject) => {
      let settled = false;

      const finish = (settle, value) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        settle(value);
      };

      const timer = setTimeout(() => {
        controller.abort();
        const error = new Error('Tiempo de respuesta agotado');
        error.kind = 'timeout';
        error.code = 'TIMEOUT';
        finish(reject, error);
      }, this.timeoutMs);

      Promise.resolve()
        .then(() => action({ signal: controller.signal }))
        .then(
          (value) => finish(resolve, value),
          (error) => finish(reject, error),
        );
    });
  }

  #classify(error) {
    const code = error?.code;
    const kind = error?.kind;

    if (
      kind === 'timeout' ||
      code === 'TIMEOUT' ||
      code === 'ECONNABORTED' ||
      code === 'ERR_CANCELED' ||
      error?.name === 'CanceledError'
    ) {
      return {
        availabilityFailure: true,
        code: 'TIMEOUT',
        status: 504,
        message: 'La solicitud superó el tiempo máximo de respuesta.',
      };
    }

    if (kind === 'connection' || CONNECTION_CODES.has(code)) {
      return {
        availabilityFailure: true,
        code: 'CONNECTION',
        status: 503,
        message: 'No se pudo establecer conexión con el servicio remoto.',
      };
    }

    const status =
      typeof error?.status === 'number' ? error.status : error?.response?.status;

    if (typeof status === 'number' && status >= 500) {
      return {
        availabilityFailure: true,
        code: `HTTP_${status}`,
        status,
        message: `El servicio remoto respondió con HTTP ${status}.`,
      };
    }

    if (typeof status === 'number' && status >= 400 && status < 500) {
      return {
        availabilityFailure: false,
        code: `HTTP_${status}`,
        status,
        message: `El servicio remoto respondió con HTTP ${status}. Esta respuesta no se considera un fallo de disponibilidad.`,
      };
    }

    return {
      availabilityFailure: true,
      code: 'CONNECTION',
      status: 503,
      message: 'Fallo de comunicación con el servicio remoto.',
    };
  }
}

module.exports = {
  CircuitBreaker,
  STATES,
};
