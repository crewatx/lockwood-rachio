const http = require("node:http");
const { spawn } = require("node:child_process");

const basePort = Number(process.env.PORT || 8787);

function startServer(port, extraEnv = {}) {
  const env = {
    ...process.env,
    ...extraEnv,
    PORT: String(port),
    DEMO_MODE: "true",
    WEATHER_TIMEOUT_MS: process.env.WEATHER_TIMEOUT_MS || "250"
  };
  return spawn(process.execPath, ["server.js"], { env, stdio: "pipe" });
}

function request(port, path, method = "GET", body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method,
        headers: {
          ...headers,
          ...(body ? { "content-type": "application/json" } : {})
        }
      },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => resolve({ status: res.statusCode, data, headers: res.headers }));
      }
    );
    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function withServer(port, extraEnv, assertions) {
  const child = startServer(port, extraEnv);
  let finished = false;

  child.on("exit", (code) => {
    if (!finished && code !== null && code !== 0) {
      throw new Error(`Server exited early with ${code}`);
    }
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 450));
    await assertions(port);
  } finally {
    finished = true;
    child.kill();
  }
}

async function runOpenMode(port) {
  const home = await request(port, "/");
  assert(home.status === 200 && home.data.includes("Lockwood Rachio"), `Expected dashboard HTML, got ${home.status}`);

  const session = await request(port, "/api/session");
  const sessionPayload = JSON.parse(session.data);
  assert(sessionPayload.authRequired === false, "Expected open mode session");
  assert(sessionPayload.authenticated === true, "Expected open mode to be authenticated");

  const bootstrap = await request(port, "/api/bootstrap");
  assert(bootstrap.status === 200, `Expected bootstrap 200, got ${bootstrap.status}`);
  const payload = JSON.parse(bootstrap.data);
  assert(payload.devices?.length && payload.devices[0].zones?.length, "Expected demo devices and zones");

  const zoneId = payload.devices[0].zones[0].id;
  const start = await request(port, `/api/zones/${zoneId}/start`, "POST", { duration: 300 });
  assert(start.status === 200, `Expected start 200, got ${start.status}`);
}

async function runProtectedMode(port) {
  const session = await request(port, "/api/session");
  const sessionPayload = JSON.parse(session.data);
  assert(sessionPayload.authRequired === true, "Expected password mode session");
  assert(sessionPayload.authenticated === false, "Expected locked session");

  const lockedBootstrap = await request(port, "/api/bootstrap");
  assert(lockedBootstrap.status === 401, `Expected locked bootstrap 401, got ${lockedBootstrap.status}`);

  const badLogin = await request(port, "/api/login", "POST", { password: "wrong" });
  assert(badLogin.status === 401, `Expected bad login 401, got ${badLogin.status}`);

  const login = await request(port, "/api/login", "POST", { password: "secret-test-password" });
  assert(login.status === 200, `Expected login 200, got ${login.status}`);
  const cookie = login.headers["set-cookie"]?.[0]?.split(";")[0];
  assert(Boolean(cookie), "Expected login session cookie");

  const bootstrap = await request(port, "/api/bootstrap", "GET", null, { Cookie: cookie });
  assert(bootstrap.status === 200, `Expected authenticated bootstrap 200, got ${bootstrap.status}`);
  const payload = JSON.parse(bootstrap.data);
  const zoneId = payload.devices[0].zones[0].id;

  const start = await request(port, `/api/zones/${zoneId}/start`, "POST", { duration: 300 }, { Cookie: cookie });
  assert(start.status === 200, `Expected authenticated start 200, got ${start.status}`);

  const logout = await request(port, "/api/logout", "POST", null, { Cookie: cookie });
  assert(logout.status === 200, `Expected logout 200, got ${logout.status}`);
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function run() {
  await withServer(basePort, { DASHBOARD_PASSWORD: "" }, runOpenMode);
  await withServer(basePort + 1, { DASHBOARD_PASSWORD: "secret-test-password" }, runProtectedMode);
  console.log("Smoke test passed");
}

run().catch((error) => {
  console.error(error.stack || String(error));
  process.exit(1);
});
