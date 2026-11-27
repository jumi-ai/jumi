# Review rules

User-supplied file names must stay inside the base directory.

## `download.js`

`filePath` in this file must neutralize `..` segments: a name like `../secret` must never resolve outside the base directory.
