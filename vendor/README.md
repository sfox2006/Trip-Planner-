# Bundled PDF renderer

`pdf.mjs` and `pdf.worker.mjs` are the unmodified browser-ready files from `pdfjs-dist` **6.4.299**, published by Mozilla's PDF.js project. The package is pinned in `package.json` and `package-lock.json`; `pdfjs-LICENSE.txt` is its Apache-2.0 license.

The planner passes device-local PDF bytes to the local worker and renders the first page into a canvas. It does not build interactive annotation/link layers or execute PDF actions. No documents are uploaded. The app disables evaluation and embedded-font loading. A failed preview leaves the original available for download.

To update after checking the upstream package and testing the app, install the chosen exact `pdfjs-dist` version, copy `node_modules/pdfjs-dist/build/pdf.mjs`, `build/pdf.worker.mjs` and `LICENSE` into this directory, update this version note, and run all repository checks. No runtime npm installation or build is needed to serve the committed website.
