'use strict';
const http = require('http');
const handler = require('./handler');
const PORT = process.env.PORT || 7000;
http.createServer(handler).listen(PORT, () => console.log('nezone-source listening on ' + PORT));
