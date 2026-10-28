# rodaddy.crew

Crew portraits inside Paperclip: an agent detail tab "Crew card" and a
dashboard widget "The Crew". Portraits are bundled with the plugin, not
fetched from Forge: `avatars/<crew.json key>.png` (192x192), which the worker
serves as `data:image/png;base64,...` URIs, read once per process. A member
with no thumbnail gets `avatar: null`, and the UI draws an initials circle
instead of a broken image.

Make a thumbnail from the full portrait in `fleet/board/avatars/` (one per
crew.json entry; run from this directory):

    sips -z 192 192 ../../board/avatars/<name>.png --out avatars/<key>.png

Regenerate the baked roster after `fleet/board/crew.json` changes:

    { echo "// GENERATED from fleet/board/crew.json; regenerate with the command in README.md."; echo -n "export const CREW = "; cat ../../board/crew.json; echo ";"; } > roster.data.js

The UI is a plain ESM module at `ui/index.js` (no build step); it imports
`react` and `@paperclipai/plugin-sdk/ui`, which the host provides. Plugin config
`crew` (crew.json shape, object or JSON string) overrides the baked roster.
