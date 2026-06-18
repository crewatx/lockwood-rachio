const http = require("node:http");
const { spawn } = require("node:child_process");

const publicPort = Number(process.env.PORT || 8080);
const upstreamPort = Number(process.env.UPSTREAM_PORT || publicPort + 1);
const upstreamHost = "127.0.0.1";

const child = spawn(process.execPath, ["server.js"], {
  env: {
    ...process.env,
    PORT: String(upstreamPort)
  },
  stdio: ["ignore", "inherit", "inherit"]
});

const server = http.createServer((req, res) => {
  const headers = {
    ...req.headers,
    host: `${upstreamHost}:${upstreamPort}`
  };
  delete headers.connection;

  const upstreamReq = http.request(
    {
      hostname: upstreamHost,
      port: upstreamPort,
      path: req.url,
      method: req.method,
      headers
    },
    (upstreamRes) => {
      const contentType = String(upstreamRes.headers["content-type"] || "");
      const shouldScrub =
        req.method === "GET" && req.url?.startsWith("/api/bootstrap") && contentType.includes("application/json");

      if (!shouldScrub) {
        res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
        upstreamRes.pipe(res);
        return;
      }

      const chunks = [];
      upstreamRes.on("data", (chunk) => chunks.push(chunk));
      upstreamRes.on("end", async () => {
        const body = Buffer.concat(chunks).toString("utf8");
        try {
          const payload = await scrubBootstrap(JSON.parse(body));
          const json = JSON.stringify(payload);
          const responseHeaders = { ...upstreamRes.headers, "content-length": Buffer.byteLength(json) };
          delete responseHeaders["transfer-encoding"];
          delete responseHeaders.connection;
          res.writeHead(upstreamRes.statusCode || 200, responseHeaders);
          res.end(json);
        } catch {
          res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
          res.end(body);
        }
      });
    }
  );

  upstreamReq.on("error", () => {
    res.writeHead(502, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "Dashboard service is starting" }));
  });

  req.pipe(upstreamReq);
});

server.listen(publicPort, () => {
  console.log(`Rachio dashboard proxy listening on http://localhost:${publicPort}`);
});

async function scrubBootstrap(payload) {
  if (!payload || payload.demo || !Array.isArray(payload.devices)) {
    return payload;
  }

  payload.devices = payload.devices.map((device) => {
    const currentRun = isCredibleLiveRun(device.currentRun) ? device.currentRun : null;
    const zoneId = currentRun?.zoneId || null;
    const zoneName = normalizeText(currentRun?.zoneName);

    return {
      ...device,
      currentRun,
      zones: (device.zones || []).map((zone) => {
        const running =
          Boolean(currentRun) &&
          ((zoneId && zone.id === zoneId) || (zoneName && normalizeText(zone.name) === zoneName));
        return {
          ...zone,
          running,
          runningStartedAt: running ? currentRun.startedAt || null : null,
          runningUntil: running ? currentRun.endsAt || null : null,
          runningDuration: running ? currentRun.duration || null : null
        };
      })
    };
  });

  const hasRunningZone = payload.devices.some((device) => (device.zones || []).some((zone) => zone.running));
  if (!hasRunningZone && payload.recommendation?.tone === "active") {
    payload.recommendation = {
      tone: "normal",
      title: "Use normal schedule",
      detail: "No active watering run is currently confirmed.",
      bullets: ["Manual controls are available", "Weather is checked from NWS", "Follow local watering rules"]
    };
  }

  await refreshWeatherObservation(payload);
  await refreshDailyForecast(payload);

  return payload;
}

async function refreshWeatherObservation(payload) {
  const weather = payload.weather;
  const station = weather?.station;
  if (!station || weather.source !== "National Weather Service") return;

  try {
    const response = await fetch(
      `https://api.weather.gov/stations/${encodeURIComponent(station)}/observations/latest`,
      {
        headers: {
          Accept: "application/geo+json, application/json",
          "User-Agent":
            process.env.WEATHER_USER_AGENT ||
            "lockwood-rachio-dashboard (https://github.com/crewatx/lockwood-rachio)"
        }
      }
    );
    if (!response.ok) return;

    const observation = await response.json();
    const props = observation.properties || {};
    const windMph = speedToMph(props.windSpeed);
    const gustMph = speedToMph(props.windGust);
    if (windMph !== null) {
      weather.windMph = roundNumber(windMph);
    }
    if (gustMph !== null) {
      weather.gustMph = roundNumber(gustMph);
    }
    weather.updatedAt = props.timestamp || weather.updatedAt;
  } catch {
    repairLegacyWindUnits(weather);
  }
}

function speedToMph(quantity) {
  const value = Number(quantity?.value);
  if (!Number.isFinite(value)) return null;

  const unit = normalizeText(quantity?.unitCode || quantity?.unit || "");
  if (unit.includes("km_h") || unit.includes("km/h")) return value / 1.609344;
  if (unit.includes("m_s") || unit.includes("m/s")) return value * 2.236936;
  if (unit.includes("mi_h") || unit.includes("mph")) return value;
  if (unit.includes("kn")) return value * 1.15078;

  return value / 1.609344;
}

async function refreshDailyForecast(payload) {
  const weather = payload.weather;
  const device = payload.devices?.[0];
  const latitude = Number(device?.latitude);
  const longitude = Number(device?.longitude);
  if (!weather || !Number.isFinite(latitude) || !Number.isFinite(longitude)) return;

  try {
    const point = await weatherFetch(`https://api.weather.gov/points/${latitude.toFixed(4)},${longitude.toFixed(4)}`);
    const forecastUrl = point.properties?.forecast;
    if (!forecastUrl) return;
    const forecast = await weatherFetch(forecastUrl);
    const periods = forecast.properties?.periods || [];
    weather.forecast = periods.slice(0, 14).map((period) => ({
      name: period.name,
      startTime: period.startTime,
      temperature: period.temperature,
      shortForecast: period.shortForecast,
      precipitationChance: period.probabilityOfPrecipitation?.value ?? null
    }));
    weather.dailyForecast = buildDailyForecast(periods);
  } catch {
    weather.dailyForecast = buildDailyForecast(weather.forecast || []);
  }
}

async function weatherFetch(url) {
  const response = await fetch(url, {
    headers: {
      Accept: "application/geo+json, application/json",
      "User-Agent":
        process.env.WEATHER_USER_AGENT || "lockwood-rachio-dashboard (https://github.com/crewatx/lockwood-rachio)"
    }
  });
  if (!response.ok) {
    throw new Error(`Weather.gov returned ${response.status}`);
  }
  return response.json();
}

function buildDailyForecast(periods) {
  const groups = new Map();
  for (const period of periods) {
    const date = period.startTime ? new Date(period.startTime) : null;
    if (!date || Number.isNaN(date.getTime())) continue;
    const key = date.toISOString().slice(0, 10);
    const existing = groups.get(key) || {
      date: key,
      high: null,
      low: null,
      precipitationChance: null,
      shortForecast: ""
    };

    const temp = Number(period.temperature);
    if (Number.isFinite(temp)) {
      existing.high = existing.high === null ? temp : Math.max(existing.high, temp);
      existing.low = existing.low === null ? temp : Math.min(existing.low, temp);
    }

    const rain = Number(period.probabilityOfPrecipitation?.value ?? period.precipitationChance);
    if (Number.isFinite(rain)) {
      existing.precipitationChance =
        existing.precipitationChance === null ? rain : Math.max(existing.precipitationChance, rain);
    }

    if (!existing.shortForecast && period.shortForecast) {
      existing.shortForecast = period.shortForecast;
    }

    groups.set(key, existing);
  }

  return [...groups.values()].slice(0, 7);
}

function repairLegacyWindUnits(weather) {
  if (!weather || weather.source !== "National Weather Service") return;
  if (Number(weather.windMph) >= 30) {
    weather.windMph = roundNumber(Number(weather.windMph) / 3.6);
  }
  if (Number(weather.gustMph) >= 30) {
    weather.gustMph = roundNumber(Number(weather.gustMph) / 3.6);
  }
}

function isCredibleLiveRun(currentRun) {
  if (!currentRun || typeof currentRun !== "object") return false;
  return hasValidDate(currentRun.startedAt) || hasValidDate(currentRun.endsAt);
}

function hasValidDate(value) {
  return Boolean(value && Number.isFinite(new Date(value).getTime()));
}

function normalizeText(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function roundNumber(value, decimals = 0) {
  if (!Number.isFinite(Number(value))) return null;
  const factor = 10 ** decimals;
  return Math.round(Number(value) * factor) / factor;
}

function shutdown() {
  server.close(() => process.exit(0));
  if (!child.killed) {
    child.kill();
  }
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
child.on("exit", (code) => {
  if (code && code !== 0) {
    process.exit(code);
  }
});
