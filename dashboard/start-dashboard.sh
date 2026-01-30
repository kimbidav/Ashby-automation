#!/bin/bash

# Start the API server in the background
echo "Starting API server on port 3001..."
node server.js &
API_PID=$!

# Wait a moment for the API server to start
sleep 2

# Start the Vite dev server
echo "Starting dashboard on port 3000..."
npm run dev

# When Vite is stopped, also stop the API server
kill $API_PID
