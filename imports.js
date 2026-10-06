'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { createRequire } = require('node:module');

const ALLOWED_EXT = new Set(['.js', '.mjs', '.css', '.json', '.svg', '.woff', '.woff2', '.ttf', '.eot']);
const MAX_DEP_DEPTH = 3;
const FRAMEWORK_NAMES = new Set([
  'switch-framework',
  'switch-framework/router',
  'switch-framework/themes',
  'switch-framework/overlay',
  'switch-framework-icons',
  'switch-framework-icons/style.css',
  'switch-framework-router'
]);

const DEFAULT_IMPORT_MAP = {
  imports: {
    'switch-framework': '/switch-framework/index.js',
    'switch-framework/router': '/switch-framework-router/index.js',
    'switch-framework/themes': '/switch-framework/themes/index.js',
    'switch-framework/overlay': '/switch-framework/overlay/index.js',
    'switch-framework/': '/switch-framework/',
    'switch-framework-icons': '/switch-framework-icons/index.js',
    'switch-framework-icons/style.css': '/switch-framework-icons/style.css',
    'switch-framework-icons/': '/switch-framework-icons/',
    'switch-framework-router': '/switch-framework-router/index.js',
    'switch-framework-router/': '/switch-framework-router/'
  }
};

function appRequire(staticRoot) {
  return createRequire(path.join(staticRoot, 'package.json'));
}

function normalizeUrlPath(urlPath) {
  try {
    return decodeURIComponent(String(urlPath || '')).replace(/\\/g, '/');
  } catch {
    return String(urlPath || '').replace(/\\/g, '/');
  }
}

function isSensitivePath(urlPath) {
  const p = normalizeUrlPath(urlPath);
  return (
    p === '/node_modules' || p.startsWith('/node_modules/') ||
    p === '/backend' || p.startsWith('/backend/') ||
    p === '/packages' || p.startsWith('/packages/') ||
    p === '/.git' || p.startsWith('/.git/') ||
    /(^|\/)\.env(\.|$)/.test(p) ||
    /(^|\/)\./.test(p)
  );
}

function denySensitivePaths(req, res, next) {
  if (isSensitivePath(req.path)) {
    return res.status(404).send('Not found');
  }
  next();
}

function readAppPackage(staticRoot) {
  const pkgPath = path.join(staticRoot, 'package.json');
  try {
    return JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  } catch {
    return {};
  }
}

function isDevOverlayEnabled(staticRoot) {
  const pkg = readAppPackage(staticRoot);
  const flag = pkg.switchFramework && pkg.switchFramework.devOverlay;
  return flag !== false;
}

function listedImportNames(value) {
  if (Array.isArray(value)) {
    return value.filter((name) => typeof name === 'string' && name.trim()).map((name) => name.trim());
  }
  if (value && typeof value === 'object') {
    return Object.keys(value).filter((name) => {
      const entry = value[name];
      return entry === true || typeof entry === 'string';
    });
  }
  return [];
}

function readListedImports(staticRoot, configImports) {
  const appPkg = readAppPackage(staticRoot);
  const fromPkg = listedImportNames(appPkg.switchFramework && appPkg.switchFramework.imports);
  const fromConfig = listedImportNames(configImports);
  return [...new Set([...fromPkg, ...fromConfig])].filter((name) => !FRAMEWORK_NAMES.has(name));
}

function findPackageJson(fromFile) {
  let dir = path.dirname(fromFile);
  while (true) {
    const candidate = path.join(dir, 'package.json');
    if (fs.existsSync(candidate)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(candidate, 'utf8'));
        if (pkg && pkg.name) return candidate;
      } catch (_) {}
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function resolveExportsDot(exportsField) {
  if (!exportsField) return null;
  if (typeof exportsField === 'string') return exportsField;
  const entry = exportsField['.'] || exportsField;
  if (typeof entry === 'string') return entry;
  if (!entry || typeof entry !== 'object') return null;
  const chosen = entry.browser || entry.import || entry.module || entry.default;
  return typeof chosen === 'string' ? chosen : null;
}

function isCjsOnly(pkg, chosen) {
  if (String(chosen || '').endsWith('.cjs')) return true;
  if (pkg.type === 'module') return false;
  if (pkg.module || pkg.exports || typeof pkg.browser === 'string') return false;
  return true;
}

function pickBrowserEntry(pkg, root) {
  const chosen =
    resolveExportsDot(pkg.exports) ||
    (typeof pkg.browser === 'string' ? pkg.browser : null) ||
    pkg.module ||
    pkg.main;

  if (!chosen) {
    throw new Error(`[switch-framework] "${pkg.name}" has no browser ESM entry (exports / browser / module / main).`);
  }
  if (isCjsOnly(pkg, chosen)) {
    throw new Error(`[switch-framework] "${pkg.name}" is CommonJS-only (${chosen}). Phase 1 serves ESM only.`);
  }

  const abs = path.join(root, chosen);
  if (!fs.existsSync(abs)) {
    throw new Error(`[switch-framework] "${pkg.name}" entry "${chosen}" does not exist.`);
  }
  return fs.realpathSync(abs);
}

function resolvePackage(name, staticRoot) {
  const req = appRequire(staticRoot);
  let pkgJsonPath;
  try {
    pkgJsonPath = req.resolve(`${name}/package.json`);
  } catch {
    try {
      pkgJsonPath = findPackageJson(req.resolve(name));
    } catch {
      throw new Error(`[switch-framework] listed import "${name}" is not installed. Run npm i ${name}.`);
    }
  }
  if (!pkgJsonPath) {
    throw new Error(`[switch-framework] listed import "${name}" has no package.json.`);
  }

  const root = fs.realpathSync(path.dirname(pkgJsonPath));
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const entry = pickBrowserEntry(pkg, root);
  if (!insideRoot(entry, root)) {
    throw new Error(`[switch-framework] "${name}" entry escapes its package root.`);
  }
  return { name, root, entry, pkg };
}

function insideRoot(file, root) {
  const rel = path.relative(root, file);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function walkAllowlist(name, staticRoot, allowlist, depth, seen) {
  if (FRAMEWORK_NAMES.has(name) || seen.has(name)) return;
  seen.add(name);
  const resolved = resolvePackage(name, staticRoot);
  allowlist.set(name, resolved);
  if (depth <= 0) return;
  const deps = Object.keys((resolved.pkg && resolved.pkg.dependencies) || {});
  for (const dep of deps) {
    if (FRAMEWORK_NAMES.has(dep) || dep === 'switch-framework-backend') continue;
    walkAllowlist(dep, staticRoot, allowlist, depth - 1, seen);
  }
}

function buildImportPlan(staticRoot, configImports) {
  const names = readListedImports(staticRoot, configImports);
  const allowlist = new Map();
  const seen = new Set();
  for (const name of names) {
    walkAllowlist(name, staticRoot, allowlist, MAX_DEP_DEPTH, seen);
  }

  const imports = { ...DEFAULT_IMPORT_MAP.imports };
  for (const [name, pkg] of allowlist) {
    const relEntry = path.relative(pkg.root, pkg.entry).replace(/\\/g, '/');
    imports[name] = `/npm/${name}/${relEntry}`;
    imports[`${name}/`] = `/npm/${name}/`;
  }

  return {
    names,
    allowlist,
    importMap: { imports }
  };
}

function parseNpmPath(urlPath) {
  let rest = normalizeUrlPath(urlPath);
  if (rest.startsWith('/npm/')) rest = rest.slice(5);
  else if (rest.startsWith('/')) rest = rest.slice(1);
  if (!rest || rest.includes('\0')) return null;

  const parts = rest.split('/').filter(Boolean);
  if (parts.includes('..') || parts.includes('.') || parts.some((part) => part === '')) return null;

  if (rest.startsWith('@')) {
    if (parts.length < 2) return null;
    return { name: `${parts[0]}/${parts[1]}`, file: parts.slice(2).join('/') };
  }
  return { name: parts[0], file: parts.slice(1).join('/') };
}

function sendNotFound(res) {
  return res.status(404).send('Not found');
}

function contentTypeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.js' || ext === '.mjs') return 'application/javascript';
  if (ext === '.css') return 'text/css';
  if (ext === '.json') return 'application/json';
  if (ext === '.svg') return 'image/svg+xml';
  if (ext === '.woff2') return 'font/woff2';
  return null;
}

function serveNpm(allowlist) {
  return function npmGate(req, res) {
    const spec = parseNpmPath(req.path);
    if (!spec) return sendNotFound(res);

    const pkg = allowlist.get(spec.name);
    if (!pkg) return sendNotFound(res);

    const target = spec.file ? path.join(pkg.root, spec.file) : pkg.entry;
    let real;
    try {
      real = fs.realpathSync(target);
    } catch {
      return sendNotFound(res);
    }
    if (!insideRoot(real, pkg.root)) return sendNotFound(res);

    const ext = path.extname(real).toLowerCase();
    if (!ALLOWED_EXT.has(ext)) return sendNotFound(res);

    const type = contentTypeFor(real);
    if (type) res.setHeader('Content-Type', type);
    res.sendFile(real);
  };
}

function addNpmRoutes(server, plan) {
  server.get('/__switch/imports.json', (req, res) => {
    res.json({
      imports: plan.importMap.imports,
      packages: [...plan.allowlist.keys()]
    });
  });
  server.use('/npm', serveNpm(plan.allowlist));
}

module.exports = {
  DEFAULT_IMPORT_MAP,
  ALLOWED_EXT,
  buildImportPlan,
  readListedImports,
  parseNpmPath,
  isSensitivePath,
  denySensitivePaths,
  serveNpm,
  addNpmRoutes,
  resolvePackage,
  isDevOverlayEnabled
};
