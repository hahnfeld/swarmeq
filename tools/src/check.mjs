import { record } from "./record.mjs";

// Current-session probe: read the report payload from stdin (JSON) and persist
// it. Invoked by `/swarmeq-check` and by the Stop hook in poll mode.
export async function runCheck() {
  const body = await readStdin();
  if (!body.trim()) {
    process.stderr.write("swarmeq check: no input on stdin\n");
    process.exit(2);
  }
  let obj;
  try { obj = JSON.parse(body); } catch (err) {
    process.stderr.write(`swarmeq check: invalid JSON on stdin: ${err.message}\n`);
    process.exit(2);
  }
  try {
    const stored = await record(obj);
    process.stdout.write(JSON.stringify({ ok: true, agent: stored.agent, ts: stored.ts }) + "\n");
  } catch (err) {
    process.stderr.write(`swarmeq check: ${err.message}\n`);
    process.exit(1);
  }
}

function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve("");
    let buf = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => { buf += c; });
    process.stdin.on("end", () => resolve(buf));
  });
}
