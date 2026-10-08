# Working agreements

- This is a standalone web administrator in phase 1, not a Homebridge plugin. Keep its own URL, login, Admin/Regular permissions and complete existing desktop/mobile UX. Do not replace it with a minimal settings form.
- The coordinator requires a garage and separate bolt. Reuse its API; do not implement another movement engine in the administrator.
- Keep the current standalone source and installation unchanged during new-repository development. The owner will stop the existing administrator and use this new application at cutover; an adapter for the old installation is not a prerequisite.
- Preserve virtual-keypad authorization and timing, gateway/user/grant identity, explicit alarm enrollment, separate API/physical permissions, schedules, shared uses, keypad lockout, protected identities and durable maintenance recovery.
- Generic deCONZ pages access deCONZ. Controller configuration, state and movement go through the coordinator API. Plugin credentials stay on the backend, never in browser scripts or logs.
- The owner will use only one installed administrator at a time. Do not build parallel-admin orchestration, shared writer ownership or an enforced read-only second installation for phase 1. Preserve ordinary per-application transaction and maintenance behavior.
- Copy source only through an explicit reviewed allowlist from the pinned baseline; preserve provenance and review dependencies. Never copy the original private repository history, household notes, runtime state, PINs, tokens or mappings.
- Only advertise implemented API capabilities. Missing maintenance or command support is an error, not a successful no-op.
- Keep the copied API contract byte-identical to the coordinator's authoritative document and run the cross-repository test when changing it.
- Record source validation, publication, installation and physical acceptance separately. No full UI parity, live integration or migration readiness is established by client tests.
