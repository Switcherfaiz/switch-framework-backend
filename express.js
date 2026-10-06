'use strict';

const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const { createRequire } = require('node:module');
const express = require('express');
const session = require('express-session');
const { checkRestrict } = require('./security/middleware.js');
const {
  DEFAULT_IMPORT_MAP,
  buildImportPlan,
  denySensitivePaths,
  addNpmRoutes,
  isDevOverlayEnabled
} = require('./imports.js');

let serverConfig = {
  PORT: 3000,
  staticRoot: null,
  imports: null,
  session: {
    secret: process.env.SESSION_SECRET || 'dev-secret',
    resave: false,
    saveUninitialized: false
  }
};

/**
 * Configure the server. Call before initServer.
 * @param {object} options - Configuration
 * @param {number} [options.PORT] - Server port (default: 3000)
 * @param {string} options.staticRoot - Path to index.html and static files (e.g. __dirname)
 * @param {string[]|object} [options.imports] - Extra browser packages (merged with package.json switchFramework.imports)
 * @param {object} [options.session] - express-session config
 */
function config(options = {}) {
  if (options.PORT != null) serverConfig.PORT = Number(options.PORT);
  if (options.staticRoot != null) serverConfig.staticRoot = options.staticRoot;
  if (options.imports != null) serverConfig.imports = options.imports;
  if (options.session && typeof options.session === 'object') {
    serverConfig.session = { ...serverConfig.session, ...options.session };
  }
  if (typeof options.onHttpServer === 'function') {
    serverConfig.onHttpServer = options.onHttpServer;
  }
}

function injectHeadScripts(html, importMap, staticRoot) {
  const map = importMap || DEFAULT_IMPORT_MAP;
  const overlayOn = isDevOverlayEnabled(staticRoot);
  const scripts = `<script>window.__SWITCH_DEV__=${overlayOn ? 'true' : 'false'};</script>\n  <script type="importmap">${JSON.stringify(map)}</script>`;
  if (html.includes('<head>')) {
    return html.replace('<head>', `<head>\n  ${scripts}`);
  }
  if (html.includes('<body>')) {
    return html.replace('<body>', `<body>\n  ${scripts}`);
  }
  return scripts + '\n' + html;
}

function serveIndex(req, res, indexPath, importMap, staticRoot) {
  const raw = fs.readFileSync(indexPath, 'utf8');
  const html = injectHeadScripts(raw, importMap, staticRoot || path.dirname(indexPath));
  res.type('text/html').send(html);
}

function addSwitchFrameworkRoutes(server) {
  const packageRoot = path.dirname(require.resolve('switch-framework'));

  const jsMime = (res, filePath) => {
    if (filePath.endsWith('.js') || filePath.endsWith('.mjs')) {
      res.setHeader('Content-Type', 'application/javascript');
    }
  };

  server.get('/switch-framework', (req, res) => {
    res.type('application/javascript').sendFile(path.join(packageRoot, 'index.js'));
  });
  server.get('/switch-framework/themes', (req, res) => {
    res.type('application/javascript').sendFile(path.join(packageRoot, 'themes', 'index.js'));
  });
  server.get('/switch-framework/overlay', (req, res) => {
    res.type('application/javascript').sendFile(path.join(packageRoot, 'overlay', 'index.js'));
  });
  server.use('/switch-framework', express.static(packageRoot, { setHeaders: jsMime }));

  const frameworkPrefixes = ['/switch-components', '/router', '/registers', '/state-managers', '/helpers', '/overlay'];
  const frameworkFiles = ['/registerScreens.js', '/staticStateRegistry.js'];
  server.use((req, res, next) => {
    const p = req.path || '';
    const matchPrefix = frameworkPrefixes.some((pre) => p === pre || p.startsWith(pre + '/'));
    const matchFile = frameworkFiles.some((f) => p === f);
    if (matchPrefix || matchFile) {
      return res.redirect(301, '/switch-framework' + p);
    }
    next();
  });
}

function addSwitchIconsRoutes(server, staticRoot) {
  let packageRoot = null;
  try {
    const appRequire = createRequire(path.join(staticRoot || process.cwd(), 'package.json'));
    packageRoot = path.dirname(appRequire.resolve('switch-framework-icons/package.json'));
  } catch {
    try {
      packageRoot = path.dirname(require.resolve('switch-framework-icons/package.json'));
    } catch {
      return;
    }
  }

  server.get('/switch-framework-icons', (req, res) => {
    res.type('application/javascript').sendFile(path.join(packageRoot, 'index.js'));
  });
  server.get('/switch-framework-icons/style.css', (req, res) => {
    res.type('text/css').sendFile(path.join(packageRoot, 'style.css'));
  });
  server.use('/switch-framework-icons', express.static(packageRoot));
}

function addSwitchRouterRoutes(server, staticRoot) {
  let packageRoot = null;
  try {
    const appRequire = createRequire(path.join(staticRoot || process.cwd(), 'package.json'));
    packageRoot = path.dirname(appRequire.resolve('switch-framework-router/package.json'));
  } catch {
    try {
      packageRoot = path.dirname(require.resolve('switch-framework-router/package.json'));
    } catch {
      return;
    }
  }

  const jsMime = (res, filePath) => {
    if (filePath.endsWith('.js') || filePath.endsWith('.mjs')) {
      res.setHeader('Content-Type', 'application/javascript');
    }
  };

  server.get('/switch-framework-router', (req, res) => {
    res.type('application/javascript').sendFile(path.join(packageRoot, 'index.js'));
  });
  server.get('/switch-framework/router', (req, res) => {
    res.type('application/javascript').sendFile(path.join(packageRoot, 'index.js'));
  });
  server.use('/switch-framework-router', express.static(packageRoot, { setHeaders: jsMime }));
}

/**
 * Factory: returns an object with initServer.
 * @returns {{ initServer: (callback: (server: import('express').Application) => void) => void }}
 */
function createApp() {
  return {
    initServer(callback) {
      const staticRoot = serverConfig.staticRoot || process.cwd();
      const indexPath = path.join(staticRoot, 'index.html');
      const plan = buildImportPlan(staticRoot, serverConfig.imports);

      const server = express();
      server.disable('x-powered-by');

      server.use(express.json({ limit: '25mb' }));
      server.use(session(serverConfig.session));
      server.use(denySensitivePaths);

      addSwitchFrameworkRoutes(server);
      addSwitchIconsRoutes(server, staticRoot);
      addSwitchRouterRoutes(server, staticRoot);
      addNpmRoutes(server, plan);

      callback(server);

      server.use((req, res, next) => {
        if (req.path === '/' || req.path === '/index.html') {
          return serveIndex(req, res, indexPath, plan.importMap, staticRoot);
        }
        next();
      });
      const jsMime = (res, filePath) => {
        if (filePath.endsWith('.js') || filePath.endsWith('.mjs')) {
          res.setHeader('Content-Type', 'application/javascript');
        }
      };
      server.use(express.static(staticRoot, { setHeaders: jsMime, dotfiles: 'ignore', index: false }));
      server.get('*', (req, res) => {
        if (req.path && req.path.startsWith('/api/')) {
          return res.status(404).json({ error: 'Not found' });
        }
        const ext = path.extname(req.path || '').toLowerCase();
        const staticExts = ['.js', '.mjs', '.css', '.json', '.ico', '.png', '.jpg', '.jpeg', '.gif', '.svg', '.woff', '.woff2', '.ttf'];
        if (staticExts.includes(ext)) {
          return res.status(404).send('Not found');
        }
        serveIndex(req, res, indexPath, plan.importMap, staticRoot);
      });

      const httpServer = http.createServer(server);
      if (typeof serverConfig.onHttpServer === 'function') {
        serverConfig.onHttpServer(httpServer);
      }
      httpServer.listen(serverConfig.PORT, () => {
        const extras = plan.names.length ? ` · npm ${plan.names.join(', ')}` : '';
        console.log(`Switch Framework app running at http://localhost:${serverConfig.PORT}${extras}`);
      });
    }
  };
}

createApp.config = config;
createApp.checkRestrict = checkRestrict;

module.exports = createApp;
