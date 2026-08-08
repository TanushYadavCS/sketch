# Automation action runtime trust boundary

Action scripts in the current automation runtime execute through JavaScript's `AsyncFunction` constructor in the
Sketch server process. The runtime gives scripts a deliberately small `ctx` object containing the declared Sketch
capabilities, integration action wrapper, environment, workspace path, logger, and abort signal, but this is an API
boundary rather than a security sandbox.

An in-process script may still be able to reach Node.js globals, built-in modules, filesystem state, or network APIs.
Persisted scripts must therefore be treated as trusted first-party automation code, not as arbitrary untrusted tenant
code. Definition validation, declared-capability checks, input limits, action/capability output limits, workspace file
checks, and execution timeouts reduce accidental misuse and resource exposure; they do not establish isolation.

Moving scripts into a worker or subprocess with an explicit IPC protocol and a separately enforced capability surface is
the correct future security boundary. That is intentionally outside this focused hardening slice because a speculative
sandbox rewrite would be higher risk than the verified validation and resource-bound fixes made here.
