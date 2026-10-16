# Security reference

Load this file only when the diff touches external effects, auth, config, parsers, or dependencies. Do not load it on every review.

- Name the trust boundary: whose input reaches which sink.
- A parser or config change needs a malformed-input case with an independent expected rejection, plus a positive control that valid input still passes.
- An auth or secret change must not log, persist, or echo the credential. Grep keys, not values.
- A dependency or version change needs the behavior that changed, not only the version number.
