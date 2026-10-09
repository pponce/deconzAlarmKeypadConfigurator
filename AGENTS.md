# Working agreements

- This repository develops standalone deCONZ web administration in Node.js. Preserve the frozen legacy-python branch.
- Reuse reviewed administration behavior and UI from homebridge-gdoor-admin-controller. Record the exact source commit and intentional adaptations. Do not replace current user/mobile/account fixes with older Python assets.
- No built-in garage/bolt controller, Homebridge plugin registration or required Homebridge runtime. Virtual keypad requests go directly to the configured deCONZ alarm API.
- Startup, discovery and configuration verification must never send hardware commands. Ambiguous writes are never automatically replayed.
- Retain identity pinning, account roles, CSRF/origin checks, private storage, durable transaction/recovery holds and duplicate keypad-request protection. Fail if a required extension participant is missing.
- Homebridge PIN maintenance is explicit and optional. New updates use the official homebridge-deconz Configuration API and its ui discovery command, without a routine restart or private accessory-file edits. The owner accepts upstream PIN logging and normal deferred persistence; our own logs must not contain credentials. Optional log deletion uses the authenticated Homebridge UI API only after complete success. Keep the legacy reviewed adapter solely for already-pending offline updates. No installed-source patches, automatic sudo or service takeover.
- Keep all runtime data, account verifiers, API keys, PINs, host paths and household details out of Git and logs. Use synthetic fixtures.
- Record implementation, verification and remaining limitations in docs/status.md. Source publication does not mean live installation or hardware acceptance.
- Run focused relevant tests. CI includes Node 22/24 and desktop/mobile synthetic browser checks; do not claim an unrun check passed.
