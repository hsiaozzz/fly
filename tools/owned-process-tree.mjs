import { execFile } from "node:child_process";
import { promisify } from "node:util";

const executeFile = promisify(execFile);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function processTable(deadline) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error("Owned process cleanup timed out.");
  const { stdout } = await executeFile("ps", ["-eo", "pid=,ppid=,pgid=,stat="], {
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", LC_ALL: "C" },
    timeout: Math.min(1000, remaining), maxBuffer: 1024 * 1024,
  });
  const table = new Map();
  for (const line of stdout.split("\n")) {
    const fields = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s*$/.exec(line);
    if (fields) {
      const [, pid, ppid, pgid, state] = fields;
      table.set(Number(pid), { pid: Number(pid), ppid: Number(ppid), pgid: Number(pgid), state });
    }
  }
  return table;
}

function descendants(table, roots) {
  const selected = new Map();
  const byParent = new Map();
  for (const row of table.values()) {
    const children = byParent.get(row.ppid) ?? [];
    children.push(row);
    byParent.set(row.ppid, children);
  }
  const pending = [...roots];
  while (pending.length) {
    const row = pending.pop();
    if (selected.has(row.pid)) continue;
    selected.set(row.pid, row);
    pending.push(...(byParent.get(row.pid) ?? []));
  }
  return selected;
}

const running = row => !/^[ZX]/.test(row.state);
function signal(pid, value) {
  try { process.kill(pid, value); }
  catch (error) { if (error.code !== "ESRCH") throw error; }
}

/**
 * Snapshot actual descendants before signalling their parent: Playwright and
 * QA workers create separate process groups. Never infer ownership from a
 * browser name or signal the caller's process group. Complete within four
 * seconds, and fail instead of silently declaring a partial cleanup complete.
 */
export async function stopOwnedPosixTree(child, { graceMs = 500, timeoutMs = 4000 } = {}) {
  if (process.platform === "win32") throw new Error("POSIX process cleanup is not available on Windows.");
  if (!child.pid) return;
  const deadline = Date.now() + Math.min(Math.max(timeoutMs, 1), 4000);
  const first = await processTable(deadline);
  const ownGroup = first.get(process.pid)?.pgid;
  if (!ownGroup) throw new Error("Cannot identify the cleanup caller's process group.");
  const root = first.get(child.pid);
  if (!root) return;
  if (root.ppid !== process.pid) throw new Error("Refusing to signal a process that is not an owned child.");
  const owned = descendants(first, [root]);

  const refresh = table => {
    // Keep previously observed descendants after their parent exits/reparents.
    // A changed group means the PID is no longer the process we observed.
    const roots = [...owned.values()].flatMap(previous => {
      const current = table.get(previous.pid);
      return current?.pgid === previous.pgid ? [current] : [];
    });
    const current = descendants(table, roots);
    for (const row of current.values()) if (row.pid !== process.pid) owned.set(row.pid, row);
    return [...current.values()].filter(row => row.pid !== process.pid && running(row));
  };
  const send = (rows, value) => {
    const groups = new Set();
    // Groups are owned only when their leader was observed in this child tree.
    // Descendants sharing the caller's group receive individual signals.
    for (const row of [...rows].reverse()) {
      if (row.pgid !== ownGroup && owned.has(row.pgid)) groups.add(row.pgid);
      else signal(row.pid, value);
    }
    for (const group of groups) signal(-group, value);
  };

  send(refresh(first), "SIGTERM");
  const graceDeadline = Math.min(deadline, Date.now() + Math.max(graceMs, 0));
  let current;
  while (true) {
    current = refresh(await processTable(deadline));
    if (!current.length) return;
    if (Date.now() >= graceDeadline) break;
    await pause(Math.min(50, graceDeadline - Date.now()));
  }
  send(current, "SIGKILL");
  while (true) {
    current = refresh(await processTable(deadline));
    if (!current.length) return;
    // Catch descendants created between the initial snapshot and TERM.
    send(current, "SIGKILL");
    await pause(Math.min(50, Math.max(0, deadline - Date.now())));
  }
}
