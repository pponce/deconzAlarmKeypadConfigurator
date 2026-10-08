# Required full-interface parity

The existing accepted interface is the baseline. Extraction must preserve these behaviors; no simplified replacement is acceptable.

- Users, global identities, enabled state, per-alarm grants, enrollment and owner rules.
- Separate API and physical-keypad access, keypad scope, shared use counts, schedules and protection/lockout configuration.
- Application Admin/Regular roles; Regular users cannot create other accounts. Keep controller permissions explicit.
- Existing mobile/desktop navigation, direct page refresh behavior, visual keypad and sequential entry semantics.
- Keypad authorization remains gateway-based; preserve fresh result routing, stale/duplicate rejection and no automatic replay.
- Alarm/keypad settings and gateway setup, local/remote supported deployment distinctions.
- Activity collection when the browser is closed, history controls, discovery versus page refresh and debug controls.
- Existing General settings, configurable icon/shortcut branding and home-screen behavior.
- Automatic backup retention: newest 20 eligible completed automatic snapshots per gateway/type; holds, installation/migration backups and ineligible objects retain their established treatment. A number of snapshots is not a byte cap.
- Controller settings, timing help, status, movement/fault descriptions, maintenance and recovery. Extend for multiple configured door/bolt assemblies and feedback questionnaire.
- Protected credentials, CSRF/Origin checks, version/revision conflicts and interruption recovery.
- Operational full-stack/browser testing before declaring parity; an API client's tests do not establish any of these UI behaviors.

The generic interface and runtime are retained with their original assets and regression checks. The native Controller page now supports status, coordinated commands, commissioning/recovery, revision-checked settings and activity. Keypad outcomes, durable maintenance and isolated installation/state preparation are implemented. The shared profile editor adds feedback questions and source-specific motor routes; device discovery and private keys are managed in Homebridge settings. Browser, cross-repository and owner-host acceptance are recorded separately in [status.md](status.md). Automated checks do not establish physical timing or household wiring.
