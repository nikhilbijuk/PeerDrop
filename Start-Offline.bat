@echo off
title PeerDrop Offline Server

echo Starting PeerDrop Local Server...
echo.

:: Automatically open the browser to the local page
start http://localhost:3000

:: Start the Node server
node server.js

pause
