const state = {
  data: null,
  selectedDeviceId: null,
  busyZoneId: null
};

const elements = {
  connectionPill: document.querySelector("#connection-pill"),
  refreshButton: document.querySelector("#refresh-button"),
  setupBanner: document.querySelector("#setup-banner"),
  controllerName: document.querySelector("#controller-name"),
  controllerDetail: document.querySelector("#controller-detail"),
  activeZone: document.querySelector("#active-zone"),
  activeZoneDetail: document.querySelector("#active-zone-detail"),
  nextRun: document.querySelector("#next-run"),
  nextRunDetail: document.querySelector("#next-run-detail"),
  zoneCount: document.querySelector("#zone-count"),
  zoneCountDetail: document.querySelector("#zone-count-detail"),
  deviceSelect: document.querySelector("#device-select"),
  zonesGrid: document.querySelector("#zones-grid"),
  scheduleList: document.querySelector("#schedule-list"),
  activityList: document.querySelector("#activity-list"),
  zoneTemplate: document.querySelector("#zone-card-template")
};

elements.refreshButton.addEventListener("click", () => loadDashboard());
elements.deviceSelect.addEventListener("change", (event) => {
  state.selectedDeviceId = event.target.value;
  render();
});

loadDashboard();
window.setInterval(() => loadDashboard({ quiet: true }), 60_000);

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
    await loadDashboard({ quiet: true });
  } catch (error) {
    showActionError(error);
  } finally {
    state.busyZoneId = null;
    renderZones();
  }
}

async function stopZone(zoneId) {
  state.busyZoneId = zoneId;
  renderZones();
  try {
    await api(`/api/zones/${encodeURIComponent(zoneId)}/stop`, { method: "POST" });
    await loadDashboard({ quiet: true });
  } catch (error) {
    showActionError(error);
  } finally {
    state.busyZoneId = null;
    renderZones();
  }
}

function render() {
  const selectedDevice = getSelectedDevice();
  renderConnection();
  renderDeviceSelect();
  renderOverview(selectedDevice);
  renderZones();
  renderSchedules(selectedDevice);
  renderActivity();
}

function renderConnection() {
  const { connectionPill, setupBanner } = elements;
  if (!state.data) return;

  connectionPill.className = `pill ${state.data.demo ? "demo" : "live"}`;
  connectionPill.textContent = state.data.demo ? "Demo" : "Live";
  setupBanner.classList.toggle("hidden", !state.data.demo);
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

function renderOverview(device) {
  const zones = device?.zones || [];
  const enabledZones = zones.filter((zone) => zone.enabled);
  const runningZone = zones.find((zone) => zone.running);
  const nextSchedule = getNextSchedule(device);

  elements.controllerName.textContent = device?.name || "No controller";
  elements.controllerDetail.textContent = device
    ? `${titleCase(device.status)} - ${device.timeZone || "Timezone unavailable"}`
    : "Connect a Rachio account";

  elements.activeZone.textContent = runningZone?.name || "None";
  elements.activeZoneDetail.textContent = runningZone?.runningUntil
    ? `Ends ${formatTime(runningZone.runningUntil)}`
    : "System idle";

  elements.nextRun.textContent = nextSchedule ? formatDateTime(nextSchedule.startDate, nextSchedule.startTime) : "--";
  elements.nextRunDetail.textContent = nextSchedule
    ? `${nextSchedule.name} - ${formatDuration(nextSchedule.totalDuration)}`
    : "No enabled schedule";

  elements.zoneCount.textContent = enabledZones.length.toString();
  elements.zoneCountDetail.textContent = `${zones.length} total`;
}

function renderZones() {
  const device = getSelectedDevice();
  const zones = device?.zones || [];

  if (!zones.length) {
    elements.zonesGrid.innerHTML = `<div class="empty-state">No zones found for this controller.</div>`;
    return;
  }

  const cards = zones.map((zone) => {
    const fragment = elements.zoneTemplate.content.cloneNode(true);
    const card = fragment.querySelector(".zone-card");
    const stateLabel = fragment.querySelector(".zone-state");
    const meter = fragment.querySelector(".zone-meter span");

    card.dataset.zoneId = zone.id;
    card.classList.toggle("disabled", !zone.enabled);
    fragment.querySelector(".zone-number").textContent = zone.number ? `Zone ${zone.number}` : "Zone";
    fragment.querySelector("h3").textContent = zone.name;

    stateLabel.textContent = zone.running ? "Running" : zone.enabled ? "Ready" : "Paused";
    stateLabel.classList.toggle("running", Boolean(zone.running));
    stateLabel.classList.toggle("paused", !zone.enabled);

    fragment.querySelector(".zone-type").textContent = zone.type || "Mixed";
    fragment.querySelector(".zone-soil").textContent = zone.soilType || "Unknown";
    fragment.querySelector(".zone-efficiency").textContent = formatPercent(zone.efficiency);
    meter.style.width = `${meterWidth(zone)}%`;

    const buttons = fragment.querySelectorAll("button");
    buttons.forEach((button) => {
      const isStop = button.hasAttribute("data-stop");
      button.disabled = state.busyZoneId === zone.id || (!zone.enabled && !isStop) || (isStop && !zone.running);
      if (isStop) {
        button.addEventListener("click", () => stopZone(zone.id));
      } else {
        button.addEventListener("click", () => startZone(zone.id, Number(button.dataset.duration)));
      }
    });

    return fragment;
  });

  elements.zonesGrid.replaceChildren(...cards);
}

function renderSchedules(device) {
  const schedules = device?.scheduleRules || [];
  if (!schedules.length) {
    elements.scheduleList.innerHTML = `<div class="empty-state">No schedules loaded.</div>`;
    return;
  }

  elements.scheduleList.replaceChildren(
    ...schedules.map((schedule) => {
      const card = document.createElement("article");
      card.className = "schedule-card";
      const statusClass = schedule.enabled ? "live" : "paused";
      card.innerHTML = `
        <header>
          <h3></h3>
          <span class="schedule-status ${statusClass}"></span>
        </header>
        <p></p>
      `;
      card.querySelector("h3").textContent = schedule.name;
      card.querySelector(".schedule-status").textContent = schedule.enabled ? "On" : "Paused";
      card.querySelector("p").textContent = `${formatDateTime(schedule.startDate, schedule.startTime)} - ${formatDuration(schedule.totalDuration)} - ${schedule.zones.length} zones`;
      return card;
    })
  );
}

function renderActivity() {
  const activity = state.data?.activity || [];
  if (!activity.length) {
    elements.activityList.innerHTML = `<li class="empty-state">No activity yet.</li>`;
    return;
  }

  elements.activityList.replaceChildren(
    ...activity.map((item) => {
      const row = document.createElement("li");
      row.innerHTML = `
        <span class="activity-dot ${item.tone || ""}" aria-hidden="true"></span>
        <div>
          <p class="activity-title"></p>
          <div class="activity-time"></div>
        </div>
      `;
      row.querySelector(".activity-title").textContent = item.label || "Rachio event";
      row.querySelector(".activity-time").textContent = relativeTime(item.when);
      return row;
    })
  );
}

function renderError(error) {
  elements.connectionPill.className = "pill error";
  elements.connectionPill.textContent = "Error";
  elements.controllerName.textContent = "Unable to load";
  elements.controllerDetail.textContent = error.message;
  elements.activeZone.textContent = "--";
  elements.activeZoneDetail.textContent = "Check server settings";
  elements.nextRun.textContent = "--";
  elements.nextRunDetail.textContent = "Unavailable";
  elements.zoneCount.textContent = "--";
  elements.zoneCountDetail.textContent = "Unavailable";
  elements.zonesGrid.innerHTML = `<div class="empty-state">${escapeHtml(error.message)}</div>`;
  elements.scheduleList.innerHTML = `<div class="empty-state">Schedules unavailable.</div>`;
  elements.activityList.innerHTML = `<li class="empty-state">Activity unavailable.</li>`;
}

function showActionError(error) {
  elements.connectionPill.className = "pill error";
  elements.connectionPill.textContent = error.message.slice(0, 28);
  window.setTimeout(renderConnection, 3000);
}

function setLoading(loading, quiet) {
  elements.refreshButton.disabled = loading;
  if (loading && !quiet) {
    elements.connectionPill.className = "pill neutral";
    elements.connectionPill.textContent = "Loading";
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
    throw new Error(payload.error || `Request failed with ${response.status}`);
  }
  return payload;
}

function getSelectedDevice() {
  return state.data?.devices?.find((device) => device.id === state.selectedDeviceId) || state.data?.devices?.[0] || null;
}

function getNextSchedule(device) {
  return (device?.scheduleRules || [])
    .filter((schedule) => schedule.enabled)
    .sort((a, b) => scheduleTime(a) - scheduleTime(b))[0];
}

function scheduleTime(schedule) {
  if (!schedule?.startDate) return Number.MAX_SAFE_INTEGER;
  const date = new Date(schedule.startDate);
  if (schedule.startTime) {
    const [hours, minutes] = schedule.startTime.split(":").map(Number);
    if (Number.isFinite(hours)) date.setHours(hours);
    if (Number.isFinite(minutes)) date.setMinutes(minutes);
  }
  return date.getTime();
}

function meterWidth(zone) {
  if (Number.isFinite(Number(zone.saturatedDepthOfWater))) {
    return clamp(Number(zone.saturatedDepthOfWater) * 100, 18, 100);
  }
  if (Number.isFinite(Number(zone.efficiency))) {
    return clamp(Number(zone.efficiency) * 100, 18, 100);
  }
  return 48;
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

function formatDuration(seconds) {
  const total = Number(seconds || 0);
  if (!total) return "0m";
  const minutes = Math.round(total / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours}h ${rest}m` : `${hours}h`;
}

function formatPercent(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "Unknown";
  return `${Math.round(number * 100)}%`;
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

function titleCase(value) {
  return String(value || "")
    .replace(/[-_]/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => {
    const entities = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    };
    return entities[character];
  });
}
