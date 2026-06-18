const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");
const { fileURLToPath } = require("node:url");

const root = __dirname;
const publicDir = path.join(root, "public");
const port = Number(process.env.PORT || 8080);
const rachioBaseUrl = process.env.RACHIO_BASE_URL || "https://api.rach.io/1/public";
const rachioToken = process.env.RACHIO_API_TOKEN || "";
const demoMode = process.env.DEMO_MODE !== "false";

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8",
  ".ico": "image/x-icon"
};

const demoState = createDemoState();

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (url.pathname.startsWith("/api/")) {
      await handleApi(req, res, url);
      return;
    }

    await serveStatic(req, res, url);
  } catch (error) {
    sendJson(res, statusFromError(error), {
      error: error.publicMessage || "Unexpected server error",
      detail: process.env.NODE_ENV === "production" ? undefined : error.message
    });
  }
});

server.listen(port, () => {
  console.log(`Rachio Ocean dashboard listening on http://localhost:${port}`);
});

async function handleApi(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/health") {
    sendJson(res, 200, { ok: true, hasToken: Boolean(rachioToken), demoMode: isDemoActive() });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/bootstrap") {
    sendJson(res, 200, await getBootstrapData());
    return;
  }

  const zoneStartMatch = url.pathname.match(/^\/api\/zones\/([^/]+)\/start$/);
  if (req.method === "POST" && zoneStartMatch) {
    const body = await readJsonBody(req);
    const duration = normalizeDuration(body.duration);
    const zoneId = decodeURIComponent(zoneStartMatch[1]);
    await startZone(zoneId, duration);
    sendJson(res, 200, { ok: true, zoneId, duration });
    return;
  }

  const zoneStopMatch = url.pathname.match(/^\/api\/zones\/([^/]+)\/stop$/);
  if (req.method === "POST" && zoneStopMatch) {
    const zoneId = decodeURIComponent(zoneStopMatch[1]);
    await stopZone(zoneId);
    sendJson(res, 200, { ok: true, zoneId });
    return;
  }

  const deviceStopMatch = url.pathname.match(/^\/api\/devices\/([^/]+)\/stop$/);
  if (req.method === "POST" && deviceStopMatch) {
    const deviceId = decodeURIComponent(deviceStopMatch[1]);
    await stopDevice(deviceId);
    sendJson(res, 200, { ok: true, deviceId });
    return;
  }

  sendJson(res, 404, { error: "API route not found" });
}

async function getBootstrapData() {
  if (isDemoActive()) {
    return getDemoBootstrap();
  }

  const info = await rachioFetch("/person/info");
  if (!info.id) {
    throw publicError(502, "Rachio did not return an account id");
  }

  const person = await rachioFetch(`/person/${encodeURIComponent(info.id)}`);
  return normalizePerson(person, false);
}

async function startZone(zoneId, duration) {
  if (isDemoActive()) {
    const zone = findDemoZone(zoneId);
    const now = new Date();
    demoState.running = {
      zoneId,
      deviceId: zone.deviceId,
      startedAt: now.toISOString(),
      endsAt: new Date(now.getTime() + duration * 1000).toISOString(),
      duration
    };
    demoState.activity.unshift({
      id: `manual-${Date.now()}`,
      label: `Manual run started for ${zone.name}`,
      when: now.toISOString(),
      tone: "active"
    });
    return;
  }

  await rachioFetch("/zone/start", {
    method: "PUT",
    body: { id: zoneId, duration }
  });
}

async function stopZone(zoneId) {
  if (isDemoActive()) {
    const zone = findDemoZone(zoneId);
    const now = new Date();
    if (demoState.running?.zoneId === zoneId) {
      demoState.running = null;
    }
    demoState.activity.unshift({
      id: `stop-${Date.now()}`,
      label: `Watering stopped for ${zone.name}`,
      when: now.toISOString(),
      tone: "idle"
    });
    return;
  }

  await rachioFetch("/zone/stop", {
    method: "PUT",
    body: { id: zoneId }
  });
}

async function stopDevice(deviceId) {
  if (isDemoActive()) {
    const now = new Date();
    demoState.running = null;
    demoState.activity.unshift({
      id: `device-stop-${Date.now()}`,
      label: "All watering stopped",
      when: now.toISOString(),
      tone: "idle"
    });
    return;
  }

  await rachioFetch("/device/stop_water", {
    method: "PUT",
    body: { id: deviceId }
  });
}

async function rachioFetch(endpoint, options = {}) {
  if (!rachioToken) {
    throw publicError(400, "Set RACHIO_API_TOKEN to connect live Rachio data");
  }

  const response = await fetch(`${rachioBaseUrl}${endpoint}`, {
    method: options.method || "GET",
    headers: {
      Authorization: `Bearer ${rachioToken}`,
      Accept: "application/json",
      "Content-Type": "application/json"
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });

  const text = await response.text();
  let payload = null;

  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { raw: text };
    }
  }

  if (!response.ok) {
    const message = payload?.message || payload?.error || `Rachio API returned ${response.status}`;
    throw publicError(response.status, message);
  }

  return payload || {};
}

function normalizePerson(person, demo) {
  const devices = Array.isArray(person.devices) ? person.devices.map(normalizeDevice) : [];
  const activity = devices.flatMap((device) => buildActivity(device)).slice(0, 8);

  return {
    demo,
    hasToken: Boolean(rachioToken),
    generatedAt: new Date().toISOString(),
    account: {
      id: person.id,
      name: person.fullName || person.username || "Rachio Account",
      email: person.email || person.username || ""
    },
    devices,
    activity
  };
}

function normalizeDevice(device) {
  const zones = Array.isArray(device.zones)
    ? device.zones
        .filter((zone) => !zone.deleted)
        .sort((a, b) => Number(a.zoneNumber || 0) - Number(b.zoneNumber || 0))
        .map((zone) => normalizeZone(zone, device))
    : [];

  const scheduleRules = Array.isArray(device.scheduleRules)
    ? device.scheduleRules.filter((rule) => !rule.deleted).map((rule) => normalizeSchedule(rule, zones))
    : [];

  return {
    id: device.id,
    name: device.name || "Rachio Controller",
    model: device.model || "Rachio",
    status: device.status || (device.connected === false ? "offline" : "online"),
    enabled: device.enabled !== false,
    latitude: device.latitude,
    longitude: device.longitude,
    timeZone: device.timeZone || device.timezone || "",
    rainDelayExpirationDate: device.rainDelayExpirationDate || null,
    on: Boolean(device.on),
    zones,
    scheduleRules,
    raw: {
      serialNumber: device.serialNumber,
      macAddress: device.macAddress
    }
  };
}

function normalizeZone(zone, device) {
  return {
    id: zone.id,
    deviceId: device.id,
    name: zone.name || `Zone ${zone.zoneNumber || ""}`.trim(),
    enabled: zone.enabled !== false,
    number: zone.zoneNumber || null,
    type: zone.type || zone.cropType || "Turf",
    soilType: zone.soilType || "Loam",
    shade: zone.shade || "mixed",
    slope: zone.slope || "flat",
    area: zone.yardAreaSquareFeet || zone.area || null,
    availableWater: zone.availableWater || null,
    efficiency: zone.efficiency || null,
    rootZoneDepth: zone.rootZoneDepth || null,
    runtime: zone.runtime || null,
    fixedRuntime: zone.fixedRuntime || null,
    lastWateredDate: zone.lastWateredDate || null,
    saturatedDepthOfWater: zone.saturatedDepthOfWater || null
  };
}

function normalizeSchedule(rule, zones) {
  const zoneNamesById = Object.fromEntries(zones.map((zone) => [zone.id, zone.name]));
  const zoneRuns = Array.isArray(rule.zones)
    ? rule.zones.map((zone) => ({
        id: zone.zoneId || zone.id,
        name: zoneNamesById[zone.zoneId || zone.id] || "Zone",
        duration: zone.duration || zone.runtime || null
      }))
    : [];

  return {
    id: rule.id,
    name: rule.name || "Watering schedule",
    enabled: rule.enabled !== false,
    type: rule.type || rule.scheduleJobTypes || "schedule",
    startDate: rule.startDate || null,
    startTime: rule.startTime || null,
    frequency: rule.frequency || rule.period || rule.operator || "",
    totalDuration: zoneRuns.reduce((sum, zone) => sum + Number(zone.duration || 0), 0),
    zones: zoneRuns
  };
}

function buildActivity(device) {
  const events = [];
  if (device.rainDelayExpirationDate) {
    events.push({
      id: `${device.id}-rain-delay`,
      label: `${device.name} rain delay active`,
      when: device.rainDelayExpirationDate,
      tone: "paused"
    });
  }
  for (const schedule of device.scheduleRules || []) {
    events.push({
      id: `${device.id}-${schedule.id}`,
      label: `${schedule.name} ${schedule.enabled ? "enabled" : "paused"}`,
      when: schedule.startDate || new Date().toISOString(),
      tone: schedule.enabled ? "scheduled" : "paused"
    });
  }
  return events;
}

function getDemoBootstrap() {
  expireDemoRunIfNeeded();
  const person = normalizePerson(demoState.person, true);
  person.devices = person.devices.map((device) => ({
    ...device,
    zones: device.zones.map((zone) => ({
      ...zone,
      running: demoState.running?.zoneId === zone.id,
      runningUntil: demoState.running?.zoneId === zone.id ? demoState.running.endsAt : null
    }))
  }));
  person.activity = [...demoState.activity, ...person.activity].slice(0, 8);
  return person;
}

function createDemoState() {
  const now = new Date();
  const tomorrow = new Date(now.getTime() + 26 * 60 * 60 * 1000);
  return {
    running: {
      zoneId: "demo-zone-front",
      deviceId: "demo-controller",
      startedAt: new Date(now.getTime() - 8 * 60 * 1000).toISOString(),
      endsAt: new Date(now.getTime() + 6 * 60 * 1000).toISOString(),
      duration: 900
    },
    activity: [
      {
        id: "demo-activity-1",
        label: "Weather intelligence skipped backyard beds",
        when: new Date(now.getTime() - 2 * 60 * 60 * 1000).toISOString(),
        tone: "saved"
      },
      {
        id: "demo-activity-2",
        label: "Morning turf cycle completed",
        when: new Date(now.getTime() - 7 * 60 * 60 * 1000).toISOString(),
        tone: "scheduled"
      }
    ],
    person: {
      id: "demo-person",
      fullName: "Demo Home",
      email: "",
      devices: [
        {
          id: "demo-controller",
          name: "North Yard Controller",
          model: "Rachio 3",
          status: "online",
          connected: true,
          enabled: true,
          timeZone: "America/Chicago",
          latitude: 32.78,
          longitude: -96.8,
          zones: [
            {
              id: "demo-zone-front",
              name: "Front Turf",
              zoneNumber: 1,
              enabled: true,
              type: "Warm season grass",
              soilType: "Sandy loam",
              shade: "full sun",
              slope: "slight",
              yardAreaSquareFeet: 1550,
              efficiency: 0.72,
              rootZoneDepth: 6,
              availableWater: 0.16,
              saturatedDepthOfWater: 0.74
            },
            {
              id: "demo-zone-beds",
              name: "Foundation Beds",
              zoneNumber: 2,
              enabled: true,
              type: "Shrubs",
              soilType: "Loam",
              shade: "mixed",
              slope: "flat",
              yardAreaSquareFeet: 430,
              efficiency: 0.81,
              rootZoneDepth: 10,
              availableWater: 0.22,
              saturatedDepthOfWater: 0.41
            },
            {
              id: "demo-zone-back",
              name: "Back Lawn",
              zoneNumber: 3,
              enabled: true,
              type: "Turf",
              soilType: "Clay loam",
              shade: "afternoon",
              slope: "flat",
              yardAreaSquareFeet: 2100,
              efficiency: 0.68,
              rootZoneDepth: 6,
              availableWater: 0.2,
              saturatedDepthOfWater: 0.62
            },
            {
              id: "demo-zone-garden",
              name: "Raised Garden",
              zoneNumber: 4,
              enabled: false,
              type: "Vegetables",
              soilType: "Compost blend",
              shade: "morning",
              slope: "flat",
              yardAreaSquareFeet: 180,
              efficiency: 0.9,
              rootZoneDepth: 8,
              availableWater: 0.28,
              saturatedDepthOfWater: 0.32
            }
          ],
          scheduleRules: [
            {
              id: "demo-schedule-1",
              name: "Smart morning cycle",
              enabled: true,
              type: "flex daily",
              startDate: tomorrow.toISOString(),
              startTime: "05:10",
              zones: [
                { zoneId: "demo-zone-front", duration: 1200 },
                { zoneId: "demo-zone-back", duration: 1500 }
              ]
            },
            {
              id: "demo-schedule-2",
              name: "Beds deep soak",
              enabled: true,
              type: "fixed interval",
              startDate: new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000).toISOString(),
              startTime: "06:20",
              zones: [{ zoneId: "demo-zone-beds", duration: 900 }]
            }
          ]
        }
      ]
    }
  };
}

function expireDemoRunIfNeeded() {
  if (demoState.running && new Date(demoState.running.endsAt).getTime() <= Date.now()) {
    const zone = findDemoZone(demoState.running.zoneId);
    demoState.activity.unshift({
      id: `complete-${Date.now()}`,
      label: `${zone.name} manual run completed`,
      when: new Date().toISOString(),
      tone: "scheduled"
    });
    demoState.running = null;
  }
}

function findDemoZone(zoneId) {
  for (const device of demoState.person.devices) {
    for (const zone of device.zones) {
      if (zone.id === zoneId) {
        return { ...zone, deviceId: device.id };
      }
    }
  }
  throw publicError(404, "Zone not found");
}

function isDemoActive() {
  return demoMode && !rachioToken;
}

function normalizeDuration(value) {
  const duration = Number(value);
  if (!Number.isFinite(duration) || duration < 60 || duration > 7200) {
    throw publicError(400, "Duration must be between 60 and 7200 seconds");
  }
  return Math.round(duration);
}

async function readJsonBody(req) {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 1_000_000) {
      throw publicError(413, "Request body is too large");
    }
  }

  if (!raw) return {};

  try {
    return JSON.parse(raw);
  } catch {
    throw publicError(400, "Request body must be valid JSON");
  }
}

async function serveStatic(req, res, url) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    sendText(res, 405, "Method not allowed");
    return;
  }

  const requestedPath = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
  const safePath = path.normalize(requestedPath).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(publicDir, safePath);
  const relative = path.relative(publicDir, filePath);

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    sendText(res, 403, "Forbidden");
    return;
  }

  try {
    const data = await fs.readFile(filePath);
    const ext = path.extname(filePath);
    res.writeHead(200, {
      "content-type": mimeTypes[ext] || "application/octet-stream",
      "cache-control": ext === ".html" ? "no-store" : "public, max-age=300"
    });
    if (req.method !== "HEAD") {
      res.end(data);
    } else {
      res.end();
    }
  } catch (error) {
    if (error.code === "ENOENT") {
      const index = await fs.readFile(path.join(publicDir, "index.html"));
      res.writeHead(200, { "content-type": mimeTypes[".html"], "cache-control": "no-store" });
      res.end(index);
      return;
    }
    throw error;
  }
}

function sendJson(res, status, payload) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function sendText(res, status, text) {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  res.end(text);
}

function publicError(status, message) {
  const error = new Error(message);
  error.status = status;
  error.publicMessage = message;
  return error;
}

function statusFromError(error) {
  return Number(error.status || error.statusCode || 500);
}
