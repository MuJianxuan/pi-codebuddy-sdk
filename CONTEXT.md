# Pi CodeBuddy Bridge

This context describes the pi-codebuddy-sdk extension as a bridge between Pi and the CodeBuddy Agent SDK. It captures the project-specific language we use when reasoning about model capability reporting and tool execution behavior.

## Language

**Registered Context Window**:
The context window value that this extension registers with Pi for a model. Pi uses this value for user-visible capability reporting and context-management behavior.
_Avoid_: advertised window, guessed window, Pi-side window

**Served Context Window**:
The context window value that the CodeBuddy runtime actually serves for a model during execution. This is the runtime truth, even when it differs from what Pi was told at registration time.
_Avoid_: real size, actual guess, backend estimate

**Window Drift**:
A mismatch between the Registered Context Window and the Served Context Window for the same model. Window drift means Pi is making decisions from stale or inaccurate model metadata.
_Avoid_: context bug, memory issue, token loss

**Conservative Registration**:
A registration strategy that never advertises a model context window larger than what the runtime has proven it can serve. Conservative registration prefers under-reporting over over-reporting.
_Avoid_: optimistic registration, doc-sized registration

**Runtime Calibration**:
A correction step that updates model capability metadata after observing real runtime values from the provider. Runtime calibration exists to eliminate Window Drift over time.
_Avoid_: post-hoc guess, lazy estimate

**User-Level Calibration Cache**:
A user-scoped cache that stores runtime-observed model capability values for reuse across Pi sessions on the same machine. This cache belongs to the user environment, not to any single repository.
_Avoid_: project cache, session-only cache, shared repo metadata

**Environment-Scoped Cache Key**:
A cache-keying strategy that stores calibration records by model id plus runtime environment signals that can change the effective served capability. This strategy reduces cross-environment drift without requiring stable account identity APIs.
_Avoid_: model-only key, project-scoped key, session-only key

**Best-Effort Live Refresh**:
A runtime calibration policy that treats the persisted cache as authoritative while attempting to refresh the current Pi provider registration only when it is safe to do so. If the live refresh fails, the next session still benefits from the cached calibration.
_Avoid_: forced immediate re-register, cache-only refresh

**Family-Bounded Conservative Default**:
An initial registration strategy for uncalibrated models that assigns a conservative lower-bound capability based on the model family rather than a single universal default or an optimistic guess. This reduces first-run Window Drift without overstating capability.
_Avoid_: universal tiny default, optimistic heuristic, doc-claimed default
