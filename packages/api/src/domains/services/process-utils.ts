import { execSync, spawn } from 'node:child_process';
import { resolveScriptPath } from './service-logs.js';

const IS_WIN32 = process.platform === 'win32';

/** Check if a PID's command line matches the service (prevents killing unrelated processes). */
export function isServiceProcess(
  pid: number,
  manifest: { id: string; scripts: { start?: string | { unix: string; windows: string } } },
): boolean {
  const startScript = manifest.scripts.start;
  if (!startScript) return false;
  const scriptPath = resolveScriptPath(startScript);
  try {
    let cmd: string;
    if (IS_WIN32) {
      cmd = execSync(
        `powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"ProcessId = ${pid}\\" | Select-Object -ExpandProperty CommandLine"`,
        { encoding: 'utf-8', timeout: 5000 },
      ).trim();
    } else {
      cmd = execSync(`ps -o command= -p ${pid}`, { encoding: 'utf-8', timeout: 2000 }).trim();
    }
    const scriptBasename = scriptPath.replace(/.*[\\/]/, '');
    if (cmd.includes(scriptBasename) || cmd.includes(scriptPath)) return true;
    const serviceDir = scriptPath.replace(/[\\/][^\\/]+$/, '');
    if (serviceDir && cmd.includes(serviceDir)) return true;
    const prefix = scriptBasename.replace(/[-_](server|start|run)\.\w+$/, '');
    if (prefix.length >= 3 && cmd.includes(prefix)) return true;
    return false;
  } catch {
    return false;
  }
}

/** Check if a process matching a command-line pattern is running. */
export async function checkProcessByPattern(pattern: string | { unix: string; windows: string }): Promise<boolean> {
  const pat = resolveScriptPath(pattern);
  return new Promise((resolve) => {
    let cmd: ReturnType<typeof spawn>;
    if (IS_WIN32) {
      const escaped = pat.replace(/'/g, "''").replace(/\\/g, '\\\\');
      cmd = spawn(
        'powershell',
        [
          '-NoProfile',
          '-Command',
          `Get-CimInstance Win32_Process -Filter "CommandLine like '%${escaped}%'" | Select-Object -ExpandProperty ProcessId`,
        ],
        { stdio: ['pipe', 'pipe', 'pipe'] },
      );
    } else {
      cmd = spawn('pgrep', ['-f', pat], { stdio: ['pipe', 'pipe', 'pipe'] });
    }
    let out = '';
    cmd.stdout?.on('data', (d: Buffer) => {
      out += d.toString();
    });
    cmd.on('close', () => resolve(out.trim().length > 0));
    cmd.on('error', () => resolve(false));
  });
}

/** Find PIDs listening on a given port (cross-platform). */
export async function findPidsByPort(port: number): Promise<number[]> {
  const myPid = process.pid;
  const parse = (stdout: string) =>
    stdout
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n) && n > 0 && n !== myPid);

  const run = (command: string, args: string[]): Promise<string> =>
    new Promise((resolve) => {
      const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
      let out = '';
      child.stdout?.on('data', (d: Buffer) => {
        out += d.toString();
      });
      child.on('error', () => resolve(''));
      child.on('close', () => resolve(out));
    });

  if (!IS_WIN32) {
    const out = await run('lsof', ['-ti', `TCP:${port}`, '-sTCP:LISTEN']);
    return parse(out);
  }

  const psOut = await run('powershell', [
    '-NoProfile',
    '-Command',
    `Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess`,
  ]);
  const pids = parse(psOut);
  if (pids.length > 0) return pids;

  // Fallback: netstat works without admin privileges
  const nsOut = await run('cmd', ['/c', `netstat -aon`]);
  const portPattern = `:${port} `;
  return nsOut
    .split('\n')
    .filter((l) => l.includes(portPattern) && l.includes('LISTENING'))
    .map((l) => Number(l.trim().split(/\s+/).pop()))
    .filter((n) => Number.isFinite(n) && n > 0 && n !== myPid);
}

/** Kill a process on Windows using taskkill (kills process tree). */
export function winTaskKill(pid: number): boolean {
  if (!IS_WIN32) return false;
  try {
    execSync(`taskkill /PID ${pid} /F /T`, { timeout: 5000, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
