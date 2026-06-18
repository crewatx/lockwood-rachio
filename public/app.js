const state = {
  data: null,
  selectedDeviceId: null,
  busyZoneId: null,
  session: null
};

const mapLayout = [
  { left: 10, top: 10, width: 18, height: 14 },
  { left: 32, top: 8, width: 20, height: 13 },
  { left: 58, top: 9, width: 18, height: 13 },
  { left: 78, top: 17, width: 14, height: 18 },
  { left: 8, top: 40, width: 14, height: 20 },
  { left: 22, top: 35, width: 14, height: 23 },
  { left: 28, top: 66, width: 32, height: 17 },
  { left: 80, top: 50, width: 12, height: 16 },
  { left: 10, top: 64, width: 15, height: 23 },
  { left: 58, top: 61, width: 12, height: 12 },
  { left: 70, top: 67, width: 12, height: 15 },
  { left: 82, top: 35, width: 11, height: 13 },
  { left: 6, top: 72, width: 16, height: 15 },
  { left: 30, top: 86, width: 28, height: 9 },
  { left: 58, top: 83, width: 22, height: 11 },
  { left: 84, top: 70, width: 10, height: 15 }
];

const elements = {
  authScreen: document.querySelector("#auth-screen"),
  dashboardShell: document.querySelector("#dashboard-shell"),
  loginForm: document.querySelector("#login-form"),
  loginError: document.querySelector("#login-error"),
  passwordInput: document.querySelector("#password-input"),
  logoutButton: document.querySelector("#logout-button"),
  refreshButton: document.querySelector("#refresh-button"),
  stopAllButton: document.querySelector("#stop-all-button"),
  pauseButton: document.querySelector("#pause-button"),
  runFirstZoneButton: document.querySelector("#run-first-zone-button"),
  refreshWeatherButton: document.querySelector("#refresh-weather-button"),
  systemPill: document.querySelector("#system-pill"),
  currentDate: document.querySelector("#current-date"),
  currentTime: document.querySelector("#current-time"),
  dashboardTitle: document.querySelector("#dashboard-title"),
  controllerName: document.querySelector("#controller-name"),
  controllerStatus: document.querySelector("#controller-status"),
  controllerId: document.querySelector("#controller-id"),
  controllerTimezone: document.querySelector("#controller-timezone"),
  activeZoneName: document.querySelector("#active-zone-name"),
  activeZoneTime: document.querySelector("#active-zone-time"),
  activeZoneStart: document.querySelector("#active-zone-start"),
  activeZoneEnd: document.querySelector("#active-zone-end"),
  activeZoneMeter: document.querySelector("#active-zone-meter"),
  weatherTemp: document.querySelector("#weather-temp"),
  weatherCondition: document.querySelector("#weather-condition"),
  weatherLocation: document.querySelector("#weather-location"),
  weatherHumidity: document.querySelector("#weather-humidity"),
  weatherWind: document.querySelector("#weather-wind"),
  weatherGust: document.querySelector("#weather-gust"),
  weatherRain: document.querySelector("#weather-rain"),
  weatherPressure: document.querySelector("#weather-pressure"),
  recommendationTitle: document.querySelector("#recommendation-title"),
  recommendationDetail: document.querySelector("#recommendation-detail"),
  recommendationList: document.querySelector("#recommendation-list"),
  nextWindow: document.querySelector("#next-window"),
  wateringDays: document.querySelector("#watering-days"),
  wateringHours: document.querySelector("#watering-hours"),
  zoneCountTitle: document.querySelector("#zone-count-title"),
  deviceSelect: document.querySelector("#device-select"),
  zoneGrid: document.querySelector("#zone-grid"),
  yardMap: document.querySelector("#yard-map"),
  ruleStage: document.querySelector("#rule-stage"),
  ruleDays: document.querySelector("#rule-days"),
  ruleHours: document.querySelector("#rule-hours"),
  ruleNote: document.querySelector("#rule-note"),
  conditionTable: document.querySelector("#condition-table"),
  decisionList: document.querySelector("#decision-list"),
  scheduleList: document.querySelector("#schedule-list"),
  activityList: document.querySelector("#activity-list"),
  forecastGrid: document.querySelector("#forecast-grid"),
  forecastSummary: document.querySelector("#forecast-summary"),
  forecastUpdated: document.querySelector("#forecast-updated"),
  rainfallChart: document.querySelector("#rainfall-chart"),
  rainTotal: document.querySelector("#rain-total")
};

elements.refreshButton.addEventListener("click", () => loadDashboard());
elements.refreshWeatherButton.addEventListener("click", () => loadDashboard());
elements.loginForm.addEventListener("submit", (event) => {
  event.preventDefault();
  login();
});
elements.logoutButton.addEventListener("click", () => logout());
elements.deviceSelect.addEventListener("change", (event) => {
  state.selectedDeviceId = event.target.value;
  render();
});
elements.stopAllButton.addEventListener("click", () => stopAllWatering());
elements.runFirstZoneButton.addEventListener("click", () => runFirstEnabledZone());

init();
updateClock();
window.setInterval(updateClock, 30_000);
window.setInterval(updateActiveWateringPanel, 1000);
window.setInterval(() => {
  if (state.session?.authenticated) {
    loadDashboard({ quiet: true });
  }
}, 60_000);

async function init() {
  try {
    state.session = await api("/api/session", { skipAuthRedirect: true });
    if (state.session.authenticated) {
      showDashboard();
      await loadDashboard();
    } else {
      showLogin();
    }
  } catch (error) {
    elements.loginError.textContent = error.message;
    showLogin();
  }
}

async function login() {
  elements.loginError.textContent = "";
  const password = elements.passwordInput.value;
  elements.loginForm.classList.add("is-loading");
  try {
    state.session = await api("/api/login", {
      method: "POST",
      body: { password },
      skipAuthRedirect: true
    });
    elements.passwordInput.value = "";
    showDashboard();
    await loadDashboard();
  } catch (error) {
    elements.loginError.textContent = error.message;
    elements.passwordInput.select();
  } finally {
    elements.loginForm.classList.remove("is-loading");
  }
}

async function logout() {
  await api("/api/logout", { method: "POST", skipAuthRedirect: true }).catch(() => null);
  state.data = null;
  state.session = { authRequired: true, authenticated: false };
  showLogin();
}

async function loadDashboard(options = {}) {
  setLoading(true, options.quiet);
  try {
    state.data = await api("/api/bootstrap");
    if (!state.selectedDeviceId || !getSelectedDevice()) {
      state.selectedDeviceId = state.data.devices?.[0]?.id || null;
    }
    render();
  } catch (error) {
    renderError(error);
  } finally {
    setLoading(false, options.quiet);
  }
}

async function startZone(zoneId, duration) {
  state.busyZoneId = zoneId;
  renderZones();
  try {
    await api(`/api/zones/${encodeURIComponent(zoneId)}/start`, {
      method: "POST",
      body: { duration }
    });
    markZoneRunning(zoneId, duration);
    window.setTimeout(() => loadDashboard({ quiet: true }), 2500);
  } catch (error) {
    showActionError(error);
  } finally {
    state.busyZoneId = null;
    render();
  }
}

async function stopZone(zoneId) {
  state.busyZoneId = zoneId;
  renderZones();
  try {
    await api(`/api/zones/${encodeURIComponent(zoneId)}/stop`, { method: "POST" });
    markZoneStopped(zoneId);
    window.setTimeout(() => loadDashboard({ quiet: true }), 2500);
  } catch (error) {
    showActionError(error);
  } finally {
    state.busyZoneId = null;
    render();
  }
}

async function stopAllWatering() {
  const device = getSelectedDevice();
  if (!device) return;
  elements.stopAllButton.disabled = true;
  try {
    await api(`/api/devices/${encodeURIComponent(device.id)}/stop`, { method: "POST" });
    markAllZonesStopped(device.id);
    render();
    window.setTimeout(() => loadDashboard({ quiet: true }), 2500);
  } catch (error) {
    showActionError(error);
  } finally {
    elements.stopAllButton.disabled = false;
  }
}

function runFirstEnabledZone() {
  const zone = getSelectedDevice()?.zones?.find((item) => item.enabled);
  if (zone) {
    startZone(zone.id, 300);
  }
}

function render() {
  const device = getSelectedDevice();
  const zones = device?.zones || [];
  renderSystem(device, zones);
  renderDeviceSelect();
  renderWateringNow(device, zones);
  renderWeather();
  renderRecommendation();
  renderRules();
  renderZones();
  renderYardMap();
  renderConditionTable();
  renderSchedules(device);
  renderActivity();
  renderForecast();
  renderRainfall();
}

function renderSystem(device, zones) {
  const activeRun = getActiveWatering(device, zones);
  const online = device?.status !== "offline";
  elements.dashboardTitle.textContent = `${zones.length || "--"} Zone System`;
  elements.controllerName.textContent = device?.name || "No controller";
  elements.controllerStatus.textContent = online ? "Online" : "Offline";
  elements.controllerStatus.className = `inline-status ${online ? "online" : "offline"}`;
  elements.controllerId.textContent = device?.id ? shortId(device.id) : "--";
  elements.controllerTimezone.textContent = device?.timeZone || "--";
  elements.zoneCountTitle.textContent = `${zones.length || 0} zones`;
  elements.systemPill.textContent = activeRun ? "Watering Active" : online ? "System Healthy" : "System Offline";
  elements.systemPill.className = `status-pill ${activeRun ? "active" : online ? "healthy" : "error"}`;
}

function renderDeviceSelect() {
  const devices = state.data?.devices || [];
  elements.deviceSelect.replaceChildren(
    ...devices.map((device) => {
      const option = document.createElement("option");
      option.value = device.id;
      option.textContent = device.name;
      option.selected = device.id === state.selectedDeviceId;
      return option;
    })
  );
  elements.deviceSelect.disabled = devices.length <= 1;
}

function renderWateringNow(device, zones) {
  const activeRun = getActiveWatering(device, zones);
  if (!activeRun) {
    elements.activeZoneName.textContent = "No active zone";
    elements.activeZoneTime.textContent = "--";
    elements.activeZoneStart.textContent = "--";
    elements.activeZoneEnd.textContent = "--";
    elements.activeZoneMeter.style.width = "0%";
    elements.pauseButton.disabled = true;
    return;
  }

  elements.activeZoneName.textContent = activeRun.number
    ? `Zone ${activeRun.number} - ${activeRun.name}`
    : activeRun.name || "Active watering";
  const startsAt = activeRun.startedAt ? new Date(activeRun.startedAt) : null;
  const endsAt = activeRun.endsAt ? new Date(activeRun.endsAt) : null;
  const remainingMs = endsAt ? Math.max(0, endsAt.getTime() - Date.now()) : null;
  elements.activeZoneTime.textContent = remainingMs === null ? "Running" : formatClockDuration(remainingMs);
  elements.activeZoneStart.textContent = startsAt ? formatTime(startsAt) : "--";
  elements.activeZoneEnd.textContent = endsAt ? formatTime(endsAt) : "--";
  elements.activeZoneMeter.style.width = `${activeRunProgress(activeRun)}%`;
  elements.pauseButton.disabled = true;
}

function updateActiveWateringPanel() {
  if (!state.session?.authenticated || !state.data) return;
  const device = getSelectedDevice();
  renderWateringNow(device, device?.zones || []);
}

function renderWeather() {
  const weather = state.data?.weather || {};
  elements.weatherTemp.textContent = weather.temperatureF === null || weather.temperatureF === undefined ? "--" : `${weather.temperatureF}\u00b0F`;
  elements.weatherCondition.textContent = weather.condition || "Weather unavailable";
  elements.weatherLocation.textContent = `${weather.source || "Weather"}${weather.location ? ` - ${weather.location}` : ""}`;
  elements.weatherHumidity.textContent = weather.humidity === null || weather.humidity === undefined ? "--" : `${weather.humidity}%`;
  elements.weatherWind.textContent = weather.windMph === null || weather.windMph === undefined ? "--" : `${weather.windMph} mph`;
  elements.weatherGust.textContent = weather.gustMph === null || weather.gustMph === undefined ? "--" : `${weather.gustMph} mph`;
  elements.weatherRain.textContent = weather.rainTodayIn === null || weather.rainTodayIn === undefined ? "--" : `${weather.rainTodayIn.toFixed(2)} in`;
  elements.weatherPressure.textContent = weather.pressureInHg === null || weather.pressureInHg === undefined ? "--" : `${weather.pressureInHg.toFixed(2)} inHg`;
}

function renderRecommendation() {
  const recommendation = state.data?.recommendation || {};
  elements.recommendationTitle.textContent = recommendation.title || "Weather check unavailable";
  elements.recommendationDetail.textContent = recommendation.detail || "No recommendation loaded.";
  elements.recommendationTitle.dataset.tone = recommendation.tone || "normal";
  renderList(elements.recommendationList, recommendation.bullets || []);
}

function renderRules() {
  const rules = state.data?.rules || {};
  elements.nextWindow.textContent = rules.nextAllowedWindow ? formatWindow(rules.nextAllowedWindow) : "--";
  elements.wateringDays.textContent = `Allowed watering days: ${rules.allowedDays || "--"}`;
  elements.wateringHours.textContent = `No outdoor watering: ${rules.restrictedHours || "--"}`;
  elements.ruleStage.textContent = rules.stage || "--";
  elements.ruleDays.textContent = rules.allowedDays || "--";
  elements.ruleHours.textContent = rules.restrictedHours || "--";
  elements.ruleNote.textContent = rules.note || "Verify current local rules.";
}

function renderZones() {
  const device = getSelectedDevice();
  const zones = device?.zones || [];
  if (!zones.length) {
    elements.zoneGrid.replaceChildren(emptyBlock("No zones found for this controller."));
    return;
  }

  elements.zoneGrid.replaceChildren(
    ...zones.map((zone) => {
      const card = document.createElement("article");
      const status = zone.running ? "running" : zone.enabled ? "scheduled" : "off";
      card.className = `zone-tile ${status}`;
      card.innerHTML = `
        <strong></strong>
        <div class="zone-copy">
          <span class="zone-name"></span>
          <small></small>
        </div>
        <div class="zone-tile-actions"></div>
      `;
      card.querySelector("strong").textContent = zone.number || "--";
      card.querySelector(".zone-name").textContent = zone.name;
      card.querySelector("small").textContent = zone.running ? "Running" : zone.enabled ? "Ready" : "Off";

      const actions = card.querySelector(".zone-tile-actions");
      const actionButton = document.createElement("button");
      actionButton.type = "button";
      actionButton.textContent = zone.running ? "Stop" : "Run";
      actionButton.title = zone.running ? `Stop ${zone.name}` : `Run ${zone.name} for 5 minutes`;
      actionButton.disabled = (!zone.running && !zone.enabled) || state.busyZoneId === zone.id;
      actionButton.addEventListener("click", () => (zone.running ? stopZone(zone.id) : startZone(zone.id, 300)));
      actions.replaceChildren(actionButton);
      return card;
    })
  );
}

function renderYardMap() {
  const zones = getSelectedDevice()?.zones || [];
  const house = document.createElement("div");
  house.className = "map-house";
  const driveway = document.createElement("div");
  driveway.className = "map-driveway";
  const beds = document.createElement("div");
  beds.className = "map-beds";

  const zoneEls = zones.map((zone, index) => {
    const layout = mapLayout[index % mapLayout.length];
    const button = document.createElement("button");
    button.type = "button";
    button.className = `map-zone ${zone.running ? "running" : zone.enabled ? "scheduled" : "off"}`;
    button.style.left = `${layout.left}%`;
    button.style.top = `${layout.top}%`;
    button.style.width = `${layout.width}%`;
    button.style.height = `${layout.height}%`;
    button.title = zone.name;
    button.textContent = zone.number || index + 1;
    button.addEventListener("click", () => {
      if (zone.enabled) startZone(zone.id, 300);
    });
    return button;
  });

  elements.yardMap.replaceChildren(house, driveway, beds, ...zoneEls);
}

function renderConditionTable() {
  const weather = state.data?.weather || {};
  const rainSoon = (weather.hourly || []).some((hour) => Number(hour.precipitationChance) >= 50);
  const rows = [
    ["Rain Skip", "On", rainSoon || Number(weather.rainTodayIn || 0) > 0.15 ? "Yes" : "No", rainSoon ? "Note" : "Agree"],
    ["Wind Skip", "On", Number(weather.windMph || 0) >= 20 ? "Yes" : "No", Number(weather.windMph || 0) >= 20 ? "Note" : "Agree"],
    ["Forecast Shower", "Auto", rainSoon ? "Yes" : "No", rainSoon ? "Watch" : "Agree"],
    ["Seasonal Adjust", "100%", "NWS", weather.status === "ok" ? "Agree" : "Fallback"]
  ];
  elements.conditionTable.replaceChildren(
    ...rows.map(([condition, rachio, source, status]) => {
      const row = document.createElement("tr");
      row.innerHTML = "<td></td><td></td><td></td><td></td>";
      row.children[0].textContent = condition;
      row.children[1].textContent = rachio;
      row.children[2].textContent = source;
      row.children[3].textContent = status;
      row.children[3].className = status === "Agree" ? "agree" : "note";
      return row;
    })
  );
  renderList(elements.decisionList, [
    state.data?.recommendation?.detail || "No weather decision loaded.",
    `Weather source: ${weather.source || "NWS"}`,
    `Restricted hours: ${state.data?.rules?.restrictedHours || "--"}`,
    "Manual runs remain available after login"
  ]);
}

function renderSchedules(device) {
  const schedules = device?.scheduleRules || [];
  if (!schedules.length) {
    elements.scheduleList.replaceChildren(emptyBlock("No schedules loaded."));
    return;
  }
  elements.scheduleList.replaceChildren(
    ...schedules.slice(0, 5).map((schedule) =>
      dataRow(schedule.name, `${formatDateTime(schedule.startDate, schedule.startTime)} - ${formatDuration(schedule.totalDuration)}`, schedule.enabled ? "On" : "Paused")
    )
  );
}

function renderActivity() {
  const activity = state.data?.activity || [];
  if (!activity.length) {
    elements.activityList.replaceChildren(emptyBlock("No recent activity."));
    return;
  }
  elements.activityList.replaceChildren(
    ...activity.slice(0, 5).map((item) => dataRow(item.label || "Rachio event", relativeTime(item.when), item.tone || "Event"))
  );
}

function renderForecast() {
  const weather = state.data?.weather || {};
  const days = getForecastDays(weather);
  if (!days.length) {
    elements.forecastSummary.textContent = "Forecast unavailable";
    elements.forecastUpdated.textContent = "--";
    elements.forecastGrid.replaceChildren(emptyBlock("No forecast loaded."));
    return;
  }

  const rainChances = days.map((day) => Number(day.precipitationChance)).filter(Number.isFinite);
  const highestRain = rainChances.length ? Math.max(...rainChances) : null;
  elements.forecastSummary.textContent =
    highestRain === null ? "Rain outlook unavailable" : highestRain >= 50 ? `${highestRain}% rain chance ahead` : `${highestRain}% max rain chance`;
  elements.forecastUpdated.textContent = weather.updatedAt ? `Updated ${formatTime(weather.updatedAt)}` : "NWS";
  elements.forecastGrid.replaceChildren(
    ...days.map((day) => {
      const card = document.createElement("article");
      const rainChance = Number(day.precipitationChance);
      card.className = `forecast-day ${Number.isFinite(rainChance) && rainChance >= 50 ? "wet" : ""}`;
      card.innerHTML = "<strong></strong><span></span><small></small><em></em>";
      card.querySelector("strong").textContent = formatForecastDay(day.date || day.startTime || day.label);
      card.querySelector("span").textContent = formatTempRange(day);
      card.querySelector("small").textContent = day.shortForecast || day.condition || "Forecast pending";
      card.querySelector("em").textContent = Number.isFinite(rainChance) ? `${rainChance}% rain` : "-- rain";
      return card;
    })
  );
}

function renderRainfall() {
  const history = state.data?.weather?.rainfallHistory || [];
  const knownAmounts = history.map((item) => item.amount).filter((value) => Number.isFinite(Number(value)));
  const max = Math.max(0.1, ...knownAmounts);
  const total = knownAmounts.reduce((sum, value) => sum + Number(value), 0);
  elements.rainTotal.textContent = knownAmounts.length ? `${total.toFixed(2)} in total` : "Unavailable";
  elements.rainfallChart.replaceChildren(
    ...history.map((item) => {
      const bar = document.createElement("div");
      const amount = Number(item.amount);
      bar.className = "rain-bar";
      bar.innerHTML = "<span></span><strong></strong><small></small>";
      bar.querySelector("span").style.height = Number.isFinite(amount) ? `${Math.max(4, (amount / max) * 100)}%` : "4%";
      bar.querySelector("strong").textContent = Number.isFinite(amount) ? amount.toFixed(2) : "--";
      bar.querySelector("small").textContent = formatShortDay(item.date);
      return bar;
    })
  );
}

function getForecastDays(weather) {
  if (Array.isArray(weather.dailyForecast) && weather.dailyForecast.length) {
    return weather.dailyForecast.slice(0, 7);
  }
  return buildForecastDays(weather.forecast || []).slice(0, 7);
}

function buildForecastDays(periods) {
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
    const rain = Number(period.precipitationChance);
    if (Number.isFinite(rain)) {
      existing.precipitationChance =
        existing.precipitationChance === null ? rain : Math.max(existing.precipitationChance, rain);
    }
    if (!existing.shortForecast && period.shortForecast) {
      existing.shortForecast = period.shortForecast;
    }
    groups.set(key, existing);
  }
  return [...groups.values()];
}

function renderError(error) {
  elements.systemPill.className = "status-pill error";
  elements.systemPill.textContent = "Error";
  elements.controllerName.textContent = "Unable to load";
  elements.controllerStatus.textContent = error.message;
  elements.zoneGrid.replaceChildren(emptyBlock(error.message));
}

function showActionError(error) {
  elements.systemPill.className = "status-pill error";
  elements.systemPill.textContent = error.message.slice(0, 30);
  window.setTimeout(() => renderSystem(getSelectedDevice(), getSelectedDevice()?.zones || []), 3000);
}

function getActiveWatering(device, zones) {
  const runningZone = zones.find((zone) => zone.running);
  if (runningZone) {
    return {
      zoneId: runningZone.id,
      name: runningZone.name,
      number: runningZone.number,
      startedAt: runningZone.runningStartedAt || device?.currentRun?.startedAt || null,
      endsAt: runningZone.runningUntil || device?.currentRun?.endsAt || null,
      duration: runningZone.runningDuration || device?.currentRun?.duration || null
    };
  }

  if (device?.currentRun) {
    return {
      zoneId: device.currentRun.zoneId || null,
      name: device.currentRun.zoneName || "Active watering",
      number: device.currentRun.zoneNumber || null,
      startedAt: device.currentRun.startedAt || null,
      endsAt: device.currentRun.endsAt || null,
      duration: device.currentRun.duration || null
    };
  }

  return null;
}

function activeRunProgress(activeRun) {
  const endsAt = activeRun.endsAt ? new Date(activeRun.endsAt).getTime() : null;
  const startsAt = activeRun.startedAt ? new Date(activeRun.startedAt).getTime() : null;
  if (!Number.isFinite(endsAt) || !Number.isFinite(startsAt) || endsAt <= startsAt) {
    return activeRun.endsAt ? 100 : 65;
  }
  const elapsed = Date.now() - startsAt;
  const total = endsAt - startsAt;
  return Math.max(6, Math.min(100, (elapsed / total) * 100));
}

function markZoneRunning(zoneId, duration) {
  const device = getSelectedDevice();
  const zone = device?.zones?.find((item) => item.id === zoneId);
  if (!device || !zone) return;
  const startedAt = new Date();
  const endsAt = new Date(startedAt.getTime() + duration * 1000);
  device.currentRun = {
    zoneId,
    zoneName: zone.name,
    zoneNumber: zone.number,
    startedAt: startedAt.toISOString(),
    endsAt: endsAt.toISOString(),
    duration,
    source: "optimistic"
  };
  device.zones = device.zones.map((item) => ({
    ...item,
    running: item.id === zoneId,
    runningStartedAt: item.id === zoneId ? device.currentRun.startedAt : null,
    runningUntil: item.id === zoneId ? device.currentRun.endsAt : null,
    runningDuration: item.id === zoneId ? duration : null
  }));
}

function markZoneStopped(zoneId) {
  const device = getSelectedDevice();
  if (!device) return;
  device.currentRun = device.currentRun?.zoneId === zoneId ? null : device.currentRun;
  device.zones = device.zones.map((zone) => ({
    ...zone,
    running: zone.id === zoneId ? false : zone.running,
    runningStartedAt: zone.id === zoneId ? null : zone.runningStartedAt,
    runningUntil: zone.id === zoneId ? null : zone.runningUntil,
    runningDuration: zone.id === zoneId ? null : zone.runningDuration
  }));
}

function markAllZonesStopped(deviceId) {
  const device = state.data?.devices?.find((item) => item.id === deviceId);
  if (!device) return;
  device.currentRun = null;
  device.zones = device.zones.map((zone) => ({
    ...zone,
    running: false,
    runningStartedAt: null,
    runningUntil: null,
    runningDuration: null
  }));
}

function setLoading(loading, quiet) {
  elements.refreshButton.disabled = loading;
  if (loading && !quiet) {
    elements.systemPill.className = "status-pill loading";
    elements.systemPill.textContent = "Loading";
  }
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    method: options.method || "GET",
    headers: options.body ? { "content-type": "application/json" } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401 && !options.skipAuthRedirect) {
      state.session = { authRequired: true, authenticated: false };
      showLogin();
    }
    throw new Error(payload.error || `Request failed with ${response.status}`);
  }
  return payload;
}

function showLogin() {
  elements.authScreen.classList.remove("hidden");
  elements.dashboardShell.classList.add("hidden");
  window.setTimeout(() => elements.passwordInput.focus(), 0);
}

function showDashboard() {
  elements.authScreen.classList.add("hidden");
  elements.dashboardShell.classList.remove("hidden");
  elements.logoutButton.classList.toggle("hidden", !state.session?.authRequired);
}

function getSelectedDevice() {
  return state.data?.devices?.find((device) => device.id === state.selectedDeviceId) || state.data?.devices?.[0] || null;
}

function renderList(container, items) {
  container.replaceChildren(
    ...items.map((item) => {
      const li = document.createElement("li");
      li.textContent = item;
      return li;
    })
  );
}

function dataRow(title, detail, meta) {
  const row = document.createElement("div");
  row.className = "data-row";
  row.innerHTML = "<strong></strong><span></span><em></em>";
  row.querySelector("strong").textContent = title;
  row.querySelector("span").textContent = detail;
  row.querySelector("em").textContent = meta;
  return row;
}

function emptyBlock(message) {
  const block = document.createElement("div");
  block.className = "empty-state";
  block.textContent = message;
  return block;
}

function updateClock() {
  const now = new Date();
  elements.currentDate.textContent = new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric"
  }).format(now);
  elements.currentTime.textContent = new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short"
  }).format(now);
}

function shortId(value) {
  return String(value).slice(0, 8).toUpperCase();
}

function formatWindow(date) {
  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit"
  }).format(new Date(date));
}

function formatDateTime(date, time) {
  if (!date && !time) return "--";
  const value = date ? new Date(date) : new Date();
  if (time) {
    const [hours, minutes] = time.split(":").map(Number);
    if (Number.isFinite(hours)) value.setHours(hours);
    if (Number.isFinite(minutes)) value.setMinutes(minutes);
  }
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(value);
}

function formatTime(date) {
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit"
  }).format(new Date(date));
}

function formatClockDuration(milliseconds) {
  const totalSeconds = Math.ceil(milliseconds / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function formatDuration(seconds) {
  const total = Number(seconds || 0);
  if (!total) return "0m";
  const minutes = Math.round(total / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours}h ${rest}m` : `${hours}h`;
}

function formatShortDay(date) {
  return new Intl.DateTimeFormat(undefined, { weekday: "short", month: "numeric", day: "numeric" }).format(new Date(date));
}

function formatForecastDay(value) {
  const date = new Date(value);
  if (!Number.isNaN(date.getTime())) {
    return new Intl.DateTimeFormat(undefined, { weekday: "short" }).format(date);
  }
  return String(value || "--").replace(/\s.*$/, "");
}

function formatTempRange(day) {
  const high = Number(day.high ?? day.temperatureHigh ?? day.temperature);
  const low = Number(day.low ?? day.temperatureLow);
  if (Number.isFinite(high) && Number.isFinite(low) && high !== low) {
    return `${Math.round(high)} / ${Math.round(low)}\u00b0`;
  }
  if (Number.isFinite(high)) {
    return `${Math.round(high)}\u00b0`;
  }
  return "--";
}

function relativeTime(date) {
  const value = new Date(date).getTime();
  if (!Number.isFinite(value)) return "Recently";
  const seconds = Math.round((value - Date.now()) / 1000);
  const abs = Math.abs(seconds);
  const units = [
    ["day", 86400],
    ["hour", 3600],
    ["minute", 60]
  ];
  for (const [unit, size] of units) {
    if (abs >= size) {
      return new Intl.RelativeTimeFormat(undefined, { numeric: "auto" }).format(Math.round(seconds / size), unit);
    }
  }
  return "Just now";
}
