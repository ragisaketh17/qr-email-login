const { spawn, execSync } = require("child_process");
const path = require("path");
const fs = require("fs");

let tunnelProcess = null;

function stopTunnel() {
  if (tunnelProcess && tunnelProcess.pid) {
    try {
      if (process.platform === "win32") {
        execSync(`taskkill /pid ${tunnelProcess.pid} /f /t`, { stdio: "ignore" });
      } else {
        tunnelProcess.kill("SIGTERM");
      }
    } catch (e) {
      // Ignore if process already exited
    }
    tunnelProcess = null;
  }
}

// Clean up tunnel on process exit
process.on("exit", stopTunnel);
process.on("SIGINT", () => {
  stopTunnel();
  process.exit(0);
});
process.on("SIGTERM", () => {
  stopTunnel();
  process.exit(0);
});

function startTunnel(port = 3000, timeoutMs = 20000) {
  return new Promise((resolve) => {
    // Check for local cloudflared executable in project directory
    const localExe = path.join(
      __dirname,
      process.platform === "win32" ? "cloudflared.exe" : "cloudflared"
    );
    const exe = fs.existsSync(localExe) ? localExe : "cloudflared";

    try {
      tunnelProcess = spawn(
        exe,
        ["tunnel", "--url", `http://localhost:${port}`],
        {
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
        }
      );
    } catch (err) {
      console.warn("Could not launch cloudflared:", err.message);
      return resolve(null);
    }

    let resolved = false;
    const tunnelUrlRegex = /https:\/\/(?!api\.)[a-z0-9-]+\.trycloudflare\.com/;

    const onData = (chunk) => {
      if (resolved) return;
      const text = chunk.toString();
      const match = text.match(tunnelUrlRegex);
      if (match) {
        resolved = true;
        resolve(match[0]);
      }
    };

    if (tunnelProcess.stdout) tunnelProcess.stdout.on("data", onData);
    if (tunnelProcess.stderr) tunnelProcess.stderr.on("data", onData);

    tunnelProcess.on("error", (err) => {
      if (!resolved) {
        resolved = true;
        resolve(null);
      }
    });

    tunnelProcess.on("close", () => {
      if (!resolved) {
        resolved = true;
        resolve(null);
      }
    });

    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        resolve(null);
      }
    }, timeoutMs);
  });
}

module.exports = { startTunnel, stopTunnel };
