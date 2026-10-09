const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const port = process.env.PORT || "3000";
const projectRoot = __dirname;
const projectEnvPath = path.join(projectRoot, ".env");

if (fs.existsSync(projectEnvPath)) {
  const projectPasswordIsSet = fs
    .readFileSync(projectEnvPath, "utf8")
    .split(/\r?\n/)
    .some((line) => /^\s*DASHBOARD_PASSWORD\s*=/.test(line));

  if (projectPasswordIsSet) {
    delete process.env.DASHBOARD_PASSWORD;
  }
}

const startServer = (extraEnv = {}, onExit = () => {}) => {
  const server = spawn(process.execPath, [path.join(projectRoot, "server.js")], {
    cwd: projectRoot,
    env: { ...process.env, ...extraEnv },
    stdio: "inherit",
  });

  server.on("error", (error) => {
    console.error(`Could not start the app: ${error.message}`);
    process.exitCode = 1;
  });
  server.on("exit", (code, signal) => {
    onExit();
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exitCode = code ?? 1;
  });

  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => {
      if (!server.killed) server.kill(signal);
    });
  }
};

const isHosted =
  Boolean(process.env.VERCEL) ||
  Boolean(process.env.RENDER) ||
  Boolean(process.env.RENDER_SERVICE_ID);

if (process.env.PUBLIC_URL?.trim() || isHosted) {
  startServer();
} else {
  const cloudflaredPath =
    process.env.CLOUDFLARED_PATH ||
    path.join(projectRoot, process.platform === "win32" ? "cloudflared.exe" : "cloudflared");

  if (!fs.existsSync(cloudflaredPath) && !process.env.CLOUDFLARED_PATH) {
    console.error(
      `cloudflared was not found at "${cloudflaredPath}". Install Cloudflare Tunnel, set CLOUDFLARED_PATH, or set PUBLIC_URL to an existing public URL.`
    );
    process.exit(1);
  }

  const tunnel = spawn(
    cloudflaredPath,
    ["tunnel", "--url", `http://localhost:${port}`],
    { cwd: projectRoot, stdio: ["ignore", "ignore", "pipe"] }
  );

  let output = "";
  let serverStarted = false;
  let failed = false;
  let startupTimer;

  const cleanup = () => {
    clearTimeout(startupTimer);
    if (!tunnel.killed) tunnel.kill();
  };

  const fail = (message) => {
    if (serverStarted || failed) return;
    failed = true;
    console.error(message);
    if (output.trim()) console.error(output.trim());
    cleanup();
    process.exitCode = 1;
  };

  tunnel.stderr.setEncoding("utf8");
  tunnel.stderr.on("data", (chunk) => {
    if (serverStarted) {
      process.stderr.write(chunk);
      return;
    }
    output = (output + chunk).slice(-8192);
    const match = output.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
    if (!match || serverStarted) return;

    serverStarted = true;
    clearTimeout(startupTimer);
    console.log(`Mobile-data link: ${match[0]}`);
    startServer({ PUBLIC_URL: match[0] }, cleanup);
  });

  tunnel.on("error", (error) => {
    fail(`Could not start Cloudflare Tunnel: ${error.message}`);
  });
  tunnel.on("exit", (code) => {
    if (!serverStarted) {
      fail(`Cloudflare Tunnel exited before creating a public link (exit code ${code}).`);
    }
  });

  startupTimer = setTimeout(() => {
    fail("Timed out waiting for Cloudflare Tunnel to create a public link.");
  }, 60000);

  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, cleanup);
  }
}
