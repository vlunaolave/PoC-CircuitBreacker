/**
 * Genera una lectura simulada de ARES-01.
 * Los valores se derivan del reloj y de una variación pequeña para que dos
 * consultas separadas no repitan exactamente la misma cifra.
 */

function createTelemetry(now = Date.now()) {
  const slow = Math.sin(now / 20000);
  const complementary = Math.cos(now / 17000);
  const jitter = Math.random() - 0.5;

  return {
    rover: 'ARES-01',
    battery: round(clamp(71 + slow * 8 + jitter * 0.8, 0, 100), 1),
    temperature: round(-61 + complementary * 10 + jitter * 0.4, 1),
    signal: round(clamp(78 + complementary * 12 + jitter, 0, 100), 1),
    speed: round(clamp(0.06 + Math.abs(slow) * 0.48, 0, 3), 2),
    location: {
      x: round(118.2 + slow * 2.2 + jitter * 0.05, 2),
      y: round(-45.4 + complementary * 1.5 + jitter * 0.05, 2),
    },
    systems: 'NOMINAL',
    transmittedAt: new Date(now).toISOString(),
  };
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function round(value, digits) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

module.exports = {
  createTelemetry,
};
