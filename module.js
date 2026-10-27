/**
 * Web language module. Each language area is its own sub-module under lib/; this file only wires them up.
 * Saturn calls a single projects.onCreate, so the chosen New Project template picks which one scaffolds it.
 */
import { basename } from 'node:path';
import { GENERATORS } from './lib/generators.js';
import * as javascript from './lib/javascript/index.js';
import * as web from './lib/web/index.js';

const SCAFFOLDS = {
  html: web.createPage,
  bootstrap: web.createPage,
  html5boilerplate: web.createBoilerplate,
  node: javascript.createProject,
  express: javascript.createProject,
};

export function activate(saturn) {
  web.activate(saturn);
  javascript.activate(saturn);
  saturn.projects.onCreate(async ({ projectPath, fields, progress = () => {} }) => {
    const template = String(fields.template ?? 'html');
    const generator = GENERATORS[template];
    if (generator) return generator({ projectPath, name: basename(projectPath), ts: fields.language !== 'javascript', progress });
    await (SCAFFOLDS[template] ?? web.createPage)({ projectPath, fields, progress });
  });
}

export function deactivate() {}
