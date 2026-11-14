#!/usr/bin/env node
// Run the API and Vite together with clean shutdown. No external dependency.
import { spawn } from "node:child_process";

const children = new Set();
let stopping = false;

function start(name, args, color) {
  const child = spawn("npm", args, {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env },
  });
  children.add(child);
  const prefix = `\x1b[${color}m[${name}]\x1b[0m `;
  const pipe = (stream, target) => {
    stream.setEncoding("utf8");
    let buffer = "";
    stream.on("data", (chunk) => {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) target.write(`${prefix}${line}\n`);
    });
    stream.on("end", () => {
      if (buffer) target.write(`${prefix}${buffer}\n`);
    });
  };
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);
  child.on("exit", (code) => {
    children.delete(child);
    if (!stopping && code && code !== 0) {
      console.error(`${prefix}exited with code ${code}`);
      shutdown(code);
    }
  });
  return child;
}

function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    child.kill("SIGTERM");
  }
  setTimeout(() => {
    for (const child of children) child.kill("SIGKILL");
    process.exit(code);
  }, 2_000).unref();
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

console.log("QUEUE dev: web http://localhost:4178 · api http://localhost:8789");
start("api", ["-w", "@queue/server", "run", "dev"], "36");
start("web", ["-w", "@queue/web", "run", "dev"], "33");
