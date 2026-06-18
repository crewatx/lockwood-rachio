const http = require("node:http");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");

const root = __dirname;
const publicDir = path.join(root, "public");
const port = Number(process.env.PORT || 8080);
const rachioBaseUrl = process.env.RACHIO_BASE_URL || "https://api.rach.io/1/public";
const rachioToken = process.env.RACHIO_API_TOKEN || "";
const demoMode = process.env.DEMO_MODE !== "false";
const dashboardPassword = process.env.DASHBOARD_PASSWORD || "";
const sessionSecret = process.env.SESSION_SECRET || dashboardPassword || "dev-session-secret";
const sessionMaxAgeSeconds = Number(process.env.SESSION_MAX_AGE_SECONDS || 60 * 60 * 12);
const sessionCookieName = "rachio_dashboard_session";
const weatherUserAgent =
  process.env.WEATHER_USER_AGENT || "lockwood-rachio-dashboard (https://github.com/crewatx/lockwood-rachio)";
const weatherTimeoutMs = Number(process.env.WEATHER_TIMEOUT_MS || 3500);

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
    const authenticated = isAuthenticated(req);
    sendJson(res, 200, {
      ok: true,
      hasToken: authRequired() ? authenticated && Boolean(rachioToken) : Boolean(rachioToken),
      demoMode: isDemoActive(),
      authRequired: authRequired(),
      authenticated
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/session") {
    sendJson(res, 200, {
      authRequired: authRequired(),
      authenticated: isAuthenticated(req)
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/login") {
    const body = await readJsonBody(req);
    if (!authRequired()) {
      sendJson(res, 200, { ok: true, authRequired: false, authenticated: true });
      return;
    }
    if (!passwordMatches(body.password)) {
      throw publicError(401, "Invalid password");
    }
    setSessionCookie(req, res);
    sendJson(res, 200, { ok: true, authRequired: true, authenticated: true });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/logout") {
    clearSessionCookie(req, res);
    sendJson(res, 200, { ok: true, authRequired: authRequired(), authenticated: false });
    return;
  }

  requireAuth(req);

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
    return hydrateDashboardData(getDemoBootstrap());
  }

  const info = await rachioFetch("/person/info");
  if (!info.id) {
    throw publicError(502, "Rachio did not return an account id");
  }

  const person = await rachioFetch(`/person/${encodeURIComponent(info.id)}`);
  const data = normalizePerson(person, false);
  await hydrateCurrentRuns(data);
  return hydrateDashboardData(data);
}

async function hydrateDashboardData(data) {
  const primaryDevice = data.devices?.[0] || null;
  const weather = await getWeatherForDevice(primaryDevice);
  return {
    ...data,
    weather,
    recommendation: buildRecommendation(data, weather),
    rules: buildWateringRules(primaryDevice, weather)
  };
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

  const normalizedDevice = {
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
    currentRun: null,
    zones,
    scheduleRules,
    raw: {
      serialNumber: device.serialNumber,
      macAddress: device.macAddress,
      currentSchedule: device.currentSchedule || device.current_schedule || null
    }
  };
  return applyCurrentRunToDevice(normalizedDevice, normalizeCurrentRun(device, normalizedDevice));
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

async function hydrateCurrentRuns(data) {
  await Promise.all(
    (data.devices || []).map(async (device) => {
      if (!device.on || device.currentRun) return;
      const currentSchedule = await getCurrentSchedule(device.id);
      if (currentSchedule) {
        applyCurrentRunToDevice(device, normalizeCurrentRun(currentSchedule, device));
      }
    })
  );
}

async function getCurrentSchedule(deviceId) {
  try {
    return await rachioFetch(`/device/${encodeURIComponent(deviceId)}/current_schedule`);
  } catch {
    return null;
  }
}

function applyCurrentRunToDevice(device, currentRun) {
  const matchedZone = matchCurrentRunZone(currentRun, device.zones || []);
  const normalizedRun = currentRun
    ? {
        ...currentRun,
        zoneId: currentRun.zoneId || matchedZone?.id || null,
        zoneName: currentRun.zoneName || matchedZone?.name || "Active watering",
        zoneNumber: currentRun.zoneNumber || matchedZone?.number || null
      }
    : null;

  device.currentRun = normalizedRun;
  device.zones = (device.zones || []).map((zone) => {
    const running =
      Boolean(normalizedRun) &&
      ((normalizedRun.zoneId && zone.id === normalizedRun.zoneId) ||
        normalizeText(zone.name) === normalizeText(normalizedRun.zoneName));
    return {
      ...zone,
      running,
      runningStartedAt: running ? normalizedRun.startedAt : null,
      runningUntil: running ? normalizedRun.endsAt : null,
      runningDuration: running ? normalizedRun.duration : null
    };
  });
  return device;
}

function normalizeCurrentRun(source, device) {
  const sources = collectCurrentRunCandidates(source);
  for (const candidate of sources) {
    const zoneId = firstDefined(
      candidate.zoneId,
      candidate.zone_id,
      candidate.currentZoneId,
      candidate.current_zone_id,
      candidate.activeZoneId,
      candidate.active_zone_id,
      candidate.zone?.id,
      candidate.zone?.zoneId,
      candidate.zone?.zone_id,
      candidate.zones?.[0]?.id,
      candidate.zones?.[0]?.zoneId,
      candidate.zones?.[0]?.zone_id,
      candidate.zoneRun?.zoneId,
      candidate.zoneRun?.zone_id,
      candidate.run?.zoneId,
      candidate.run?.zone_id
    );
    const zoneName = firstDefined(
      candidate.zoneName,
      candidate.zone_name,
      candidate.currentZoneName,
      candidate.current_zone_name,
      candidate.activeZoneName,
      candidate.active_zone_name,
      candidate.name,
      candidate.zone?.name,
      candidate.zones?.[0]?.name,
      candidate.zoneRun?.zoneName,
      candidate.zoneRun?.zone_name,
      candidate.run?.zoneName,
      candidate.run?.zone_name
    );
    const matchedZone = matchCurrentRunZone({ zoneId, zoneName }, device.zones || []);
    const startedAt = parseDateValue(
      firstDefined(
        candidate.startedAt,
        candidate.started_at,
        candidate.startTime,
        candidate.start_time,
        candidate.startDate,
        candidate.start_date,
        candidate.start
      )
    );
    const duration = normalizeRunDuration(
      firstDefined(
        candidate.duration,
        candidate.durationSeconds,
        candidate.duration_seconds,
        candidate.totalDuration,
        candidate.total_duration,
        candidate.runTime,
        candidate.runtime
      )
    );
    const remaining = normalizeRunDuration(
      firstDefined(candidate.remainingDuration, candidate.remaining_duration, candidate.remainingSeconds)
    );
    const endsAt =
      parseDateValue(
        firstDefined(
          candidate.endsAt,
          candidate.ends_at,
          candidate.endTime,
          candidate.end_time,
          candidate.endDate,
          candidate.end_date,
          candidate.expectedEndTime,
          candidate.expected_end_time,
          candidate.end
        )
      ) ||
      (startedAt && duration ? new Date(new Date(startedAt).getTime() + duration * 1000).toISOString() : null) ||
      (remaining ? new Date(Date.now() + remaining * 1000).toISOString() : null);

    if (zoneId || zoneName || matchedZone || endsAt || device.on) {
      return {
        zoneId: zoneId || matchedZone?.id || null,
        zoneName: zoneName || matchedZone?.name || null,
        zoneNumber: matchedZone?.number || null,
        startedAt,
        endsAt,
        duration,
        source: "rachio"
      };
    }
  }
  return null;
}

function collectCurrentRunCandidates(source) {
  if (!source || typeof source !== "object") return [];
  const queue = [
    source.currentSchedule,
    source.current_schedule,
    source.currentRun,
    source.current_run,
    source.current,
    source.watering,
    source.activeZone,
    source.active_zone,
    source.schedule,
    source.run,
    source
  ];
  return queue.filter((item) => item && typeof item === "object");
}

function matchCurrentRunZone(currentRun, zones) {
  if (!currentRun) return null;
  if (currentRun.zoneId) {
    const byId = zones.find((zone) => zone.id === currentRun.zoneId);
    if (byId) return byId;
  }
  if (currentRun.zoneName) {
    const name = normalizeText(currentRun.zoneName);
    return zones.find((zone) => normalizeText(zone.name) === name) || null;
  }
  return null;
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== "");
}

function parseDateValue(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function normalizeRunDuration(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return null;
  return Math.round(number);
}

function normalizeText(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

async function getWeatherForDevice(device) {
  const latitude = Number(device?.latitude);
  const longitude = Number(device?.longitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return fallbackWeather("Controller location unavailable");
  }

  try {
    const point = await weatherFetch(`https://api.weather.gov/points/${latitude.toFixed(4)},${longitude.toFixed(4)}`);
    const properties = point.properties || {};
    const hourly = await weatherFetch(properties.forecastHourly);
    const forecast = await weatherFetch(properties.forecast);
    const stations = await weatherFetch(properties.observationStations);
    const stationFeature = stations.features?.[0] || null;
    const stationUrl = stationFeature?.id || stationFeature?.properties?.["@id"];
    const observation = stationUrl ? await weatherFetch(`${stationUrl}/observations/latest`) : null;
    const history = stationUrl ? await getRainfallHistory(stationUrl) : [];

    return normalizeWeather({
      point: properties,
      hourly,
      forecast,
      station: stationFeature?.properties,
      observation: observation?.properties,
      history
    });
  } catch (error) {
    return fallbackWeather(error.message || "Weather source unavailable");
  }
}

async function getRainfallHistory(stationUrl) {
  const end = new Date();
  const start = new Date(end.getTime() - 7 * 24 * 60 * 60 * 1000);
  try {
    const observations = await weatherFetch(
      `${stationUrl}/observations?start=${start.toISOString()}&end=${end.toISOString()}&limit=500`
    );
    return buildRainfallHistory(observations.features || []);
  } catch {
    return [];
  }
}

async function weatherFetch(url) {
  if (!url) {
    throw new Error("Weather endpoint unavailable");
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), weatherTimeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: "application/geo+json, application/json",
        "User-Agent": weatherUserAgent
      }
    });
    if (!response.ok) {
      throw new Error(`Weather.gov returned ${response.status}`);
    }
    return response.json();
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeWeather({ point, hourly, forecast, station, observation, history }) {
  const currentPeriod = hourly?.properties?.periods?.[0] || {};
  const forecastPeriods = forecast?.properties?.periods || [];
  const hourlyPeriods = hourly?.properties?.periods || [];
  const relativeLocation = point?.relativeLocation?.properties || {};
  const city = relativeLocation.city || point?.cwa || "Local";
  const state = relativeLocation.state || "";
  const observationText = observation?.textDescription || currentPeriod.shortForecast || "Forecast unavailable";

  return {
    source: "National Weather Service",
    status: "ok",
    location: [city, state].filter(Boolean).join(", "),
    station: station?.stationIdentifier || station?.name || "",
    updatedAt: observation?.timestamp || currentPeriod.startTime || new Date().toISOString(),
    temperatureF: roundNumber(cToF(observation?.temperature?.value) ?? currentPeriod.temperature),
    humidity: roundNumber(observation?.relativeHumidity?.value),
    windMph: roundNumber(mpsToMph(observation?.windSpeed?.value) ?? parseWindSpeed(currentPeriod.windSpeed)),
    gustMph: roundNumber(mpsToMph(observation?.windGust?.value)),
    pressureInHg: roundNumber(paToInHg(observation?.barometricPressure?.value), 2),
    condition: observationText,
    icon: currentPeriod.icon || "",
    rainTodayIn: roundNumber(sumTodayRain(history), 2),
    rainLastHourIn: roundNumber(mmToIn(observation?.precipitationLastHour?.value), 2),
    forecast: forecastPeriods.slice(0, 6).map((period) => ({
      name: period.name,
      startTime: period.startTime,
      temperature: period.temperature,
      shortForecast: period.shortForecast,
      precipitationChance: period.probabilityOfPrecipitation?.value ?? null
    })),
    hourly: hourlyPeriods.slice(0, 24).map((period) => ({
      startTime: period.startTime,
      temperature: period.temperature,
      shortForecast: period.shortForecast,
      precipitationChance: period.probabilityOfPrecipitation?.value ?? null,
      windSpeed: period.windSpeed,
      windDirection: period.windDirection
    })),
    rainfallHistory: history.length ? history : buildFallbackRainfallHistory(),
    retrievedAt: new Date().toISOString()
  };
}

function fallbackWeather(reason) {
  return {
    source: "National Weather Service",
    status: "fallback",
    reason,
    location: "Local",
    station: "",
    updatedAt: new Date().toISOString(),
    temperatureF: null,
    humidity: null,
    windMph: null,
    gustMph: null,
    pressureInHg: null,
    condition: "Weather unavailable",
    rainTodayIn: null,
    rainLastHourIn: null,
    forecast: [],
    hourly: [],
    rainfallHistory: buildFallbackRainfallHistory(),
    retrievedAt: new Date().toISOString()
  };
}

function buildRainfallHistory(features) {
  const days = new Map();
  for (let index = 6; index >= 0; index -= 1) {
    const date = new Date(Date.now() - index * 24 * 60 * 60 * 1000);
    const key = date.toISOString().slice(0, 10);
    days.set(key, { date: key, amount: 0 });
  }

  for (const feature of features) {
    const props = feature.properties || {};
    const timestamp = props.timestamp || props.rawMessage;
    const date = timestamp ? new Date(timestamp) : null;
    if (!date || Number.isNaN(date.getTime())) continue;
    const key = date.toISOString().slice(0, 10);
    if (!days.has(key)) continue;
    const precipitation = mmToIn(props.precipitationLastHour?.value);
    if (Number.isFinite(precipitation)) {
      days.get(key).amount += precipitation;
    }
  }

  return [...days.values()].map((day) => ({ ...day, amount: roundNumber(day.amount, 2) }));
}

function buildFallbackRainfallHistory() {
  return Array.from({ length: 7 }, (_, index) => {
    const date = new Date(Date.now() - (6 - index) * 24 * 60 * 60 * 1000);
    return { date: date.toISOString().slice(0, 10), amount: null };
  });
}

function buildRecommendation(data, weather) {
  const nextRain = (weather.hourly || []).find((hour) => Number(hour.precipitationChance) >= 50);
  const rainToday = Number(weather.rainTodayIn || 0);
  const temp = Number(weather.temperatureF);
  const humidity = Number(weather.humidity);
  const wind = Number(weather.windMph);
  const runningZone = data.devices?.flatMap((device) => device.zones || []).find((zone) => zone.running);

  if (runningZone) {
    return {
      tone: "active",
      title: `Watering ${runningZone.name}`,
      detail: "Monitor the active run and stop if rain develops.",
      bullets: ["Manual controls are available", "Weather is checked from NWS", "Follow local watering rules"]
    };
  }

  if (rainToday >= 0.15) {
    return {
      tone: "delay",
      title: "Delay after rain",
      detail: `${rainToday.toFixed(2)} in recorded today.`,
      bullets: ["Recent rain can reduce irrigation need", "Check soil before running zones", "Resume on the next allowed window"]
    };
  }

  if (nextRain) {
    return {
      tone: "delay",
      title: "Rain possible soon",
      detail: `${nextRain.precipitationChance}% chance around ${nextRain.startTime}.`,
      bullets: ["Forecast shows elevated rain chance", "Wait for the next forecast update", "Use manual watering only if needed"]
    };
  }

  if (temp >= 90 && humidity <= 45 && wind <= 18) {
    return {
      tone: "run",
      title: "Water on schedule",
      detail: "Hot, dry conditions support normal watering.",
      bullets: ["No near-term rain signal", "Avoid mid-day watering", "Use the next allowed window"]
    };
  }

  return {
    tone: "normal",
    title: "Use normal schedule",
    detail: "No weather delay is currently recommended.",
    bullets: ["Review zone moisture needs", "Avoid restricted hours", "Recheck weather before manual runs"]
  };
}

function buildWateringRules(device, weather) {
  const now = new Date();
  const nextWindow = new Date(now);
  if (now.getHours() >= 19) {
    nextWindow.setDate(now.getDate() + 1);
    nextWindow.setHours(19, 0, 0, 0);
  } else if (now.getHours() >= 10) {
    nextWindow.setHours(19, 0, 0, 0);
  } else {
    nextWindow.setHours(7, 0, 0, 0);
  }

  return {
    label: weather.location ? `${weather.location} watering guide` : "Watering guide",
    stage: "Configured",
    allowedDays: process.env.WATERING_DAYS || "Mon, Wed, Sat",
    restrictedHours: process.env.RESTRICTED_WATERING_HOURS || "10:00 AM - 7:00 PM",
    nextAllowedWindow: nextWindow.toISOString(),
    note: "Verify current municipal restrictions before changing schedules."
  };
}

function sumTodayRain(history) {
  const today = new Date().toISOString().slice(0, 10);
  return history.find((day) => day.date === today)?.amount ?? null;
}

function parseWindSpeed(value) {
  if (!value) return null;
  const match = String(value).match(/\d+/);
  return match ? Number(match[0]) : null;
}

function cToF(value) {
  if (!Number.isFinite(Number(value))) return null;
  return (Number(value) * 9) / 5 + 32;
}

function mpsToMph(value) {
  if (!Number.isFinite(Number(value))) return null;
  return Number(value) * 2.236936;
}

function paToInHg(value) {
  if (!Number.isFinite(Number(value))) return null;
  return Number(value) * 0.0002953;
}

function mmToIn(value) {
  if (!Number.isFinite(Number(value))) return null;
  return Number(value) / 25.4;
}

function roundNumber(value, decimals = 0) {
  if (!Number.isFinite(Number(value))) return null;
  const factor = 10 ** decimals;
  return Math.round(Number(value) * factor) / factor;
}

function getDemoBootstrap() {
  expireDemoRunIfNeeded();
  const person = normalizePerson(demoState.person, true);
  person.devices = person.devices.map((device) => ({
    ...device,
    zones: device.zones.map((zone) => ({
      ...zone,
      running: demoState.running?.zoneId === zone.id,
      runningStartedAt: demoState.running?.zoneId === zone.id ? demoState.running.startedAt : null,
      runningUntil: demoState.running?.zoneId === zone.id ? demoState.running.endsAt : null,
      runningDuration: demoState.running?.zoneId === zone.id ? demoState.running.duration : null
    }))
  }));
  const runningZone = person.devices.flatMap((device) => device.zones || []).find((zone) => zone.running);
  person.devices = person.devices.map((device) => ({
    ...device,
    currentRun:
      runningZone && runningZone.deviceId === device.id
        ? {
            zoneId: runningZone.id,
            zoneName: runningZone.name,
            zoneNumber: runningZone.number,
            startedAt: runningZone.runningStartedAt,
            endsAt: runningZone.runningUntil,
            duration: runningZone.runningDuration,
            source: "demo"
          }
        : null
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

function authRequired() {
  return Boolean(dashboardPassword);
}

function requireAuth(req) {
  if (authRequired() && !isAuthenticated(req)) {
    throw publicError(401, "Password required");
  }
}

function isAuthenticated(req) {
  if (!authRequired()) return true;
  const cookies = parseCookies(req.headers.cookie || "");
  return verifySessionCookie(cookies[sessionCookieName]);
}

function passwordMatches(value) {
  if (typeof value !== "string" || !dashboardPassword) return false;
  return safeEqual(value, dashboardPassword);
}

function setSessionCookie(req, res) {
  const expiresAt = Date.now() + sessionMaxAgeSeconds * 1000;
  const signature = signSession(expiresAt);
  const secure = isHttpsRequest(req) ? "; Secure" : "";
  res.setHeader(
    "Set-Cookie",
    `${sessionCookieName}=${expiresAt}.${signature}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${sessionMaxAgeSeconds}${secure}`
  );
}

function clearSessionCookie(req, res) {
  const secure = isHttpsRequest(req) ? "; Secure" : "";
  res.setHeader(
    "Set-Cookie",
    `${sessionCookieName}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure}`
  );
}

function verifySessionCookie(value) {
  if (!value || typeof value !== "string") return false;
  const [expiresAt, signature] = value.split(".");
  const expiresAtNumber = Number(expiresAt);
  if (!Number.isFinite(expiresAtNumber) || expiresAtNumber <= Date.now() || !signature) {
    return false;
  }
  return safeEqual(signature, signSession(expiresAt));
}

function signSession(expiresAt) {
  return crypto.createHmac("sha256", sessionSecret).update(String(expiresAt)).digest("base64url");
}

function parseCookies(header) {
  return Object.fromEntries(
    header
      .split(";")
      .map((item) => item.trim())
      .filter(Boolean)
      .map((item) => {
        const index = item.indexOf("=");
        if (index === -1) return [item, ""];
        return [decodeURIComponent(item.slice(0, index)), decodeURIComponent(item.slice(index + 1))];
      })
  );
}

function isHttpsRequest(req) {
  return req.headers["x-forwarded-proto"] === "https" || req.socket.encrypted;
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));
  if (leftBuffer.length !== rightBuffer.length) return false;
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
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
