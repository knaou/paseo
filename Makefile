.PHONY: server web

# Start the development daemon on 127.0.0.1:6768.
server:
	npm run dev:server

# Start Expo on http://localhost:8081 with the matching development daemon.
web:
	npm run dev:app
