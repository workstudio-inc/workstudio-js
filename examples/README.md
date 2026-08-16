# Headless SDK demo

A single self-contained page that renders the integration marketplace using only
`@workstudio-inc/sdk` — no framework, no WorkStudio UI code. Use it to test the SDK and the
embed API end to end.

## Run it

The page loads the built SDK as ES modules, so it must be served over HTTP (not `file://`).

```bash
# from sdks/js
npm install
npm run build          # produces dist/ that the demo imports
npx serve .            # or: python -m http.server 8080
```

Then open `http://localhost:3000/examples/` (or whatever port your server prints).

## Use it

1. Enter your **API base URL**, **tenant ID**, an **embed API key** (`svx_ik_…`), and a **scope key**
   (e.g. `customer:test`).
2. Click **Load catalog**.
3. Activate an integration, connect/disconnect connectors (OAuth opens in a popup), and deactivate —
   all driven by the SDK.

> The API key is a server-side secret. This demo takes it as input only for local testing; in a real
> browser embed you would use a short-lived custom JWT (`token`) instead.
