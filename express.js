'use strict';

const path = require('node:path');
const fs = require('node:fs');
const express = require('express');
const session = require('express-session');
const { checkRestrict } = require('./security/middleware.js');

const DEFAULT_IMPORT_MAP = {
  imports: {
    'switch-framework': '/switch-framework/index.js',
    'switch-framework/router': '/switch-framework/router/index.js',
    'switch-framework/themes': '/switch-framework/themes/index.js'
  }
};

let serverConfig = {
  PORT: 3000,
  staticRoot: null,
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
 * @param {object} [options.session] - express-session config
 */
function config(options = {}) {
  if (options.PORT != null) serverConfig.PORT = Number(options.PORT);
  if (options.staticRoot != null) serverConfig.staticRoot = options.staticRoot;
  if (options.session && typeof options.session === 'object') {
    serverConfig.session = { ...serverConfig.session, ...options.session };
  }
}

function injectImportMap(html, importMap) {
  const map = importMap || DEFAULT_IMPORT_MAP;
  const script = `<script type="importmap">${JSON.stringify(map)}</script>`;
  if (html.includes('<head>')) {
    return html.replace('<head>', `<head>\n  ${script}`);
  }
  if (html.includes('<body>')) {
    return html.replace('<body>', `<body>\n  ${script}`);
  }
  return script + '\n' + html;
}

function serveIndex(req, res, indexPath) {
  const raw = fs.readFileSync(indexPath, 'utf8');
  const html = injectImportMap(raw);
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
  server.get('/switch-framework/router', (req, res) => {
    res.type('application/javascript').sendFile(path.join(packageRoot, 'router', 'index.js'));
  });
  server.get('/switch-framework/themes', (req, res) => {
    res.type('application/javascript').sendFile(path.join(packageRoot, 'themes', 'index.js'));
  });
  server.use('/switch-framework', express.static(packageRoot, { setHeaders: jsMime }));

  const frameworkPrefixes = ['/switch-components', '/router', '/registers', '/state-managers', '/helpers'];
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

/**
 * Factory: returns an object with initServer.
 * @returns {{ initServer: (callback: (server: import('express').Application) => void) => void }}
 */
function createApp() {
  return {
    initServer(callback) {
      const staticRoot = serverConfig.staticRoot || process.cwd();
      const indexPath = path.join(staticRoot, 'index.html');

      const server = express();

      server.use(express.json({ limit: '25mb' }));
      server.use(session(serverConfig.session));

      addSwitchFrameworkRoutes(server);

      callback(server);

      server.use((req, res, next) => {
        if (req.path === '/' || req.path === '/index.html') {
          return serveIndex(req, res, indexPath);
        }
        next();
      });
      const jsMime = (res, filePath) => {
        if (filePath.endsWith('.js') || filePath.endsWith('.mjs')) {
          res.setHeader('Content-Type', 'application/javascript');
        }
      };
      server.use(express.static(staticRoot, { setHeaders: jsMime }));
      server.get('*', (req, res) => {
        if (req.path && req.path.startsWith('/api/')) {
          return res.status(404).json({ error: 'Not found' });
        }
        const ext = path.extname(req.path || '').toLowerCase();
        const staticExts = ['.js', '.mjs', '.css', '.json', '.ico', '.png', '.jpg', '.jpeg', '.gif', '.svg', '.woff', '.woff2', '.ttf'];
        if (staticExts.includes(ext)) {
          return res.status(404).send('Not found');
        }
        serveIndex(req, res, indexPath);
      });

      server.listen(serverConfig.PORT, () => {
        console.log(`Switch Framework app running at http://localhost:${serverConfig.PORT}`);
      });
    }
  };
}

createApp.config = config;
createApp.checkRestrict = checkRestrict;

module.exports = createApp;
