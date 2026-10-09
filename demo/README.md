# Interactive demo

[Open the hosted demo](https://pponce.github.io/deconzAlarmKeypadConfigurator/).

A browser-only copy of the current standalone administration interface, with fictional Home, Office and Cabin gateways. Explore users, access grants, schedules, lockout protection, alarm timing and the virtual keypad. The optional Homebridge user/PIN choice is simulated.

No installation, account, deCONZ gateway or Homebridge is needed. Try **2323** on the virtual keypad. User and policy edits stay in this browser; **Reset demo** restores the sample data. PIN values are never persisted. Use fictional information throughout.

The demo has no server API transport. Its content security policy blocks network connections and embedded frames. Installation settings, web-account administration, service restarts, hardware commands and real activity history are not demonstrated. Simulated results do not verify real-world behavior.

## Run locally

Serve this folder with any static web server, for example from the repository root:

```sh
python3 -m http.server 8080 --directory demo
```

Open `http://localhost:8080`. Python is only one way to serve these static files; it is not a demo runtime dependency. Opening `index.html` directly as a file can fail browser security checks, so use HTTP.

## Publish with GitHub Pages

This repository is public and uses **GitHub Actions** for Pages. Push changes to `demo/` on `main` to run the checks and publish, or manually run **Demo and GitHub Pages** from Actions.

For a fork or a fresh repository, complete this one-time setup:

1. Make the repository public when ready.
2. In **Settings → Pages → Build and deployment**, select **GitHub Actions** as the source.
3. In **Actions → Demo and GitHub Pages**, choose **Run workflow** on `main`.

The workflow verifies the generated files, exercises Chromium desktop and WebKit mobile, and uploads **only `demo/`**. Deployment waits while the repository is private or Pages is not configured. Subsequent relevant pushes to `main` publish automatically. The hosted URL is `https://pponce.github.io/deconzAlarmKeypadConfigurator/`.

No repository secrets, personal access token or application credentials are needed. The deployment job uses the workflow's scoped GitHub token and identity permission.

## Keep the demo current

The UI is generated from `web-admin/public/` by `scripts/build-demo.mjs`. The generator removes live transports and installation controls, fixes demo mode on, uses separate browser-storage keys and converts asset paths for a GitHub project site. It fails if adaptation boundaries change or a network transport appears.

After changing the application UI or generator, run:

```sh
node scripts/build-demo.mjs
node scripts/build-demo.mjs --check
```

Commit the regenerated `demo/` files with the source changes. Edit the source or generator rather than the generated HTML, JavaScript or styles. `scripts/demo-browser.mjs` is the browser check used by the Pages workflow; it needs Playwright and its Chromium/WebKit browsers.
