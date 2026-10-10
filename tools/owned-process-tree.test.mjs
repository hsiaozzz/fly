import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { stopOwnedPosixTree } from "./owned-process-tree.mjs";

const posix = { skip: process.platform === "win32" };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const source = `
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const [role, directory] = process.argv.slice(2);
if (role !== 'root') process.on('SIGTERM', () => {});
if (role === 'root' || role === 'branch') {
  spawn(process.execPath, [process.argv[1], role === 'root' ? 'branch' : 'leaf', directory], { detached: true, stdio: 'ignore' });
}
writeFileSync(directory + '/' + role + '.pid', String(process.pid));
setInterval(() => {}, 1000);
`;

async function fixture(t, detached = true) {
  const directory = await mkdtemp(path.join(tmpdir(), "arcane-owned-tree-test-"));
  const script = path.join(directory, "fixture.mjs");
  await writeFile(script, source);
  const pids = new Set();
  const children = [];
  t.after(async () => {
    // Test cleanup can signal only PIDs created by this controlled fixture.
    for (const child of children) child.kill("SIGKILL");
    for (const pid of pids) {
      try { process.kill(pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
    }
    await rm(directory, { recursive: true, force: true });
  });
  const launch = (role, detached) => {
    const child = spawn(process.execPath, [script, role, directory], { detached, stdio: "ignore" });
    children.push(child); pids.add(child.pid);
    return child;
  };
  const root = launch("root", detached);
  const sibling = launch("sibling", detached);
  const deadline = Date.now() + 3000;
  for (const role of ["root", "branch", "leaf", "sibling"]) {
    while (true) {
      const pid = await readFile(path.join(directory, `${role}.pid`), "utf8").then(Number, error => {
        if (error.code !== "ENOENT") throw error;
      });
      if (pid) { pids.add(pid); break; }
      assert.ok(Date.now() < deadline, `${role} fixture must become ready`);
      await delay(20);
    }
  }
  const tree = await Promise.all(["root", "branch", "leaf"].map(async role => Number(await readFile(path.join(directory, `${role}.pid`), "utf8"))));
  return { root, sibling, tree };
}

async function live(pid) {
  try {
    process.kill(pid, 0);
    // A reparented Linux zombie has exited and cannot retain work or files.
    if (process.platform === "linux") {
      const stat = await readFile(`/proc/${pid}/stat`, "utf8");
      return !/\) [ZX] /.test(stat);
    }
    return true;
  } catch (error) {
    if (error.code === "ESRCH" || error.code === "ENOENT") return false;
    throw error;
  }
}

async function assertStopped(tree, sibling) {
  for (const pid of tree) assert.equal(await live(pid), false, `owned PID ${pid} must have exited`);
  assert.equal(await live(sibling.pid), true, "an unrelated sibling must survive cleanup");
}

test("timeout cleans three detached generations after their root exits", posix, async t => {
  const { root, sibling, tree } = await fixture(t);
  const started = Date.now();
  await new Promise((resolve, reject) => {
    setTimeout(() => { void stopOwnedPosixTree(root, { graceMs: 100 }).then(resolve, reject); }, 20);
  });
  assert.ok(Date.now() - started < 5000, "cleanup must remain bounded");
  await assertStopped(tree, sibling);
});

test("abort cleans detached descendants and preserves unrelated processes", posix, async t => {
  const { root, sibling, tree } = await fixture(t);
  const controller = new AbortController();
  const stopped = new Promise((resolve, reject) => {
    controller.signal.addEventListener("abort", () => {
      void stopOwnedPosixTree(root, { graceMs: 100 }).then(resolve, reject);
    }, { once: true });
  });
  const started = Date.now();
  controller.abort(new Error("controlled cancellation"));
  await stopped;
  assert.ok(Date.now() - started < 5000, "cleanup must remain bounded");
  await assertStopped(tree, sibling);
});

test("cleanup never signals the caller's shared process group", posix, async t => {
  const { root, sibling, tree } = await fixture(t, false);
  await stopOwnedPosixTree(root, { graceMs: 100 });
  await assertStopped(tree, sibling);
});

test("cleanup refuses a PID outside the owned child tree", posix, async () => {
  await assert.rejects(stopOwnedPosixTree({ pid: process.pid }), /not an owned child/);
});
