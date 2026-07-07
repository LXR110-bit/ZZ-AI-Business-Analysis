#!/bin/bash
cd /private/tmp/v2-frontend-wt/model-tag-monitor
export PROXY_UPSTREAM=""
exec node src/server.js
