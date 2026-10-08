# Future extension boundary

The standalone application has no built-in controller. CLI startup supplies no extensions. There is no dynamic module loading, browser configuration of executable code, controller discovery, remote protocol or extension installer in this first port.

A trusted host application can call `startStandalone({ storagePath, extensions })`, where `extensions` contains:

- `participants`: a Map of stable names to API-version-1 maintenance participants. Each supplies `preflight`, `pause`, `verify`, and `resume`; optional `applies`, `guard`, `complete`, and `recovery_ready` hooks follow `WebAdminTransactions`. The name `homebridge` is reserved.
- `keypadBegin({ gateway, identity, alarm, started })`: returns null when no extension applies, or an API-version-1 hook with `after(outcome, mode)` and `failed(outcome)`. It receives no API key or PIN. `started` uses the monotonic performance clock in seconds.

The transaction journal records required participants before a gateway write. If a required participant disappears after restart, recovery remains held. Exceptions from a required keypad begin hook prevent submission; absence by default simply permits the direct deCONZ command.

An extension runs trusted local code with the service account's permissions. These ports are not a security sandbox and do not provide a complete controller lifecycle or movement-safety protocol. Any future controller adapter needs its own identity, authorization, recovery and acceptance review. Do not describe the current seam as a ready-to-install controller add-on.
