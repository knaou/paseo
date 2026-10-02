.PHONY: server web build-push push

PRIVATE_NPM_SCOPE := @knaou
VERSION=0.10.3-knaou.1

# Start the development daemon on 127.0.0.1:6768.
server:
	npm run dev:server

# Start Expo on http://localhost:8081 with the matching development daemon.
web:
	npm run dev:app

# Build and publish the fork's npm packages to private GitHub Packages.
#
# Prerequisites on this build machine:
#   1. Run `npm ci` once for the checked-out source.
#   2. Export NODE_AUTH_TOKEN as a GitHub classic PAT with `write:packages`.
#   3. After the first publish, confirm each GitHub Package remains Private.
#
# Publish a new immutable version:
#   make build-push VERSION=0.10.3-knaou.1
#   Private prereleases are published under the `knaou` dist-tag.
#
# Consumer setup, once per machine:
#   npm login --scope=@knaou --auth-type=legacy --registry=https://npm.pkg.github.com
#
# Consumer install and start:
#   npm install -g '@getpaseo/cli@npm:@knaou/paseo-cli@0.10.3-knaou.1'
#   npm install -g @openai/codex opencode-ai # Install only the agent CLIs you use.
#   paseo daemon config set features.webUi.enabled true
#   paseo daemon start
#
# Update manually with a newly published version:
#   paseo daemon stop
#   npm install -g '@getpaseo/cli@npm:@knaou/paseo-cli@0.10.3-knaou.2'
#   paseo daemon start
#
# Do not use `npm run release:*` or push a v* tag for this path. Those run the
# upstream public release flow and can trigger desktop/mobile release jobs.
build-push:
	node scripts/publish-private-npm.mjs --scope "$(PRIVATE_NPM_SCOPE)" --version "$(VERSION)"

# Alias matching the consumer-facing publish command.
push: build-push
