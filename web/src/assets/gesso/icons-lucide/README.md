# Gesso editor icons

The editor imports official SVG components from `lucide-react@1.68.0`, pinned in
`web/package.json` and its lockfile. No icon geometry is redrawn locally.

- Source: https://github.com/lucide-icons/lucide/tree/main/packages/lucide-react
- Package: https://www.npmjs.com/package/lucide-react/v/1.68.0
- License: [ISC](LICENSE.txt), copyright 2026 Lucide Icons and Contributors.
- Role assignments and default dimensions: `web/src/uiIconCatalog.ts`.
- Rendering and explicit size overrides: `web/src/UiIcon.tsx`.

The 24-unit source geometry uses a 1.5 CSS-pixel non-scaling stroke, round caps
and joins, and the control's current text colour. The owning control supplies
its accessible label/state; the SVG itself is hidden from assistive technology.
