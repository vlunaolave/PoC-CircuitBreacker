/**
 * Panel de MarsGuard.
 * El estado y los eventos salen de Mission Control.
 * La telemetría no se consulta sola: solo el botón correspondiente llama a /api/telemetry.
 */

const telemetryPanel = document.querySelector('#telemetry-panel');
const banner = document.querySelector('#telemetry-banner');
const eventLog = document.querySelector('#event-log');
const linkState = document.querySelector('#link-state');
const opsLamp = document.querySelector('#ops-lamp');
const opsLabel = document.querySelector('#ops-label');
const localClock = document.querySelector('#local-clock');

const fields = {
  battery: document.querySelector('#battery-value'),
  temperature: document.querySelector('#temperature-value'),
  signal: document.querySelector('#signal-value'),
  speed: document.querySelector('#speed-value'),
  x: document.querySelector('#coord-x'),
  y: document.querySelector('#coord-y'),
  transmitted: document.querySelector('#transmitted-at'),
  source: document.querySelector('#source-label'),
  systems: document.querySelector('#systems-chip'),
  batteryMeter: document.querySelector('#battery-meter'),
  signalMeter: document.querySelector('#signal-meter'),
  dot: document.querySelector('#coord-dot'),
  line: document.querySelector('#battery-line'),
  state: document.querySelector('#stat-state'),
  failures: document.querySelector('#stat-failures'),
  blocked: document.querySelector('#stat-blocked'),
  remote: document.querySelector('#stat-remote'),
  recovery: document.querySelector('#stat-recovery'),
  change: document.querySelector('#stat-change'),
  totals: document.querySelector('#stat-totals'),
  lastEvent: document.querySelector('#stat-event'),
};

const buttons = {
  telemetry: document.querySelector('#btn-telemetry'),
  fail: document.querySelector('#btn-fail'),
  timeout: document.querySelector('#btn-timeout'),
  recover: document.querySelector('#btn-recover'),
  reset: document.querySelector('#btn-reset'),
};

const linkCopy = {
  WAITING: 'En espera',
  CLOSED: 'Enlace estable',
  OPEN: 'Enlace interrumpido',
  HALF_OPEN: 'Verificando enlace',
};

const batterySamples = [];
let recoverySnapshot = { state: 'CLOSED', remainingMs: 0, at: 0 };
let displayedTelemetry = null;

buttons.telemetry.addEventListener('click', () => consultTelemetry());
buttons.fail.addEventListener('click', () => sendSimulation(buttons.fail, '/api/simulation/fail'));
buttons.timeout.addEventListener('click', () => sendSimulation(buttons.timeout, '/api/simulation/timeout'));
buttons.recover.addEventListener('click', () => sendSimulation(buttons.recover, '/api/simulation/recover'));
buttons.reset.addEventListener('click', () => resetDemo());

tickClock();
setInterval(tickClock, 1000);
setInterval(paintRecovery, 100);
refreshPanels();
setInterval(refreshPanels, 1000);

async function consultTelemetry() {
  await withButton(buttons.telemetry, async () => {
    const { response, payload } = await requestJson('/api/telemetry', { method: 'GET' });
    applyTelemetry(payload, response.ok);
    if (payload.circuit) {
      renderCircuit(payload.circuit);
    }
    await refreshPanels();
  });
}

async function sendSimulation(button, url) {
  await withButton(button, async () => {
    await requestJson(url, { method: 'POST', body: {} });
    await refreshPanels();
  });
}

async function resetDemo() {
  await withButton(buttons.reset, async () => {
    await requestJson('/api/simulation/reset', { method: 'POST', body: {} });
    displayedTelemetry = null;
    batterySamples.length = 0;
    paintTrace();
    clearReadouts();
    await refreshPanels();
  });
}

async function refreshPanels() {
  try {
    const [statusResponse, eventsResponse] = await Promise.all([
      requestJson('/api/status', { method: 'GET' }),
      requestJson('/api/events', { method: 'GET' }),
    ]);
    opsLamp.classList.add('is-on');
    opsLamp.classList.remove('is-warn');
    opsLabel.textContent = 'Sistema operativo';
    renderCircuit(statusResponse.payload.circuit);
    renderEvents(eventsResponse.payload.events || []);
  } catch (error) {
    opsLamp.classList.remove('is-on');
    opsLamp.classList.add('is-warn');
    opsLabel.textContent = 'Sin contacto con Mission Control';
    showBanner(error.message, true);
  }
}

function applyTelemetry(payload, httpOk) {
  if (payload.telemetry && payload.source === 'live') {
    displayedTelemetry = payload.telemetry;
    batterySamples.push(payload.telemetry.battery);
    if (batterySamples.length > 24) {
      batterySamples.shift();
    }
    paintTelemetry(payload.telemetry, false);
    paintTrace();
    showBanner('', false);
    return;
  }

  if (payload.telemetry && payload.stale) {
    displayedTelemetry = payload.telemetry;
    paintTelemetry(payload.telemetry, true);
    const when = formatStamp(payload.cachedAt);
    showBanner(`${payload.message} Última lectura válida: ${when}.`, false);
    return;
  }

  if (!httpOk) {
    showBanner(payload.message || 'La consulta no pudo completarse.', true);
  }
}

function paintTelemetry(telemetry, stale) {
  telemetryPanel.classList.toggle('is-stale', stale);
  fields.battery.textContent = formatNumber(telemetry.battery, 1);
  fields.temperature.textContent = formatNumber(telemetry.temperature, 1);
  fields.signal.textContent = formatNumber(telemetry.signal, 1);
  fields.speed.textContent = formatNumber(telemetry.speed, 2);
  fields.x.textContent = formatNumber(telemetry.location?.x, 2);
  fields.y.textContent = formatNumber(telemetry.location?.y, 2);
  fields.transmitted.textContent = formatStamp(telemetry.transmittedAt);
  fields.systems.textContent = `Sistemas ${telemetry.systems || '—'}`;
  fields.source.textContent = stale ? 'Caché del circuito' : 'Lectura en vivo';
  fields.batteryMeter.style.width = `${clamp(telemetry.battery, 0, 100)}%`;
  fields.signalMeter.style.width = `${clamp(telemetry.signal, 0, 100)}%`;
  placeDot(telemetry.location);
}

function clearReadouts() {
  telemetryPanel.classList.remove('is-stale');
  for (const key of ['battery', 'temperature', 'signal', 'speed', 'x', 'y']) {
    fields[key].textContent = '—';
  }
  fields.transmitted.textContent = 'Sin transmisión';
  fields.systems.textContent = 'Sistemas sin lectura';
  fields.source.textContent = 'Consulta manual';
  fields.batteryMeter.style.width = '0';
  fields.signalMeter.style.width = '0';
  fields.dot.setAttribute('cx', '50');
  fields.dot.setAttribute('cy', '36');
  banner.hidden = true;
}

function renderCircuit(circuit) {
  if (!circuit) return;
  recoverySnapshot = {
    state: circuit.state,
    remainingMs: circuit.remainingMs,
    at: performance.now(),
  };
  const link = communicationLabel(circuit.state);
  linkState.dataset.state = link;
  linkState.textContent = linkCopy[link];

  document.querySelectorAll('.state-track li').forEach((item) => {
    const active = item.dataset.state === circuit.state;
    item.classList.toggle('is-active', active);
    if (active) {
      item.setAttribute('aria-current', 'true');
    } else {
      item.removeAttribute('aria-current');
    }
  });

  fields.state.textContent = circuit.state;
  fields.failures.textContent = `${circuit.consecutiveFailures} / ${circuit.failureThreshold}`;
  fields.blocked.textContent = String(circuit.blockedCount);
  fields.remote.textContent = String(circuit.remoteCallCount);
  fields.totals.textContent = `${circuit.successCount} / ${circuit.failureCount}`;
  fields.change.textContent = formatChange(circuit.lastStateChange);
  paintRecovery();
}

function paintRecovery() {
  if (recoverySnapshot.state === 'OPEN') {
    const left = Math.max(0, recoverySnapshot.remainingMs - (performance.now() - recoverySnapshot.at));
    fields.recovery.textContent = `${(left / 1000).toFixed(1)} s`;
    return;
  }
  fields.recovery.textContent = recoverySnapshot.state === 'HALF_OPEN'
    ? 'Lista para la prueba'
    : 'No requerida';
}

function renderEvents(events) {
  const latest = events[events.length - 1];
  fields.lastEvent.textContent = latest ? latest.message : '—';
  eventLog.replaceChildren();
  events.forEach((event) => {
    const row = document.createElement('p');
    const time = document.createElement('time');
    time.dateTime = event.at;
    time.textContent = `[${formatClock(event.at)}]`;
    row.append(time, document.createTextNode(` ${event.message}`));
    eventLog.append(row);
  });
  eventLog.scrollTop = eventLog.scrollHeight;
}

function communicationLabel(state) {
  if (state === 'OPEN') return 'OPEN';
  if (state === 'HALF_OPEN') return 'HALF_OPEN';
  if (displayedTelemetry && !telemetryPanel.classList.contains('is-stale')) return 'CLOSED';
  return 'WAITING';
}

function paintTrace() {
  if (batterySamples.length === 0) {
    fields.line.setAttribute('d', '');
    return;
  }
  if (batterySamples.length === 1) {
    fields.line.setAttribute('d', 'M 0 16 L 100 16');
    return;
  }
  const low = Math.min(...batterySamples);
  const high = Math.max(...batterySamples);
  const pad = Math.max(0.8, (high - low) * 0.25);
  const min = low - pad;
  const max = high + pad;
  const span = max - min;
  const commands = batterySamples.map((value, index) => {
    const x = batterySamples.length === 1 ? 0 : (index / (batterySamples.length - 1)) * 100;
    const y = 28 - ((value - min) / span) * 24;
    return `${index === 0 ? 'M' : 'L'} ${x.toFixed(2)} ${y.toFixed(2)}`;
  });
  fields.line.setAttribute('d', commands.join(' '));
}

function placeDot(location) {
  if (!location) return;
  const x = clamp((location.x - 112) / 14, 0, 1);
  const y = clamp((location.y + 50) / 8, 0, 1);
  fields.dot.setAttribute('cx', (10 + x * 80).toFixed(1));
  fields.dot.setAttribute('cy', (62 - y * 52).toFixed(1));
}

function showBanner(message, isError) {
  if (!message) {
    banner.hidden = true;
    banner.textContent = '';
    return;
  }
  banner.hidden = false;
  banner.textContent = message;
  banner.classList.toggle('is-error', isError);
}

async function requestJson(url, options) {
  const response = await fetch(url, {
    method: options.method,
    headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  let payload = {};
  try {
    payload = await response.json();
  } catch {
    payload = { message: 'La respuesta no trae datos legibles.' };
  }
  if (!response.ok && !payload.message && !payload.circuit) {
    throw new Error('Mission Control rechazó la solicitud.');
  }
  return { response, payload };
}

async function withButton(button, action) {
  button.disabled = true;
  try {
    await action();
  } catch (error) {
    showBanner(error.message, true);
  } finally {
    button.disabled = false;
  }
}

function tickClock() {
  const now = new Date();
  localClock.dateTime = now.toISOString();
  localClock.textContent = now.toLocaleTimeString('es-CO', { hour12: false });
}

function formatChange(change) {
  if (!change || !change.to) return 'Estado inicial';
  if (!change.from) return `Inicio ${formatClock(change.at)}`;
  return `${change.from} → ${change.to}`;
}

function formatStamp(iso) {
  if (!iso) return 'sin marca de tiempo';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'sin marca de tiempo';
  return date.toLocaleString('es-CO', {
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function formatClock(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '--:--:--';
  return date.toLocaleTimeString('es-CO', { hour12: false });
}

function formatNumber(value, digits) {
  return typeof value === 'number' ? value.toFixed(digits) : '—';
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
