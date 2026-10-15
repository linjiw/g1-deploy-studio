# Telemetry schemas

## Implemented v1 replay contract

`telemetry-v1.schema.json` describes the normalized replay envelope. The Python adapters additionally enforce finite values, quaternion validity, exact source shapes, monotonic clocks, recorded sample alignment, named joint mapping, and input-size bounds. Each session retains artifact fingerprints and source checkout provenance; a current checkout revision is never represented as the historical recording revision.

Positions are metres, joint angles radians, quaternions wxyz, right-handed Z-up world coordinates. Relative replay time and source time are distinct. Legacy recordings lack receipt timestamps and calibration/policy hashes; these remain null. Per-frame sequence is the original recording sample index, not a claimed wire sequence number. Pose packets contain frame indices rather than packet sequence counters; missing packets cannot be counted from them without further evidence.

See `docs/INTERFACES.md` for wire packet contracts and `studio.protocols` for strict decoding. Both paths retain reference, command, measured/estimated and simulation-truth distinctions.
