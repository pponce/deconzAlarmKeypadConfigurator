# Coordinator management API v1

The coordinator owns this contract; the companion administrator keeps a byte-identical copy. Version 1 supports managed operation as well as the earlier observation-only fixture.

## Transport

Bind only to 127.0.0.1 on the configured management port (default 27773). Every request requires `Authorization: Bearer <token>`. Reject browser Origin headers and nonmatching Host headers. Every successful response repeats `apiVersion: 1` and the persistent `instanceId`; clients pin both. Token/UUID live in Homebridge-owned `gdoorandbolt-coordinator/identity.json` (directory 0700, file 0600). Never expose credentials to a browser, URL or log. No redirects or automatic write retries.

POST bodies are JSON, include the pinned `instanceId`, and contain exactly the fields below. Bodies have a two-second receive deadline and a 256 KiB maximum (probe: 1 KiB). Fixed-code errors use 400/401/403/404/409/500; an error or lost acknowledgement never establishes success. Movement acceptance returns 202; completion is obtained from status. Bounded client deadlines cover the entire response.

## Endpoints

| Method and path | Additional request fields | Envelope result |
| --- | --- | --- |
| GET /v1/identity | — | pluginVersion, mode, capabilities |
| GET /v1/controllers | — | controllers |
| GET /v1/controllers/{id} | — | controller |
| GET /v1/controllers/{id}/state | — | status |
| GET /v1/controllers/{id}/routing | — | routing |
| POST /v1/controllers/{id}/probe | — | probe |
| GET /v1/settings | — | settings |
| POST /v1/settings/review | configuration, revision | review |
| POST /v1/settings/cancel | token | review: {cancelled:true} |
| POST /v1/settings/apply | token | settings |
| POST /v1/commissioning/reset | — | result: {reset:true} |
| POST /v1/controllers/{id}/commission | revision, previousControllerStopped, physicalSetupReviewed, recover | status |
| POST /v1/controllers/{id}/disable (optional, 0.4.11+) | revision, bootId | status |
| POST /v1/controllers/{id}/commands | command, requestId, issuedAt, bootId | operation |
| GET /v1/activity | — | events |
| GET /v1/homekit-reporting (optional, 0.4.7+) | — | reporting |
| POST /v1/homekit-reporting/recording (optional, 0.4.8+) | recording (boolean) | recording, recordingRevision |
| POST /v1/homekit-reporting/experiment (optional, 0.4.9+) | traceMode, publicationMode | traceMode, publicationMode, recording, recordingRevision, publicationRevision |
| GET /v1/guard | — | ready |
| GET /v1/maintenance | — | maintenance (null or transaction) |
| POST /v1/maintenance/preflight,pause,verify,resume,complete | transactionId, physicalCheck, gateway | acknowledged |
| POST /v1/maintenance/prepare | gateway, confirmedClosed | result |
| POST /v1/maintenance/confirm | kind (bolt/still), token, confirmed | acknowledged |
| POST /v1/controllers/{id}/keypad-begin | gatewayId, alarmId | receipt: {token} |
| POST /v1/keypad-after | token, outcome, mode, elapsed | result: {note} |

Each comma-separated maintenance action is its own final path component. Capabilities are inventory, routingInventory, diagnostics, settingsWrite, motion, maintenance and keypad. The running platform advertises `mode: managed`; per-controller actuation still requires commissioning. Observation fixtures advertise false operational capabilities. Never infer actuation from a successful identity or probe response.

## State and observations

Inventory contains id, name, doorBackend, boltBackend, exposeBoltLock, feedback and status. Operational status contains controllerId, bootId, commissioned, actuationEnabled, held, inputStates, state and revision. State reports phase, door, bolt, busy and fault, with target, openEstimated, closeEstimated, externalUnlockOverride, unavailable and obstruction when known. An estimate is not physical position. Faulted/stale HomeKit characteristics report communication failure; known obstruction is published. The poller reads commissioned devices; inventory simply returns the latest status.

Routing contains controllerId, builtins (`homekit: primary`, `virtualKeypad: primary`), motorPaths, inputs and runtimeEnabled. It excludes URLs, device identities and key references. Physical source adapters consume only eligible live notifications, never snapshots/startup/reconnect history. Homebridge events have receipt freshness, not provable physical event age.

An explicit probe reads devices but never writes. Its result contains controllerId, checkedAt, door, bolt, limitations, compatible, actuationEnabled:false. Door contains state, feedback, blocked and error; bolt contains state, feedback and error. Direct Tailwind evidence is closed-sensor (closed/not-closed); direct deCONZ evidence is relay (locked/unlocked). Homebridge feedback follows the selected supported service and declared sensor/command meaning. A successful check does not commission anything. Failures replace values with unknown/unavailable and fixed errors.

## Settings, commissioning and commands

Homebridge config supplies the initial profiles. After first start, private profiles.json is authoritative for both configuration UIs; neither UI edits the other's files. Settings is {revision,configuration}. Review returns a random token, normalized configuration, revision and requiresCommissioning IDs, expiring after five minutes. Apply consumes the token and compares revisions; changing hardware or behavior removes commissioning for those garages. In 0.4.11+, a name-only change preserves a currently valid commissioning record and the stable controller/accessory identity. Renaming a disabled garage never enables it; other configuration changes retain the existing re-check policy. Cancel invalidates the review. Credential replacement resets commissioning before storing a private key. Credentials themselves are not in settings.

In 0.4.13+, configuration also includes connections: a reusable catalog of up to 128 objects with id, name, type (deconz/tailwind/homebridge), baseUrl and credentialRef. Tailwind entries additionally carry doorCount (null when unknown, otherwise 1–3). These are saved credential names only, never secret values. Clients must preserve this optional field on read/review/apply; older coordinators may omit it. Existing flat controller profiles remain fully resolved and authoritative for device access. The editor matches uses by backend, normalized address and credential name, and expands a shared edit into every matching profile in the same reviewed transaction. Catalog metadata never overrides device settings at runtime. The validator imports uncatalogued valid endpoint connections deterministically, rejects duplicate catalog endpoints and a selected Tailwind door outside a confirmed count. Existing controller hashes are unchanged by importing/naming the catalog or confirming a valid door count; actual address/credential-reference edits require checks for affected garages. The administrative client must accept/preserve this additive field before editing a 0.4.13+ coordinator.


Commissioning requires explicit confirmation that the previous controller is stopped and the physical setup checked, then fresh read-only hardware/identity/relay checks. `recover:true` also acknowledges the interrupted/faulted journal. Commissioning does not move hardware. Timed closing still requires physical closed confirmation; an estimated closure alone cannot prove it.

Disabling a controller is a durable, non-actuating operation. It requires the current revision and bootId and idle runtime operations, rejects maintenance holds, stops only the selected controller’s listeners/polling, removes its enablement record and invalidates its pending keypad receipts. It does not rebuild other controllers or send a stop, open, close or bolt command. Saved device/settings profiles remain intact. Re-enabling requires commissioning again. The endpoint is optional on older releases; missing support is an error, not a successful disable.

Commands are open, close, lock or unlock. requestId is 16–64 alphanumeric/hyphen characters, issuedAt is epoch milliseconds within 15 seconds, and bootId must match the current runtime. Persist pending intent before executing. Repeated IDs return duplicate:true and never repeat movement; changed payloads conflict. Retain recent requests for at least their validity window and all pending requests. A new boot rejects old boot IDs; interrupted work becomes unknown/held. No waiting command queue, automatic movement retry or route fallback. The combined garage always goes through the shared worker, including an optional bolt Lock tile.

## Keypad and maintenance

Before deCONZ PIN submission, the admin requests a one-use receipt scoped to gateway/alarm/controller. After deCONZ's outcome, it forwards only accepted/rejected/unknown, disarm/arm_away/arm_stay/arm_night and elapsed seconds. The PIN never reaches this API. The two-second receipt captures eligibility and the operation epoch. Accepted disarm additionally reads the configured alarm's fresh disarmed state; rejected closes. Busy, late, changed-epoch and unknown outcomes do not move anything. Both paths use the primary opener.

Maintenance pause is durable and disables every input. The same transaction ID must verify, resume and complete; pause/complete are idempotent for that transaction. Resume does not release the pause: only complete does. A registered Homebridge maintenance participant requires preparation while closed/locked, then bolt-test and unchanged-door confirmations after its service restarts. Read checks never perform those physical tests. Restart preserves maintenance. Missing/unavailable participants cannot acknowledge completion. Generic admin transaction recovery never repeats an uncertain deCONZ write.

## Optional HomeKit reporting diagnostic

`GET /v1/homekit-reporting` is an authenticated, loopback-only, read-only diagnostic; the ordinary API version and capability contract are unchanged. Older/fixture servers may return 404. Unsupported inspection returns 503 `reporting_inspection_unavailable`; other methods return 405. Administrators do not require this endpoint for operation.

`reporting` has schema 1, optional runtime version strings, connectionInspection (available/unavailable), truncated, tiles, clients and events. Tiles contain controllerId, kind, availability and fields with reported/cached scalar values, HAP status, event support, AID/IID and anonymous subscriber labels. Clients contain anonymous process-local labels, paired booleans, subscriptions and queued events limited to coordinator characteristics, request-in-progress state and socket byte counters. Events hold at most 200 recent GET/error/publication summaries; publication rows include the subscribers present when reporting. Inspection limits client/queue output and reports truncation. Null indicates unavailable information.

No hardware read, HAP GET/SET, event subscription, state refresh, or configuration write occurs on this endpoint. No credentials, pairing identities, addresses or unrelated accessory data are exposed. Guarded HAP internal reads are diagnostic only; unavailable fields must not be interpreted as zero subscribers or successful delivery. A paired subscriber/empty queue/byte-count increase does not establish that Apple Home rendered a value.


### Internal recording comparison (0.4.8+)

The optional reporting snapshot adds bootId, recording (default false starting in 0.4.14; true in 0.4.8–0.4.13) and recordingRevision (incremented on a mode change). Trace events add monotonicMs, a process-relative high-resolution timestamp sampled at recording, alongside the existing epoch-millisecond at. These are publication/read observations, not socket-delivery or Apple rendering timestamps. Events remain bounded and existing events remain available when recording is off.

POST /v1/homekit-reporting/recording accepts exactly {instanceId,recording}, with a boolean recording value and the ordinary local authentication/Host/Origin restrictions. Only POST is supported (405 otherwise). Invalid identity/shape is 409, malformed/oversized JSON is 400. A controller with state.busy rejects the change with 409 reporting_controller_busy. Successful responses contain recording and recordingRevision in the ordinary envelope. The check and switch are synchronous after body parsing.

This is a process-local diagnostic switch, not saved configuration. It neither rebuilds accessories nor changes subscriptions, notification order/repeats, hardware state, commissioning or timers. It sends no HAP read/write/notification and replays no buffered events. Restart resets recording to false starting in 0.4.14 (true in 0.4.8–0.4.13). Ordinary reporting inspection remains read-only even when recording is disabled. Unsupported older or fixture servers need not provide the switch; the administrator does not depend on it.

### Reporting experiments (0.4.9+)

POST /v1/homekit-reporting/experiment accepts exactly {instanceId,traceMode,publicationMode}. traceMode is full, events, subscribers or off; publicationMode is inline or deferred. Authentication, Host/Origin restrictions, JSON limits, method and idle-controller checks match the recording endpoint. Invalid values/identity are 409. A stopped publisher or pending deferred report rejects the switch with 409 reporting_publication_pending. All validation precedes mutation. The successful response includes both modes and their revisions; the reporting snapshot includes those fields too. recordingRevision increments when traceMode changes; publicationRevision increments when publicationMode changes. Selecting unchanged modes is idempotent.

full retains all tracing; events records bounded event/timestamp history but omits per-publication subscriber inspection (event subscribers is null); subscribers performs publication subscriber inspection without recording events/timestamps or labelling GET clients; off bypasses both. The backward-compatible recording flag is true for any non-off trace mode, including subscribers, which does not append history. POST recording:true selects full; false selects off; neither changes publicationMode. Existing history is retained. Boundary GET inspection remains available in every mode.

deferred schedules garage publication through setImmediate. It keeps the latest committed complete report, coalesces pending updates and checks report generation, binding, live state, enablement and freshness before sending. Reversal, removal/rebind, shutdown and invalid feedback cannot replay an obsolete success. Error publication and initial accessory seeding remain inline. Bolt publication stays inline. Committed synchronous GETs, HAP methods, terminal target/current order, two-second repeat schedule and all hardware behavior remain unchanged. This is an experimental scheduling change, not a guarantee of a separate HAP batch or a 250 ms delay.

Modes are process-local, apply to all coordinator profiles, and restart as off/inline starting in 0.4.14, at the owner’s request for a startup-OFF comparison; earlier diagnostic releases used full/inline. Changing modes sends no notification, hardware command, HAP subscription or configuration write; it does not reset commissioning or replay history. These endpoints are optional and are not used by the standalone administrator.


### Physical keypad interruption policy (0.4.19)

Existing input `busyBehavior: interrupt` now also permits native physical keypad profiles on a motor path declaring `interruption: stop-opening-reverse-closing`. It remains invalid for `primary` and undeclared relay paths. No new endpoint or JSON field is added. Default/drop behavior is unchanged. In opt-in mode only a correct, disarmed-confirmed outcome opens from closed; rejected outcomes at closed do nothing. Either outcome closes an open/owned-partial door, stops an owned opening operation, or reverses an owned closing operation. An accepted-disarm interruption still requires disarmed confirmation. Ownership, event freshness, closed-sensor checks, single-pulse writes and restart holds remain enforced. Virtual keypad/built-in routes are unchanged.


### Devices and Controls UI (0.4.19)

User-facing Devices groups the primary opener, bolt and additional opener relays. Controls groups input sources and their selected opener. Schema IDs (`door`, `bolt`, `motorPaths`, `inputs`, `motorPath`) stay unchanged. Device movement edits materialize behavior into linked toggle profiles; new/rerouted toggle profiles use the selected device setting. Divergent legacy profiles are preserved until explicitly reconciled under Devices. Keypad `busyBehavior` is a separate opt-in PIN policy, never automatically enabled by configuring device capability. Explicit open/close controls retain drop behavior.
