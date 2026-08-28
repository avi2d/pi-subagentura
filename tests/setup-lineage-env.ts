import { clearLiveLineageEnvironment } from "./lineage-env";
import { scrubHostHerdrEnvironment } from "./herdr-env";

// Test workers must never inherit authority over the Pi process that launched
// them. Tests needing lineage opt in with an explicit synthetic SpawnTreeContext.
// Do not restore these values: each Vitest worker is a disposable quarantine.
clearLiveLineageEnvironment();
// Same quarantine for the host multiplexer's identity: HERDR_ENV flips
// getMux auto-resolution under every suite that stubs a different backend,
// and HERDR_PANE_ID is authority over the developer's actual pane. The
// real-binary suite opts back in via restoreHostHerdrEnvironment().
scrubHostHerdrEnvironment();
