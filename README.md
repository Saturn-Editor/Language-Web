# HTML & CSS for Saturn

Saturn language module for HTML and CSS.

- **Highlighting**: TextMate grammars from VS Code (MIT). HTML embeds CSS in `<style>`, and embeds JavaScript in `<script>` when a module provides `source.js`.
- **Language servers**: `vscode-html-language-server` and `vscode-css-language-server` from [vscode-langservers-extracted](https://www.npmjs.com/package/vscode-langservers-extracted). They're installed with npm into module storage on first use. `server/launch.js` joins them into the one server Saturn allows per module and routes `.css` documents to the CSS server.
- **Preview**: renders `.html` files with local stylesheets and images inlined. Scripts don't run.
- **Templates**: HTML page and CSS stylesheet, plus a new-project scaffold (`index.html`, `style.css`).

Requires npm (comes with Node.js). Install it in Saturn via Marketplace → Languages → Install from folder.
