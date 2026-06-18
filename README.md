# Rachio Ocean Dashboard

A small DigitalOcean-ready dashboard for a Rachio irrigation system. It runs in demo mode by default, then switches to live data when `RACHIO_API_TOKEN` is configured.

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

## DigitalOcean App Platform

1. Push this project to GitHub.
2. Create a new DigitalOcean App from the repo.
3. Set the environment variable `RACHIO_API_TOKEN`.
4. Use:
   - Build command: none
   - Run command: `npm start`
   - HTTP port: `8080`

The included `.do/app.yaml` can be used as a starting point if you prefer app spec deployment.

## API Routes

- `GET /api/bootstrap` loads person, controller, zone, and schedule data.
- `POST /api/zones/:id/start` starts a zone. Body: `{ "duration": 600 }`.
- `POST /api/zones/:id/stop` stops a zone.
- `POST /api/devices/:id/stop` stops all watering on a device when supported by the Rachio API.
