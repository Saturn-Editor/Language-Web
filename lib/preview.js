/**
 * Preview for .html files. The preview frame runs no scripts and can't load project files, so local
 * stylesheets are inlined as <style> and local images as data: URLs. Remote URLs are left as they are.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, isAbsolute, join, resolve } from 'node:path';

const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

const MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const isRemote = (url) => /^([a-z][\w+.-]*:|\/\/|#)/i.test(url);

/** A local file referenced from `baseDir` (root-relative paths resolve against the project), or null. */
function localFile(url, baseDir, projectPath) {
  if (!url || isRemote(url)) return null;
  const clean = decodeURIComponent(url.split(/[?#]/)[0]);
  const path = clean.startsWith('/') ? join(projectPath, clean) : resolve(baseDir, clean);
  return existsSync(path) && statSync(path).isFile() ? path : null;
}

const attr = (tag, name) => new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag)?.slice(1).find((v) => v !== undefined);

function dataUrl(path) {
  const mime = MIME[extname(path).toLowerCase()];
  if (!mime || statSync(path).size > MAX_IMAGE_BYTES) return null;
  return `data:${mime};base64,${readFileSync(path).toString('base64')}`;
}

/** Inlines a stylesheet, resolving its own url(...) images and @import-ed local sheets. */
function inlineCss(css, baseDir, projectPath, seen = new Set()) {
  return css
    .replace(/@import\s+(?:url\()?\s*["']?([^"')\s]+)["']?\s*\)?[^;]*;/gi, (whole, url) => {
      const path = localFile(url, baseDir, projectPath);
      if (!path || seen.has(path)) return whole;
      seen.add(path);
      return inlineCss(readFileSync(path, 'utf8'), dirname(path), projectPath, seen);
    })
    .replace(/url\(\s*(["']?)([^"')]+)\1\s*\)/gi, (whole, _q, url) => {
      const path = localFile(url, baseDir, projectPath);
      const data = path && dataUrl(path);
      return data ? `url("${data}")` : whole;
    });
}

export function renderHtml(text, ctx) {
  const path = isAbsolute(ctx.path) ? ctx.path : join(ctx.projectPath, ctx.path);
  const baseDir = dirname(path);
  return text
    .replace(/<link\b[^>]*>/gi, (tag) => {
      if (!/\brel\s*=\s*["']?stylesheet/i.test(tag)) return tag;
      const file = localFile(attr(tag, 'href'), baseDir, ctx.projectPath);
      if (!file) return tag;
      const media = attr(tag, 'media');
      return `<style${media ? ` media="${media}"` : ''}>${inlineCss(readFileSync(file, 'utf8'), dirname(file), ctx.projectPath)}</style>`;
    })
    .replace(/<style\b([^>]*)>([\s\S]*?)<\/style>/gi, (_whole, attrs, css) => `<style${attrs}>${inlineCss(css, baseDir, ctx.projectPath)}</style>`)
    .replace(/<(img|source)\b[^>]*>/gi, (tag) => {
      const src = attr(tag, 'src');
      const file = localFile(src, baseDir, ctx.projectPath);
      const data = file && dataUrl(file);
      return data ? tag.replace(src, data) : tag;
    });
}
