const http = require("node:http");
const { spawn } = require("node:child_process");

const port = Number(process.env.PORT || 8787);
const env = { ...process.env, PORT: String(port), DEMO_MODE: "true" };
const child = spawn(process.execPath, ["server.js"], { env, stdio: "pipe" });

let finished = false;

function fail(message) {
  if (finished) return;
  finished = true;
  child.kill();
  console.error(message);
  process.exit(1);
}

function pass() {
  if (finished) return;
  finished = true;
  child.kill();
  console.log("Smoke test passed");
}

function request(path, method = "GET", body = null) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method,
        headers: body ? { "content-type": "application/json" } : undefined
      },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => resolve({ status: res.statusCode, data }));
      }
    );
    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function run() {
  await new Promise((resolve) => setTimeout(resolve, 450));

  const home = await request("/");
  if (home.status !== 200 || !home.data.includes("Rachio Ocean")) {
    fail(`Expected dashboard HTML, got ${home.status}`);
  }

  const bootstrap = await request("/api/bootstrap");
  if (bootstrap.status !== 200) {
    fail(`Expected bootstrap 200, got ${bootstrap.status}`);
  }
  const payload = JSON.parse(bootstrap.data);
  if (!payload.devices?.length || !payload.devices[0].zones?.length) {
    fail("Expected demo devices and zones");
  }

  const zoneId = payload.devices[0].zones[0].id;
  const start = await request(`/api/zones/${zoneId}/start`, "POST", { duration: 300 });
  if (start.status !== 200) {
    fail(`Expected start 200, got ${start.status}`);
  }

  pass();
}

child.on("exit", (code) => {
  if (!finished && code !== null && code !== 0) {
    fail(`Server exited early with ${code}`);
  }
});

run().catch((error) => fail(error.stack || String(error)));
