// `npm run dev`: stop any running TwinOps backend/frontend, then start both with prefixed logs.
// `npm run dev:stop`: stop them. Only processes that belong to TwinOps (twinops, uvicorn, vite) are ever killed;
// if a port is held by anything else, the script stops and tells you instead of killing it.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WIN = process.platform === 'win32';
const OURS = /twinops|uvicorn|vite/i;

const dotenv = (() => {
  const file = process.env.TWINOPS_ENV_FILE || join(ROOT, '.env');
  if (!existsSync(file)) return {};
  const values = {};
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.trim().match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if (value.length >= 2 && ['"', "'"].includes(value[0]) && value.at(-1) === value[0]) value = value.slice(1, -1);
    else value = value.split(' #')[0].trim();
    if (value) values[match[1]] = value;
  }
  return values;
})();
const setting = (key, fallback) => process.env[key] || dotenv[key] || fallback;
const API_PORT = Number(setting('PORT', 8000));
const WEB_PORT = Number(setting('TWINOPS_WEB_PORT', 5173));
const NETWORK_PORT = Number(setting('TWINOPS_NETWORK_PORT', 8010));
const CONNECTED = process.argv.includes('--connected');
const API_URL = `http://127.0.0.1:${API_PORT}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const run = (cmd, args) => spawnSync(cmd, args, { encoding: 'utf8' }).stdout ?? '';

function listeners(port) {
  if (WIN) {
    return [...new Set(run('netstat', ['-ano', '-p', 'tcp']).split(/\r?\n/)
      .filter((l) => /LISTENING/i.test(l) && new RegExp(`:${port}\\s`).test(l))
      .map((l) => Number(l.trim().split(/\s+/).at(-1))))];
  }
  return run('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t']).split('\n').filter(Boolean).map(Number);
}

/** A process is ours if it, or one of its parents (e.g. the uvicorn reloader), runs twinops/uvicorn/vite. */
function isOurs(pid) {
  if (WIN) return /python|node|uvicorn/i.test(run('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH']));
  for (let p = pid, depth = 0; p > 1 && depth < 4; depth++) {
    const m = run('ps', ['-o', 'ppid=,command=', '-p', String(p)]).trim().match(/^(\d+)\s+(.*)$/);
    if (!m) return false;
    if (OURS.test(m[2])) return true;
    p = Number(m[1]);
  }
  return false;
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function terminate(pid) {
  if (WIN) {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F']);
    return;
  }
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    return;
  }
  for (let i = 0; i < 50 && alive(pid); i++) await sleep(100);
  if (alive(pid)) process.kill(pid, 'SIGKILL');
}

async function freePort(port, label) {
  const pids = listeners(port);
  const foreign = pids.filter((pid) => !isOurs(pid));
  if (foreign.length) {
    console.error(`✖ Port ${port} (${label}) is used by another program (PID ${foreign.join(', ')}). Not killing it.`);
    console.error(`  Stop it yourself, or choose another port: PORT=<api port> / TWINOPS_WEB_PORT=<ui port> npm run dev`);
    process.exit(1);
  }
  for (const pid of pids) {
    console.log(`• stopping previous ${label} (PID ${pid}) on port ${port}`);
    await terminate(pid);
  }
  for (let i = 0; i < 30 && listeners(port).length; i++) await sleep(100);
}

await freePort(API_PORT, 'backend');
await freePort(WEB_PORT, 'frontend');
if (CONNECTED || process.argv.includes('--stop')) await freePort(NETWORK_PORT, 'network application');
if (process.argv.includes('--stop')) {
  console.log('✔ TwinOps dev servers stopped.');
  process.exit(0);
}

const python = join(ROOT, '.venv', WIN ? 'Scripts/python.exe' : 'bin/python');
if (!existsSync(python)) {
  console.error('✖ Python environment missing. Run once from the repo root:');
  console.error(`  python3 -m venv .venv && ${WIN ? '.venv\\Scripts\\pip' : '.venv/bin/pip'} install -e "backend[dev]"`);
  process.exit(1);
}
const npm = WIN ? 'npm.cmd' : 'npm';
if (!existsSync(join(ROOT, 'frontend', 'node_modules'))) {
  console.log('• installing frontend dependencies (first run)…');
  if (spawnSync(npm, ['--prefix', 'frontend', 'ci'], { cwd: ROOT, stdio: 'inherit', shell: WIN }).status !== 0) process.exit(1);
}

const children = [];
let stopping = false;

function start(name, color, cmd, args, env) {
  const child = spawn(cmd, args, {
    cwd: ROOT,
    env: { ...process.env, FORCE_COLOR: '1', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: !WIN, // own process group, so stopping also reaches grandchildren (vite, uvicorn reload worker)
    shell: WIN,
  });
  const tag = `\x1b[${color}m${name.padEnd(4)}\x1b[0m│ `;
  for (const stream of [child.stdout, child.stderr]) createInterface({ input: stream }).on('line', (line) => console.log(tag + line));
  child.on('exit', (code, signal) => {
    if (stopping) return;
    // Another launcher or dev:stop ends our servers with SIGTERM: a clean handover, not a crash.
    const replaced = code === 0 || signal === 'SIGTERM';
    console.error(`${tag}${replaced ? 'stopped (another npm run dev or dev:stop took over)' : `exited with ${code ?? signal}`}; stopping the other server.`);
    shutdown(replaced ? 0 : code ?? 1);
  });
  children.push(child);
}

async function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (child.exitCode !== null) continue;
    if (WIN) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F']);
    else {
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {
        /* already gone */
      }
    }
  }
  await sleep(1500);
  if (!WIN) for (const child of children) if (alive(child.pid)) try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ }
  process.exit(code);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

const sharedEnv = {
  PYTHONPATH: [join(ROOT, 'backend'), process.env.PYTHONPATH].filter(Boolean).join(WIN ? ';' : ':'),
  PYTHONUNBUFFERED: '1',
};
const connectionEnv = CONNECTED ? {
  TWINOPS_NETWORK_URL: `http://127.0.0.1:${NETWORK_PORT}`,
  TWINOPS_NETWORK_TOKEN: process.env.TWINOPS_NETWORK_TOKEN || randomBytes(32).toString('hex'),
  TWINOPS_TWIN: 'emulated',
  TWINOPS_HARNESS: 'false',
  // Approved changes go through Metro's apply gateway; set TWINOPS_APPLY_ENABLED=false to keep evidence read-only.
  TWINOPS_APPLY_ENABLED: setting('TWINOPS_APPLY_ENABLED', 'true'),
  TWINOPS_DATA_DIR: join(ROOT, 'backend', '.data', 'connected'),
} : {};

if (CONNECTED) {
  // Reuse a deployed lab. Never reconfigure existing containers on a normal restart.
  const status = spawnSync(python, ['-m', 'twinops.lab', 'status'], { cwd: ROOT, env: { ...process.env, ...sharedEnv }, encoding: 'utf8' });
  let lab = { ready: false };
  try { lab = JSON.parse(status.stdout); } catch { /* show setup failure below */ }
  if (!lab.ready) {
    // Links lost after a Docker restart: device state is already gone, so re-deploying loses nothing. Saved evidence is kept.
    const repair = Boolean(lab.linksLost?.length);
    if (repair) console.log(`• ${lab.detail}\n• Re-deploying the lab links; saved evidence in local-app/.data and backend/.data is kept.`);
    else if (existsSync(resolve(ROOT, setting('TWINOPS_NETWORK_DATA', 'local-app/.data/state.json')))) {
      console.error('✖ Saved network state exists but the lab is unavailable. Start Docker / restore the lab before restarting; retained evidence will not be reset.');
      process.exit(1);
    } else console.log('• Preparing the real network lab (first run builds images and starts 18 containers)…');
    for (const command of repair ? ['up'] : ['build', 'up']) {
      const result = await new Promise((resolve) => {
        const child = spawn(python, ['-m', 'twinops.lab', command], { cwd: ROOT, env: { ...process.env, ...sharedEnv }, stdio: 'inherit', detached: !WIN });
        children.push(child);
        child.on('exit', resolve);
        child.on('error', () => resolve(1));
      });
      if (result !== 0) { console.error('✖ Lab setup failed. Check that Docker Desktop is running.'); await shutdown(1); }
    }
  }
  start('net', '32', python, ['-m', 'twinops.network_app'], { ...sharedEnv, ...connectionEnv, TWINOPS_NETWORK_PORT: String(NETWORK_PORT), TWINOPS_UI_URL: `http://localhost:${WEB_PORT}` });
}

start('api', '36', python, ['-m', 'twinops'], {
  ...connectionEnv,
  PYTHONPATH: [join(ROOT, 'backend'), process.env.PYTHONPATH].filter(Boolean).join(WIN ? ';' : ':'),
  PYTHONUNBUFFERED: '1',
  TWINOPS_RELOAD: CONNECTED ? '0' : '1',
  HOST: '127.0.0.1',
  PORT: String(API_PORT),
});
start('web', '35', npm, ['--prefix', 'frontend', 'run', 'dev', '--', '--port', String(WEB_PORT), '--strictPort'], { TWINOPS_API_URL: API_URL });

for (let i = 0; i < 60 && !stopping; i++) {
  try {
    if ((await fetch(`${API_URL}/api/health`)).ok) {
      console.log(`\n\x1b[32m✔ TwinOps dev is up\x1b[0m  UI http://localhost:${WEB_PORT}   API ${API_URL}   (Ctrl+C stops both, npm run dev again restarts)\n`);
      if (CONNECTED) console.log(`  Network dashboard http://localhost:${NETWORK_PORT}\n  Connected applications http://localhost:${WEB_PORT}/connections\n  Lab probes warm up in the background. Ctrl+C stops the apps; lab containers and evidence are retained.\n`);
      break;
    }
  } catch {
    /* backend still starting */
  }
  await sleep(500);
}
