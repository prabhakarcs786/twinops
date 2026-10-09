// `npm run dev`: stop any running TwinOps backend/frontend, then start both with prefixed logs.
// `npm run dev:stop`: stop them. Only processes that belong to TwinOps (twinops, uvicorn, vite) are ever killed;
// if a port is held by anything else, the script stops and tells you instead of killing it.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WIN = process.platform === 'win32';
const OURS = /twinops|uvicorn|vite/i;

const dotenvPort = (() => {
  const file = join(ROOT, '.env');
  const match = existsSync(file) && readFileSync(file, 'utf8').match(/^\s*(?:export\s+)?PORT\s*=\s*["']?(\d+)/m);
  return match ? match[1] : undefined;
})();
const API_PORT = Number(process.env.PORT || dotenvPort || 8000);
const WEB_PORT = Number(process.env.TWINOPS_WEB_PORT || 5173);
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
  child.on('exit', (code) => {
    if (stopping) return;
    console.error(`${tag}${code === 0 ? 'stopped (another npm run dev or dev:stop took over)' : `exited with code ${code ?? 'signal'}`}; stopping the other server.`);
    shutdown(code ?? 1);
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

start('api', '36', python, ['-m', 'twinops'], {
  PYTHONPATH: [join(ROOT, 'backend'), process.env.PYTHONPATH].filter(Boolean).join(WIN ? ';' : ':'),
  PYTHONUNBUFFERED: '1',
  TWINOPS_RELOAD: '1',
  HOST: '127.0.0.1',
  PORT: String(API_PORT),
});
start('web', '35', npm, ['--prefix', 'frontend', 'run', 'dev', '--', '--port', String(WEB_PORT), '--strictPort'], { TWINOPS_API_URL: API_URL });

for (let i = 0; i < 60 && !stopping; i++) {
  try {
    if ((await fetch(`${API_URL}/api/health`)).ok) {
      console.log(`\n\x1b[32m✔ TwinOps dev is up\x1b[0m  UI http://localhost:${WEB_PORT}   API ${API_URL}   (Ctrl+C stops both, npm run dev again restarts)\n`);
      break;
    }
  } catch {
    /* backend still starting */
  }
  await sleep(500);
}
