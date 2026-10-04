'use strict';

const pkg = require('./package.json');
const createApp = require('./express.js');
const imports = require('./imports.js');

createApp.VERSION = pkg.version;
createApp.buildImportPlan = imports.buildImportPlan;
createApp.parseNpmPath = imports.parseNpmPath;
createApp.isSensitivePath = imports.isSensitivePath;
module.exports = createApp;
