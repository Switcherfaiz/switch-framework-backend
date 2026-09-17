'use strict';

const pkg = require('./package.json');
const createApp = require('./express.js');

createApp.VERSION = pkg.version;
module.exports = createApp;
