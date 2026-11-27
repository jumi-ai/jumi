# Review rules

Money must use integer cents.

## `pricing.js`

`cartTotal` in this file must not accumulate floats: `0.1 + 0.2` is `0.30000000000000004`, not `0.3`. Convert each price to cents first.
