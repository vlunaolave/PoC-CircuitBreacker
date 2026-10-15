/**
 * Arranca los dos procesos de la prueba y los detiene juntos.
 * Mission Control espera a que el rover responda en /health para no
 * registrar un fallo de conexión en el primer instante de la demostración.
 */

const { spawn } = require('node:child_process');
const path = require('node:path');

const roverScript = path.join(__dirname, '..', 'src', 'rover-service', 'server.js');
const missionScript = path.join(__dirname, '..', 'src', 'mission-control', 'server.js');
const roverUrl = process.env.ROVER_URL || 'http://127.0.0.1:3001';

let shuttingDown = false;
let roverProcess;
let missionProcess;

function launch(script) {
  return spawn(process.execPath, [script], {
    stdio: 'inherit',
    env: process.env,
  });
}

function shutdown(code = 0) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  if (missionProcess && !missionProcess.killed) {
    missionProcess.kill('SIGTERM');
  }
  if (roverProcess && !roverProcess.killed) {
    roverProcess.kill('SIGTERM');
  }
  setTimeout(() => process.exit(code), 150);
}

async function waitForRover() {
  const healthUrl = new URL('/health', roverUrl).toString();
  for (let attempt = 1; attempt <= 40; attempt += 1) {
    try {
      const response = await fetch(healthUrl);
      if (response.ok) {
        return;
      }
    } catch {
      // El proceso acaba de arrancar y todavía no acepta conexiones.
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`El servicio del rover no respondió en ${healthUrl}`);
}

async function main() {
  roverProcess = launch(roverScript);
  roverProcess.on('exit', (code) => {
    if (!shuttingDown) {
      console.error(`El servicio del rover terminó (${code ?? 'sin código'}).`);
      shutdown(code || 1);
    }
  });

  await waitForRover();

  missionProcess = launch(missionScript);
  missionProcess.on('exit', (code) => {
    if (!shuttingDown) {
      console.error(`Mission Control terminó (${code ?? 'sin código'}).`);
      shutdown(code || 1);
    }
  });
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

main().catch((error) => {
  console.error(error.message);
  shutdown(1);
});
