# Homebridge deCONZ alarm PIN

Choose **Use for homebridge** in the user editor to use that user's PIN for the existing Homebridge deCONZ alarm tile. The user must have unrestricted, enabled arm/disarm and API access on every selected alarm. Save access-policy changes before synchronizing the PIN.

## Supported method

New updates use homebridge-deconz's dynamic Configuration API, the same method used by the maintainer's `ui put /accessories/<id> '{"pin":"<PIN>"}'` command. The installed `ui discover` command locates the configured child bridge and gateway; the backend sends the PIN directly to the loopback API, so it is not placed in command-line arguments. The backend checks each alarm's identity, resource mapping and live PIN readback.

There is no routine Homebridge restart, private accessory-file edit, source fingerprint requirement or exact dependency-version requirement for a new update. The installed plugin's package identity and command path are checked. Existing controller maintenance, gateway identity checks, user protections and transaction recovery remain in place. No alarm is armed or disarmed to test a PIN.

References: [Dynamic Configuration](https://github.com/ebaauw/homebridge-deconz/wiki/Dynamic-Configuration), [maintainer's alarm-PIN explanation](https://github.com/ebaauw/homebridge-deconz/issues/246#issuecomment-2734540812), [UI command](https://github.com/ebaauw/homebridge-deconz/blob/v1.3.5/cli/ui.js).

## Persistence and logs

The plugin applies the PIN immediately and saves it on its normal schedule or graceful shutdown. Success here means the running Homebridge PIN and deCONZ update were verified; it does not prove the plugin has already flushed the new PIN to disk. A crash or power loss before that save can restore Homebridge's previous PIN. The owner explicitly accepts this normal upstream behavior. We do not force a restart or edit the saved file to accelerate it.

Homebridge deCONZ may log the old/new PIN and API payloads. Our own logs and credential-free transaction journal do not contain PINs. The confirmation window explains this and offers an unchecked **Clear Homebridge logs after this update** option.

If selected, after the entire PIN transaction succeeds we call the same administrator API used by Homebridge UI's Delete Logs action: `PUT /api/platform-tools/hb-service/log/truncate` with an empty JSON object. It clears the entire current Homebridge log, not just PIN entries. Archived, downloaded or separately collected logs are unaffected. It cannot prevent future logging. A cleanup failure is reported separately and never makes a completed PIN transaction pending. A lost deletion response is not automatically retried.

## Requirements

Run Homebridge on the same Linux host, with homebridge-deconz in its own child bridge and Homebridge UI accepting local HTTP connections. The combined controller plugin must use a separate child bridge. The standalone administrator must run as the same operating-system account as Homebridge, with its own separate private data directory. The existing web-admin administrator session authorizes PIN changes. Homebridge UI administrator credentials are requested only for optional log clearing; the prompt explains this purpose and the password is not saved. Legacy offline recovery still requires Homebridge authorization. HTTPS-only Homebridge UI configurations still require additional certificate-trust support.

## Sequence and recovery

1. Review the user and alarms, optionally select log clearing, then confirm the PIN update and authenticate to Homebridge UI.
2. Verify the child bridge, gateway, alarm mapping, existing API PIN fields and user grants. Pause applicable controller integrations.
3. Save a small private recovery record containing the selected alarm PINs and intended new PIN. Update deCONZ once and verify its outcome.
4. Set each Homebridge alarm PIN through the official API, recording intent before each request. Verify the live value; resolve lost responses by readback without automatically repeating the write.
5. Finish all integration checks and publish the user binding. If selected, attempt log clearing, then discard the temporary Homebridge authentication.

The private `web-homebridge-api-update.json` record is overwritten by the next prepared update; no sequence of full-file backups is created. It remains separate from the credential-free policy snapshots and cannot be replaced while an update is pending. It is not a backup of deCONZ's old PIN and does not provide automatic cross-system rollback.

If interrupted before any gateway PIN write, the saved operation can be cancelled without restarting Homebridge. Otherwise, continue the saved update with fresh authorization. Uncertain gateway writes still need independent evidence; unknown Homebridge writes are checked through live readback. Identity/mapping changes or values that cannot be verified remain held for review. Recovery does not automatically replay an uncertain write.

Already-pending updates created by the old offline method keep their original recovery adapter, reviewed source fingerprints and private snapshot requirements. Only those old leases may need the previously confirmed stop/start sequence. The single legacy full accessory-file backup, if present, is retained; new API updates do not add more such backups.
