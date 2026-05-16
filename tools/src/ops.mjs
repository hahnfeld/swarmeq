import fs from "node:fs";
import { PID_FILE, POLL_FILE } from "./paths.mjs";

export async function configurePoll(arg) {
  if (!arg || arg === "off" || arg === "0") {
    try { fs.unlinkSync(POLL_FILE()); } catch {}
    process.stdout.write("swarmeq poll: disabled\n");
    return;
  }
  const seconds = parseInt(arg, 10);
  if (!Number.isFinite(seconds) || seconds < 5 || seconds > 3600) {
    process.stderr.write("swarmeq poll: interval must be 5-3600 (seconds), or 'off'\n");
    process.exit(2);
  }
  fs.writeFileSync(POLL_FILE(), JSON.stringify({ intervalSec: seconds, ts: Date.now() }));
  process.stdout.write(`swarmeq poll: every ${seconds}s on Stop hook\n`);
}

export async function stopServer() {
  let pid = 0;
  try { pid = parseInt(fs.readFileSync(PID_FILE(), "utf8"), 10); } catch {}
  if (!pid) {
    process.stdout.write("swarmeq stop: no running dashboard\n");
    return;
  }
  try {
    process.kill(pid, "SIGTERM");
    process.stdout.write(`swarmeq stop: signalled pid ${pid}\n`);
  } catch (err) {
    process.stderr.write(`swarmeq stop: pid ${pid} not killable: ${err.message}\n`);
    process.exit(1);
  }
}
