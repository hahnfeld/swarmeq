import fs from "node:fs";
import { PID_FILE } from "./paths.ts";

export async function stopServer(): Promise<void> {
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
    process.stderr.write(`swarmeq stop: pid ${pid} not killable: ${(err as Error).message}\n`);
    process.exit(1);
  }
}
