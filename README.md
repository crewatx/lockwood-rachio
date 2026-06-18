# Rachio Ocean Dashboard

A small DigitalOcean-ready dashboard for a Rachio irrigation system. It runs in demo mode by default, then switches to live data when `RACHIO_API_TOKEN` is configured.

The dashboard also pulls local weather from the National Weather Service using the controller location, so there is no separate weather account or API key to manage.

## Run Locally

```bash
npm start
```

Open `http://localhost:8080`.

## Connect Rachio

Create a Rachio API token from your Rachio account, then set:

```bash
RACHIO_API_TOKEN=your-token
```

The token is only read by `server.js`; it is never sent to the browser.

## Weather And Watering Rules

Weather data comes from Weather.gov / the National Weather Service for current conditions, forecast, hourly precipitation chance, pressure, and wind. The rainfall history chart uses Open-Meteo hourly precipitation totals because current NWS station precipitation observations can under-report smaller totals.

Optional settings:

```bash
WEATHER_USER_AGENT=lockwood-rachio-dashboard (https://github.com/crewatx/lockwood-rachio)
WATERING_DAYS=Mon, Wed, Sat
RESTRICTED_WATERING_HOURS=10:00 AM - 7:00 PM
```

If the weather service is temporarily unavailable, the dashboard keeps loading and clearly marks the weather data as a fallback.

## Protect The Dashboard

Set `DASHBOARD_PASSWORD` before connecting live irrigation controls:

```bash
DASHBOARD_PASSWORD=choose-a-strong-password
```

When this value is set, the dashboard requires a password before any Rachio data or watering controls can be used. Login is stored in an HTTP-only signed cookie. You can optionally set `SESSION_SECRET` to a separate random string for signing cookies.

## DigitalOcean App Platform

1. Push this project to GitHub.
2. Create a new DigitalOcean App from the repo.
3. Set the environment variable `RACHIO_API_TOKEN`.
4. Set `DASHBOARD_PASSWORD` as a secret.
5. Optionally set `WATERING_DAYS` and `RESTRICTED_WATERING_HOURS` to match your local rules.
6. Use:
   - Build command: none
   - Run command: `npm start`
   - HTTP port: `8080`

The included `.do/app.yaml` can be used as a starting point if you prefer app spec deployment.

## API Routes

- `GET /api/bootstrap` loads person, controller, zone, and schedule data.
- `POST /api/zones/:id/start` starts a zone. Body: `{ "duration": 600 }`.
- `POST /api/zones/:id/stop` stops a zone.
- `POST /api/devices/:id/stop` stops all watering on a device when supported by the Rachio API.
