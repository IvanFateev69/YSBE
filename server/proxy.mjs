import { spawn } from 'node:child_process';
import fs from 'node:fs';

const FIFO = '/tmp/mcp-fifo';
const OUT = '/tmp/mcp-out.jsonl';

const child = spawn('node', ['index.js'], {
  stdio: ['pipe', 'pipe', 'inherit'],
});

const out = fs.createWriteStream(OUT, { flags: 'a' });

const sent = new Set();
const done = new Set();
const outbound = [];
let buffer = '';
let fifoLine = '';

function flush() {
  while (outbound.length > 0) {
    const outstanding = [...sent].filter((s) => !done.has(s));
    if (outstanding.length > 0) break;
    const line = outbound.shift();
    let id = null;
    try {
      const m = JSON.parse(line);
      id = m.id ?? null;
    } catch {}
    if (id !== null) sent.add(id);
    child.stdin.write(line + '\n');
    if (id !== null) break;
  }
}

child.stdout.on('data', (d) => {
  buffer += d.toString();
  let idx;
  while ((idx = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 1);
    if (!line.trim()) continue;
    out.write(line + '\n');
    try {
      const msg = JSON.parse(line);
      if (msg.id !== undefined && msg.id !== null) {
        done.add(msg.id);
        flush();
      }
    } catch {}
  }
});

const fifoStream = fs.createReadStream(FIFO);
fifoStream.on('data', (d) => {
  fifoLine += d.toString();
  let idx;
  while ((idx = fifoLine.indexOf('\n')) >= 0) {
    const line = fifoLine.slice(0, idx);
    fifoLine = fifoLine.slice(idx + 1);
    if (!line.trim()) continue;
    outbound.push(line);
  }
  flush();
});
