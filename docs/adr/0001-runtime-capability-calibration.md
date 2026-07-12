# Runtime capability calibration for registered models

The CodeBuddy bridge now treats model capability metadata as runtime evidence, not documentation guesses. We register uncalibrated models with family-bounded conservative defaults, persist runtime-observed capability floors in a user-level calibration cache keyed by model id plus runtime environment, and best-effort refresh the current provider registration after safe observations so Pi's context-management behavior converges toward served reality without overstating capability.

The transaction and `floor`/`latest`/`max` policy are specified in [ADR 0002](0002-conservative-calibration-floor.md).
