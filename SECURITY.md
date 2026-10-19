# Security Policy

## Reporting Security Vulnerabilities

If you discover a security vulnerability or potential privacy issue in CliHanger, please report it privately rather than opening a public issue.

To report a vulnerability:
1. Go to the repository's **Security** tab on GitHub.
2. Click **Report a vulnerability** to open a private advisory draft.
3. Provide details about the affected component, steps to reproduce, and any proof-of-concept demonstrations.

This is a volunteer-maintained project. I aim to acknowledge reports within a few days.

---

## Security Model and Scope

CliHanger runs entirely locally as an Electron desktop application on macOS. It does not communicate with external analytics or telemetry services.

Security-sensitive boundaries include:

1. **Local Status Hook Receiver (`127.0.0.1:47823`):**
   - Binds strictly to `127.0.0.1` (never `0.0.0.0`).
   - Requires HTTP requests to provide the bearer token stored in `~/.hangar/hook.token` (permissions `0600`).
   - Only updates session status classifications; does not execute arbitrary shell commands.

2. **Process Management and Port Killing:**
   - The Ports panel allows terminating processes listening on local TCP ports.
   - A kill sends `SIGTERM`, then `SIGKILL` if the process is still alive after 2 seconds. Signals are sent with your user's permissions, so other users' and system processes cannot be killed.
   - CliHanger runs with standard user privileges and never prompts for or requires `root`/`sudo`.

3. **IPC Isolation:**
   - The renderer runs with `contextIsolation: true` and `nodeIntegration: false`. The Electron sandbox is off (`sandbox: false`) because the preload script uses `require()`.
   - All IPC channels are strictly routed through `preload.js` and validated against `src/main/ipc-contract.js`.
