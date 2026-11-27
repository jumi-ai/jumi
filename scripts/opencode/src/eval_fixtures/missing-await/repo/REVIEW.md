# Review rules

Async work must reach the caller.

## `notify.js`

`notifyAll` in this file must await or return every `send` promise so a `send` failure reaches the caller. `forEach` with an async callback does not wait.
